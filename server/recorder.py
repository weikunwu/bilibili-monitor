"""Gift-triggered live-stream clip recorder.

For each live room, a RecorderSession pulls HLS fmp4 segments into an
in-memory ring buffer. On a trigger (e.g. a high-value gift), it grabs
the last `pre_sec` worth of segments, waits for `post_sec` more, and
remuxes the lot to a standalone .mp4 on disk via ffmpeg.
"""

import asyncio
import json
import os
import tempfile
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlencode

import aiohttp

from .config import HEADERS, log, DATA_DIR
from . import effect_catalog


# Global lock — run at most one ffmpeg subprocess at a time so we don't
# stress the 256MB VM with concurrent encodes/remuxes.
FFMPEG_LOCK = asyncio.Lock()


PLAYURL_API = "https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo"

# How many seconds of recent segments to keep in RAM (pre-event buffer).
# 12s gives us plenty of headroom for pre_sec up to ~10.
BUFFER_SECONDS = 12

# Poll cadence for m3u8 refresh. B站 fmp4 lists have TARGETDURATION=1, so 1s
# is enough to catch each new segment.
POLL_INTERVAL = 1.0

# Directory where final clips are written.
CLIP_ROOT = DATA_DIR / "clips"

# Ephemeral dir for the rolling HLS segment buffer. Keeping the raw
# bytes on disk (instead of in Python memory) is critical on the 256MB
# VM — one segment at 1080p60 ≈ 750KB and a 35s pending window can
# accumulate ~30MB that would otherwise blow the RAM budget.
SEG_BUF_ROOT = Path("/tmp/recorder_buf")


@dataclass
class _Segment:
    seq: int
    duration: float
    path: str       # on-disk location of the raw fmp4 bytes
    size: int       # bytes (cached so we can sum without statting)
    wall_ts: float  # when we fetched it, for post-event timing


@dataclass
class _Trigger:
    wall_ts: float
    gift_id: int
    effect_id: int
    label: str


@dataclass
class _PendingClip:
    """In-flight clip accumulating triggers until its window closes.

    A single clip can cover multiple big gifts fired within a rolling
    post_sec window; close_at extends as new triggers arrive (capped by
    max_total_sec from first_wall).
    """
    first_wall: float                   # earliest trigger, defines pre-window anchor
    close_at: float                     # finalize no sooner than this (wall clock)
    triggers: list[_Trigger] = field(default_factory=list)
    task: Optional[asyncio.Task] = None


