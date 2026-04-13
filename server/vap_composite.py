"""VAP (Tencent Video Animation Player) overlay compositing.

B站 的弹幕栏大礼物动画用 VAP 格式分发：一个 mp4 把 RGB 帧和 alpha 帧拼在同
一张画面上（左右或上下两半），一个配套 json 描述两块区域的像素坐标。前端用
WebGL 拆开再合成带透明通道的视频。

我们这里用 ffmpeg filter_complex 做同样的事：crop 出 RGB 和 alpha，
alphamerge 合成，overlay 到录屏 mp4 上对应的时间点。

支持一份 clip 合成多个 VAP（chain 多个 overlay filter）。
"""

import asyncio
import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from typing import Optional

import aiohttp

from .config import HEADERS, log, DATA_DIR


VAP_CACHE = DATA_DIR / "vap_cache"


@dataclass
class VapTrigger:
    """One animation to overlay."""
    offset_sec: float           # when in the clip timeline the animation starts
    mp4_path: str               # local path to VAP mp4
    meta: dict                  # parsed VAP json


def _cache_path(url: str, suffix: str) -> str:
    h = hashlib.sha1(url.encode()).hexdigest()
    VAP_CACHE.mkdir(parents=True, exist_ok=True)
    return str(VAP_CACHE / f"{h}{suffix}")


async def fetch_vap(mp4_url: str, json_url: str) -> Optional[tuple[str, dict]]:
    """Download (or reuse cached) VAP mp4 and json. Returns (mp4_path, meta)."""
    mp4_path = _cache_path(mp4_url, ".mp4")
    json_path = _cache_path(json_url, ".json")
    try:
        async with aiohttp.ClientSession(headers=HEADERS, timeout=aiohttp.ClientTimeout(total=30)) as s:
            if not os.path.exists(mp4_path):
                async with s.get(mp4_url) as r:
                    data = await r.read()
                with open(mp4_path, "wb") as f:
                    f.write(data)
            if not os.path.exists(json_path):
                async with s.get(json_url) as r:
                    data = await r.read()
                with open(json_path, "wb") as f:
                    f.write(data)
    except Exception as e:
        log.warning(f"[vap] download failed: {e}")
        return None
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except Exception as e:
        log.warning(f"[vap] parse json failed: {e}")
        return None
    return mp4_path, meta


def _rect(meta: dict, key: str) -> Optional[tuple[int, int, int, int]]:
    info = meta.get("info") or {}
    arr = info.get(key)
    if not (isinstance(arr, list) and len(arr) == 4):
        return None
    return tuple(int(v) for v in arr)  # type: ignore


def build_filter(
    main_w: int,
    main_h: int,
    triggers: list[VapTrigger],
    layout: str = "fullscreen",
) -> Optional[str]:
    """Build an ffmpeg -filter_complex string for overlaying one-or-more VAPs.

    layout:
      - "fullscreen": scale each VAP to main_w × main_h, overlay at (0, 0)
      - "native":     keep VAP's natural w × h, center on the base clip
    """
    if not triggers:
        return None

    parts: list[str] = []
    last_label = "0:v"

    for i, t in enumerate(triggers):
        info = t.meta.get("info") or {}
        rgb = _rect(t.meta, "rgbFrame")
        alpha = _rect(t.meta, "aFrame")
        out_w = int(info.get("w") or 0)
        out_h = int(info.get("h") or 0)
        if not (rgb and alpha and out_w and out_h):
            log.warning(f"[vap] trigger {i} missing frame rects / dims, skipping")
            continue

        fps = info.get("fps", 24)
        idx = i + 1  # ffmpeg input index (0 is base clip)

        rx, ry, rw, rh = rgb
        ax, ay, aw, ah = alpha

        off = max(0.0, t.offset_sec)
        # Shift VAP timestamps so its frame 0 lands at `off` seconds in the base timeline.
        pts_shift = f"setpts=PTS-STARTPTS+{off:.3f}/TB"

        # Determine overlay target size + position
        if layout == "fullscreen":
            dst_w, dst_h = main_w, main_h
            pos_x, pos_y = 0, 0
        else:  # native: preserve native dims, center
            dst_w, dst_h = out_w, out_h
            # Never exceed main size
            if dst_w > main_w or dst_h > main_h:
                scale = min(main_w / dst_w, main_h / dst_h)
                dst_w = int(dst_w * scale)
                dst_h = int(dst_h * scale)
            pos_x = (main_w - dst_w) // 2
            pos_y = (main_h - dst_h) // 2

        # Animation duration (frames / fps); add a small tail margin.
        # "f" field in info is total frame count per VAP spec; fallback to frame list length.
        frames = info.get("f") or len(t.meta.get("frame") or [])
        dur = (frames / fps) if frames else 15.0
        t0 = off
        t1 = off + dur + 0.1

        rgb_lbl = f"rgb{i}"
        a_lbl = f"al{i}"
        vap_lbl = f"vap{i}"
        next_lbl = f"v{i}"

        parts.append(f"[{idx}:v]crop={rw}:{rh}:{rx}:{ry},{pts_shift}[{rgb_lbl}]")
        parts.append(f"[{idx}:v]crop={aw}:{ah}:{ax}:{ay},format=gray,{pts_shift}[{a_lbl}]")
        parts.append(f"[{rgb_lbl}][{a_lbl}]alphamerge,scale={dst_w}:{dst_h}[{vap_lbl}]")
        parts.append(
            f"[{last_label}][{vap_lbl}]overlay={pos_x}:{pos_y}:"
            f"enable='between(t\\,{t0:.3f}\\,{t1:.3f})'[{next_lbl}]"
        )
        last_label = next_lbl

    if last_label == "0:v":
        return None  # no valid triggers

    # Final label is last_label — ffmpeg expects us to map it.
    return ";".join(parts), last_label  # type: ignore


async def probe_dims(path: str) -> Optional[tuple[int, int]]:
    """Get (width, height) of a video via ffprobe."""
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        return None
    try:
        w, h = out.decode().strip().split("x")
        return int(w), int(h)
    except Exception:
        return None


async def composite(
    base_clip: str,
    triggers: list[VapTrigger],
    out_path: str,
    layout: str = "fullscreen",
) -> bool:
    """Run ffmpeg to overlay all VAP triggers onto base_clip → out_path."""
    dims = await probe_dims(base_clip)
    if not dims:
        log.warning(f"[vap] probe base clip failed: {base_clip}")
        return False
    main_w, main_h = dims

    built = build_filter(main_w, main_h, triggers, layout=layout)
    if not built:
        log.warning("[vap] no valid triggers, skipping composite")
        return False
    filter_str, final_label = built

    args = ["ffmpeg", "-y", "-i", base_clip]
    for t in triggers:
        args += ["-i", t.mp4_path]
    args += [
        "-filter_complex", filter_str,
        "-map", f"[{final_label}]",
        "-map", "0:a?",
        # ultrafast + higher CRF keeps memory + CPU low on 256MB VM.
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-threads", "1",
        "-c:a", "copy",
        "-movflags", "+faststart",
        out_path,
    ]

    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        log.warning(f"[vap] ffmpeg rc={proc.returncode}: {err.decode(errors='replace')[:500]}")
        return False
    return True
