"""Clip serving API.

Clips are stored at data/clips/<room_id>/<basename>.mp4 (base HLS recording)
plus a sidecar <basename>.json describing VAP overlays with absolute
trigger timestamps. Endpoints:

  GET /api/rooms/{rid}/clips                 — list (for the room's UI)
  GET /api/rooms/{rid}/clips/match           — find clip for an event
                                                 (user_name, ts query params)
  GET /api/rooms/{rid}/clips/{name}          — raw download (base mp4 or sidecar)
  GET /api/rooms/{rid}/clips/{name}/compose  — lazy composite + download

Composite is materialized on first request via ffmpeg filter_complex (serial
via recorder.FFMPEG_LOCK), cached on disk as <basename>_composited.mp4.
"""

import asyncio
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import aiohttp
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse

from ..auth import require_room_access
from ..config import HEADERS, log
from ..recorder import CLIP_ROOT, FFMPEG_LOCK


router = APIRouter()


def _room_dir(room_id: int) -> Path:
    return CLIP_ROOT / str(room_id)


def _parse_iso(ts: str) -> Optional[float]:
    """Parse an ISO / 'YYYY-MM-DD HH:MM:SS' (UTC) string to epoch seconds."""
    if not ts:
        return None
    try:
        if "T" in ts:
            ts = ts.rstrip("Z")
            return datetime.fromisoformat(ts).replace(tzinfo=timezone.utc).timestamp()
        return datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    except Exception:
        return None


def _load_sidecar(path: Path) -> Optional[dict]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


@router.get("/api/rooms/{room_id}/clips")
async def list_clips(room_id: int, _=Depends(require_room_access)):
    d = _room_dir(room_id)
    if not d.exists():
        return []
    out = []
    for p in sorted(d.iterdir(), reverse=True):
        if p.suffix != ".json":
            continue
        meta = _load_sidecar(p)
        if not meta:
            continue
        base_name = p.stem
        out.append({
            "name": base_name,
            "mp4": meta.get("base_mp4"),
            "duration_sec": meta.get("duration_sec", 0),
            "clip_start_ts": meta.get("clip_start_ts", ""),
            "overlays": meta.get("overlays", []),
            "composited_ready": (d / f"{base_name}_composited.mp4").exists(),
        })
    return out


@router.get("/api/rooms/{room_id}/clips/match")
async def match_clip(
    room_id: int,
    user_name: str = Query(...),
    ts: str = Query(..., description="Event UTC ts: 'YYYY-MM-DD HH:MM:SS'"),
    window_sec: float = 60.0,
    _=Depends(require_room_access),
):
    """Find the clip whose triggers include this event."""
    d = _room_dir(room_id)
    if not d.exists():
        raise HTTPException(404, "no clips")
    event_ts = _parse_iso(ts)
    if event_ts is None:
        raise HTTPException(400, "bad ts")

    best = None
    best_delta = window_sec + 1
    for p in d.iterdir():
        if p.suffix != ".json":
            continue
        meta = _load_sidecar(p)
        if not meta:
            continue
        for ov in meta.get("overlays", []):
            t_iso = ov.get("trigger_ts") or ""
            t = _parse_iso(t_iso)
            if t is None:
                continue
            dt = abs(t - event_ts)
            if dt <= window_sec and dt < best_delta:
                # also require label to match user_name loosely (sanitized)
                lbl = ov.get("label", "")
                safe_u = "".join(c for c in user_name if c.isalnum() or c in "-_")[:32]
                if lbl and safe_u and lbl == safe_u[: len(lbl)]:
                    best = {"name": p.stem, "meta": meta, "overlay": ov, "delta_sec": round(dt, 3)}
                    best_delta = dt
    if not best:
        raise HTTPException(404, "no match")
    return best


@router.get("/api/rooms/{room_id}/clips/{name}.{ext}")
async def get_clip_file(room_id: int, name: str, ext: str, _=Depends(require_room_access)):
    if ext not in ("mp4", "json"):
        raise HTTPException(400, "bad ext")
    # Guard against traversal via name
    if not re.fullmatch(r"[A-Za-z0-9_\u4e00-\u9fff-]+", name):
        raise HTTPException(400, "bad name")
    p = _room_dir(room_id) / f"{name}.{ext}"
    if not p.exists():
        raise HTTPException(404, "not found")
    media_type = "video/mp4" if ext == "mp4" else "application/json"
    return FileResponse(p, media_type=media_type, filename=p.name)