class RecorderSession:
    def __init__(self, room_id: int, cookies: dict):
        self.room_id = room_id
        self.cookies = cookies or {}
        self._segments: deque[_Segment] = deque()
        self._init_path: Optional[str] = None   # on-disk init.mp4
        self._buf_dir = SEG_BUF_ROOT / str(room_id)
        self._m3u8_url: str = ""
        self._seg_host: str = ""  # URL prefix for relative segment URIs
        self._seen_seqs: set[int] = set()
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._session: Optional[aiohttp.ClientSession] = None
        self._pending_clip: Optional[_PendingClip] = None

    # ── Public ──

    async def start(self):
        if self._running:
            return
        self._buf_dir.mkdir(parents=True, exist_ok=True)
        self._running = True
        self._task = asyncio.create_task(self._run())
        log.info(f"[recorder] room {self.room_id} start")

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        if self._session:
            await self._session.close()
            self._session = None
        # Drop on-disk segment buffer
        for s in self._segments:
            try: os.unlink(s.path)
            except OSError: pass
        self._segments.clear()
        self._seen_seqs.clear()
        if self._init_path:
            try: os.unlink(self._init_path)
            except OSError: pass
            self._init_path = None
        log.info(f"[recorder] room {self.room_id} stop")

    # Clip window parameters.
    PRE_SEC = 5.0
    POST_TAIL_SEC = 3.0         # record this long after each animation ends
    POST_SEC_FALLBACK = 15.0    # used when VAP metadata isn't available
    MAX_TOTAL_SEC = 120.0       # cap to avoid runaway coalescing

    async def request_clip(self, gift_id: int, effect_id: int, label: str):
        """Async: register a clip trigger at the current wall time.

        close_at for each trigger is set to (trigger_wall + animation_dur +
        POST_TAIL_SEC); the pending clip's close_at tracks the max across
        all triggers. If VAP metadata isn't available we fall back to a
        fixed POST_SEC_FALLBACK window.

        If a clip is already pending, append this trigger (extending
        close_at up to MAX_TOTAL_SEC from the first trigger). Otherwise
        spawn a new _finalize_clip task.
        """
        if not self._running or not self._segments:
            log.warning(f"[recorder] room {self.room_id} clip skipped: not buffering")
            return
        now = time.time()
        trig = _Trigger(wall_ts=now, gift_id=gift_id, effect_id=effect_id, label=label)

        # Resolve this trigger's animation duration (network fetch, cached).
        urls = effect_catalog.get_by_gift(gift_id) or effect_catalog.get_by_effect(effect_id)
        anim_dur = None
        if urls:
            anim_dur = await effect_catalog.fetch_duration(urls[1])
        if anim_dur is None:
            anim_dur = self.POST_SEC_FALLBACK - self.POST_TAIL_SEC  # default keeps total = FALLBACK
        trigger_close = now + anim_dur + self.POST_TAIL_SEC

        p = self._pending_clip
        if p is not None:
            cap = p.first_wall + self.MAX_TOTAL_SEC
            new_close = min(trigger_close, cap)
            if new_close > p.close_at:
                p.close_at = new_close
            p.triggers.append(trig)
            log.info(f"[recorder] room {self.room_id} trigger coalesced "
                     f"({len(p.triggers)} total, close_at +{p.close_at - p.first_wall:.1f}s)")
            return

        self._pending_clip = _PendingClip(
            first_wall=now,
            close_at=trigger_close,
            triggers=[trig],
        )
        self._pending_clip.task = asyncio.create_task(self._finalize_clip(self._pending_clip))
        log.info(f"[recorder] room {self.room_id} new pending clip "
                 f"(anim {anim_dur:.1f}s → close_at +{anim_dur + self.POST_TAIL_SEC:.1f}s)")

    async def _finalize_clip(self, p: _PendingClip):
        """Wait until close_at, then snapshot segments and composite VAPs."""
        try:
            # Sleep-until-close, checking periodically so coalesced extensions take effect.
            while True:
                now = time.time()
                if now >= p.close_at + 1.0:
                    break
                await asyncio.sleep(min(1.0, max(0.2, p.close_at + 1.0 - now)))

            # Release the pending slot so new triggers can start a fresh clip.
            if self._pending_clip is p:
                self._pending_clip = None

            pre_cutoff = p.first_wall - self.PRE_SEC
            selected = [s for s in self._segments if s.wall_ts >= pre_cutoff]
            if not selected:
                log.warning(f"[recorder] room {self.room_id} clip: no segments in window")
                return
            # Seq numbers must be strictly contiguous; a gap means a segment
            # fetch was dropped and the H.264 bitstream will have unresolvable
            # references after that point. Take the longest contiguous run
            # that still covers the trigger.
            selected.sort(key=lambda s: s.seq)
            trigger_wall = p.first_wall
            runs: list[list[_Segment]] = [[selected[0]]]
            for s in selected[1:]:
                if s.seq == runs[-1][-1].seq + 1:
                    runs[-1].append(s)
                else:
                    runs.append([s])
            # Prefer a run containing the trigger; else fall back to longest.
            run = next(
                (r for r in runs if r[0].wall_ts <= trigger_wall <= r[-1].wall_ts + r[-1].duration),
                max(runs, key=len),
            )
            if len(run) != len(selected):
                gaps = len(runs) - 1
                log.warning(
                    f"[recorder] room {self.room_id} clip has {gaps} seq gap(s); "
                    f"keeping {len(run)}/{len(selected)} segments to avoid broken bitstream"
                )
            selected = run
            init_path = self._init_path
            if not init_path:
                log.warning(f"[recorder] room {self.room_id} clip: no init segment")
                return

            out_dir = CLIP_ROOT / str(self.room_id)
            out_dir.mkdir(parents=True, exist_ok=True)
            ts_name = time.strftime("%Y%m%d_%H%M%S", time.localtime(p.first_wall))
            primary_label = p.triggers[0].label or "gift"
            safe_label = "".join(c for c in primary_label if c.isalnum() or c in "-_")[:32]
            if len(p.triggers) > 1:
                safe_label += f"_x{len(p.triggers)}"
            base_name = f"{ts_name}_{safe_label}"
            base_path = out_dir / f"{base_name}.mp4"

            # Concatenate init + segment files on disk (low-memory; one 64KB
            # chunk at a time). Output to a temp .m4s that ffmpeg will remux.
            with tempfile.NamedTemporaryFile(suffix=".m4s", delete=False) as fp:
                raw_path = fp.name
                for src in [init_path] + [s.path for s in selected]:
                    with open(src, "rb") as f:
                        while True:
                            chunk = f.read(65536)
                            if not chunk: break
                            fp.write(chunk)
            try:
                async with FFMPEG_LOCK:
                    proc = await asyncio.create_subprocess_exec(
                        "ffmpeg", "-y", "-i", raw_path, "-c", "copy",
                        "-movflags", "+faststart", str(base_path),
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.PIPE,
                    )
                    _, err = await proc.communicate()
                if proc.returncode != 0:
                    log.warning(f"[recorder] ffmpeg fail rc={proc.returncode}: {err.decode(errors='replace')[:400]}")
                    return
            finally:
                try: os.unlink(raw_path)
                except OSError: pass

            secs_covered = sum(s.duration for s in selected)
            size_kb = base_path.stat().st_size / 1024
            log.info(f"[recorder] room {self.room_id} base clip {base_path.name} "
                     f"({secs_covered:.1f}s, {size_kb:.0f}KB, {len(p.triggers)} triggers)")

            # Build a sidecar JSON describing VAP overlays, with absolute wall
            # timestamps so the UI can match events to clips without guessing.
            clip_anchor = selected[0].wall_ts
            def _iso(ts: float) -> str:
                return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            overlays = []
            for t in p.triggers:
                urls = effect_catalog.get_by_gift(t.gift_id) or effect_catalog.get_by_effect(t.effect_id)
                entry = {
                    "offset_sec": round(t.wall_ts - clip_anchor, 3),
                    "trigger_ts": _iso(t.wall_ts),
                    "gift_id": t.gift_id,
                    "effect_id": t.effect_id,
                    "label": t.label,
                }
                if urls:
                    entry["vap_mp4"] = urls[0]
                    entry["vap_json"] = urls[1]
                overlays.append(entry)

            meta_path = out_dir / f"{base_name}.json"
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump({
                    "base_mp4": base_path.name,
                    "clip_start_ts": _iso(clip_anchor),
                    "duration_sec": round(secs_covered, 3),
                    "overlays": overlays,
                }, f, ensure_ascii=False, indent=2)
            log.info(f"[recorder] sidecar {meta_path.name} with {len(overlays)} overlays")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning(f"[recorder] finalize_clip err: {e}")

    # ── Internals ──

    def _headers(self) -> dict:
        h = dict(HEADERS)
        if self.cookies:
            h["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items() if k != "refresh_token")
        return h

    async def _run(self):
        self._session = aiohttp.ClientSession(headers=self._headers(), timeout=aiohttp.ClientTimeout(total=8))
        try:
            if not await self._resolve_playurl():
                log.warning(f"[recorder] room {self.room_id} 无可用 fmp4 HLS 流")
                return
            while self._running:
                try:
                    await self._poll_once()
                except asyncio.CancelledError:
                    raise
                except Exception as ex:
                    log.info(f"[recorder] room {self.room_id} poll err: {ex}")
                await asyncio.sleep(POLL_INTERVAL)
        except asyncio.CancelledError:
            pass

    async def _resolve_playurl(self) -> bool:
        # qn: 80=360p, 150=720p (default high), 250=720p60, 400=1080p, 10000=原画.
        # Lower is critical on the 256MB VM: 720p ~2Mbps buffered for 35s = 9MB,
        # 360p ~500Kbps = 2MB.
        params = {
            "room_id": self.room_id, "protocol": "1", "format": "2",
            "codec": "0", "qn": 80, "platform": "web", "ptype": 8,
        }
        async with self._session.get(PLAYURL_API + "?" + urlencode(params)) as r:
            data = await r.json(content_type=None)
        if data.get("code") != 0:
            log.warning(f"[recorder] playurl code={data.get('code')} msg={data.get('message')}")
            return False
        for s in data.get("data", {}).get("playurl_info", {}).get("playurl", {}).get("stream", []):
            if s.get("protocol_name") != "http_hls":
                continue
            for fmt in s.get("format", []):
                if fmt.get("format_name") != "fmp4":
                    continue
                for codec in fmt.get("codec", []):
                    urls = codec.get("url_info", [])
                    base = codec.get("base_url", "")
                    if not urls or not base:
                        continue
                    m3u8 = urls[0]["host"] + base + urls[0]["extra"]
                    self._m3u8_url = m3u8
                    self._seg_host = m3u8.rsplit("/", 1)[0] + "/"
                    return True
        return False

    async def _poll_once(self):
        async with self._session.get(self._m3u8_url) as r:
            text = (await r.read()).decode("utf-8", errors="replace")

        media_seq = 0
        init_uri = None
        pending: list[tuple[int, float, str]] = []
        cur_seq = None
        cur_dur = None
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
                media_seq = int(line.split(":", 1)[1])
                cur_seq = media_seq
            elif line.startswith("#EXT-X-MAP:"):
                # URI="init.mp4"
                for part in line.split(":", 1)[1].split(","):
                    k, _, v = part.partition("=")
                    if k.strip() == "URI":
                        init_uri = v.strip().strip('"')
            elif line.startswith("#EXTINF:"):
                try:
                    cur_dur = float(line.split(":", 1)[1].rstrip(","))
                except ValueError:
                    cur_dur = 1.0
            elif line and not line.startswith("#"):
                if cur_seq is None:
                    continue
                pending.append((cur_seq, cur_dur or 1.0, line))
                cur_seq += 1
                cur_dur = None

        if init_uri and self._init_path is None:
            init_url = init_uri if init_uri.startswith("http") else self._seg_host + init_uri
            async with self._session.get(init_url) as r:
                body = await r.read()
            init_path = self._buf_dir / "init.mp4"
            init_path.write_bytes(body)
            self._init_path = str(init_path)

        for seq, dur, uri in pending:
            if seq in self._seen_seqs:
                continue
            seg_url = uri if uri.startswith("http") else self._seg_host + uri
            # Retry transient network failures (ConnectionResetError,
            # ClientPayloadError). A single missed segment creates a gap in
            # the H.264 bitstream: later P/B-frames reference frames that
            # never made it, and the decoder fails every subsequent frame —
            # the whole clip ends up black.
            body = None
            last_err: Optional[Exception] = None
            for attempt in range(3):
                try:
                    async with self._session.get(seg_url) as r:
                        body = await r.read()
                    break
                except Exception as ex:
                    last_err = ex
                    if attempt < 2:
                        await asyncio.sleep(0.3 * (attempt + 1))
            if body is None:
                log.info(f"[recorder] seg {seq} fetch err after retries: "
                         f"{type(last_err).__name__}: {last_err}")
                # Don't add to _seen_seqs so the next poll may still pick it
                # up if it's still in the playlist window.
                continue
            self._seen_seqs.add(seq)
            seg_path = self._buf_dir / f"{seq}.m4s"
            seg_path.write_bytes(body)
            self._segments.append(_Segment(seq, dur, str(seg_path), len(body), time.time()))

        # Evict old segments beyond BUFFER_SECONDS — but if a pending clip is
        # in flight, protect everything back to (first_trigger - PRE_SEC) or it
        # will prune the pre-event window before finalize_clip runs.
        cutoff = time.time() - BUFFER_SECONDS
        if self._pending_clip is not None:
            protect = self._pending_clip.first_wall - self.PRE_SEC
            cutoff = min(cutoff, protect)
        while self._segments and self._segments[0].wall_ts < cutoff:
            old = self._segments.popleft()
            self._seen_seqs.discard(old.seq)
            try: os.unlink(old.path)
            except OSError: pass


# Global registry — one session per room.
_sessions: dict[int, RecorderSession] = {}


def get_session(room_id: int) -> Optional[RecorderSession]:
    return _sessions.get(room_id)


async def start_for(room_id: int, cookies: dict) -> RecorderSession:
    # Reserve the slot synchronously (no await before the assignment) so two
    # concurrent callers don't both create orphan sessions.
    s = _sessions.get(room_id)
    if s:
        return s
    s = RecorderSession(room_id, cookies)
    _sessions[room_id] = s
    try:
        await s.start()
    except Exception:
        _sessions.pop(room_id, None)
        raise
    return s


async def stop_for(room_id: int):
    s = _sessions.pop(room_id, None)
    if s:
        await s.stop()


def cleanup_old_clips(max_age_hours: int = 24):
    """Delete clip files and cached VAP assets older than max_age_hours."""
    cutoff = time.time() - max_age_hours * 3600

    def _sweep(root, recurse_dirs: bool) -> int:
        if not root.exists():
            return 0
        n = 0
        targets = [f for d in root.iterdir() if d.is_dir() for f in d.iterdir()] if recurse_dirs \
                  else list(root.iterdir())
        for f in targets:
            try:
                if f.is_file() and f.stat().st_mtime < cutoff:
                    f.unlink()
                    n += 1
            except OSError:
                pass
        return n

    removed_clips = _sweep(CLIP_ROOT, recurse_dirs=True)
    # VAP assets downloaded by the on-demand composite endpoint
    # (server/routes/clips.py) live in /tmp/vap_dl — sweep those too.
    removed_vap = _sweep(Path("/tmp/vap_dl"), recurse_dirs=False)
    if removed_clips or removed_vap:
        log.info(f"[recorder] cleaned {removed_clips} clips, {removed_vap} vap cache")