@router.get("/api/rooms/{room_id}/clips/{name}/compose")
async def compose_and_serve(room_id: int, name: str, _=Depends(require_room_access)):
    """Composite VAP overlays onto the base mp4 and stream it. Cached on
    first request as <name>_composited.mp4."""
    if not re.fullmatch(r"[A-Za-z0-9_\u4e00-\u9fff-]+", name):
        raise HTTPException(400, "bad name")
    d = _room_dir(room_id)
    base_mp4 = d / f"{name}.mp4"
    sidecar = d / f"{name}.json"
    out_mp4 = d / f"{name}_composited.mp4"

    if not base_mp4.exists() or not sidecar.exists():
        raise HTTPException(404, "not found")

    if not out_mp4.exists():
        meta = _load_sidecar(sidecar)
        if not meta:
            raise HTTPException(500, "sidecar parse error")
        overlays = [o for o in (meta.get("overlays") or []) if o.get("vap_mp4") and o.get("vap_json")]
        if not overlays:
            # Nothing to composite — serve base as-is.
            return FileResponse(base_mp4, media_type="video/mp4", filename=base_mp4.name)

        ok = await _do_composite(base_mp4, overlays, out_mp4)
        if not ok:
            raise HTTPException(500, "composite failed (server memory tight?)")
    return FileResponse(out_mp4, media_type="video/mp4", filename=out_mp4.name)


async def _do_composite(base_mp4: Path, overlays: list, out_mp4: Path) -> bool:
    """Download each VAP mp4 + json once to /tmp, then run one ffmpeg pass."""
    tmp_dir = Path("/tmp/vap_dl")
    tmp_dir.mkdir(parents=True, exist_ok=True)

    # Download VAPs + read alpha/rgb coords from each sidecar json.
    prepared = []
    async with aiohttp.ClientSession(headers=HEADERS, timeout=aiohttp.ClientTimeout(total=30)) as s:
        for i, ov in enumerate(overlays):
            mp4_url = ov["vap_mp4"]
            json_url = ov["vap_json"]
            mp4_local = tmp_dir / f"{abs(hash(mp4_url))}.mp4"
            json_local = tmp_dir / f"{abs(hash(json_url))}.json"
            try:
                if not mp4_local.exists():
                    async with s.get(mp4_url) as r:
                        mp4_local.write_bytes(await r.read())
                if not json_local.exists():
                    async with s.get(json_url) as r:
                        json_local.write_bytes(await r.read())
                info = (json.loads(json_local.read_text()).get("info") or {})
            except Exception as e:
                log.warning(f"[clip] vap fetch failed: {e}")
                continue
            prepared.append({
                "mp4": str(mp4_local),
                "offset": float(ov.get("offset_sec") or 0),
                "fps": info.get("fps", 30),
                "frames": info.get("f", 0),
                "rgb": info.get("rgbFrame") or [0, 0, 0, 0],
                "alpha": info.get("aFrame") or [0, 0, 0, 0],
                "out_w": info.get("w") or 0,
                "out_h": info.get("h") or 0,
            })

    if not prepared:
        return False

    # Build the filter graph. Base is downscaled to 720 tall up front (saves
    # memory in overlay stage + output bitrate). Each VAP is crop→alphamerge,
    # scaled to full base width, overlaid at y=200 per user spec.
    parts = ["[0:v]scale=-2:720[base0]"]
    last = "base0"
    for i, v in enumerate(prepared):
        idx = i + 1  # ffmpeg input index
        rx, ry, rw, rh = v["rgb"]
        ax, ay, aw, ah = v["alpha"]
        shift = f"setpts=PTS-STARTPTS+{v['offset']:.3f}/TB"
        dur = (v["frames"] / v["fps"]) if v["frames"] else 12.0
        t0 = v["offset"]
        t1 = v["offset"] + dur + 0.1
        parts.append(f"[{idx}:v]crop={rw}:{rh}:{rx}:{ry},{shift}[rgb{i}]")
        parts.append(f"[{idx}:v]crop={aw}:{ah}:{ax}:{ay},scale={v['out_w']}:{v['out_h']},format=gray,{shift}[al{i}]")
        # Scale VAP to base width (matches 720-tall base's width 405).
        parts.append(f"[rgb{i}][al{i}]alphamerge,scale=405:-2[vap{i}]")
        parts.append(f"[{last}][vap{i}]overlay=0:75:enable='between(t\\,{t0:.3f}\\,{t1:.3f})'[v{i}]")
        last = f"v{i}"
    filter_str = ";".join(parts)

    # `-err_detect ignore_err -fflags +discardcorrupt`: the base mp4 is remuxed
    # (copy) from raw HLS segments and can have the occasional broken frame.
    # Without these flags, ffmpeg bails at the first error and the composited
    # output stops mid-clip (we saw a 21s base produce a 5s composite).
    args = ["ffmpeg", "-y", "-err_detect", "ignore_err", "-fflags", "+discardcorrupt", "-i", str(base_mp4)]
    for v in prepared:
        args += ["-i", v["mp4"]]
    args += [
        "-filter_complex", filter_str,
        "-map", f"[{last}]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-threads", "1",
        "-c:a", "copy",
        "-movflags", "+faststart",
        str(out_mp4),
    ]

    async with FFMPEG_LOCK:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
    if proc.returncode != 0:
        log.warning(f"[clip] composite ffmpeg rc={proc.returncode}: {err.decode(errors='replace')[:500]}")
        try: os.unlink(out_mp4)
        except OSError: pass
        return False
    return True
