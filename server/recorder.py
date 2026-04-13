"""Gift-triggered live-stream clip recorder.

For each live room, a RecorderSession pulls HLS fmp4 segments into an
in-memory ring buffer. On a trigger (e.g. a high-value gift), it grabs
the last `pre_sec` worth of segments, waits for `post_sec` more, and
remuxes the lot to a standalone .mp4 on disk via ffmpeg.
"""

import asyncio
import os
import tempfile
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlencode

import aiohttp

from .config import HEADERS, log, DATA_DIR
from . import effect_catalog, vap_composite


PLAYURL_API = "https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo"

# How many seconds of recent segments to keep in RAM (pre-event buffer).
# 12s gives us plenty of headroom for pre_sec up to ~10.
BUFFER_SECONDS = 12

# Poll cadence for m3u8 refresh. B站 fmp4 lists have TARGETDURATION=1, so 1s
# is enough to catch each new segment.
POLL_INTERVAL = 1.0

# Directory where final clips are written.
CLIP_ROOT = DATA_DIR / "clips"

# Output clips are scaled to this height (width auto, preserves aspect).
# 480 = 480p, much smaller files and faster ffmpeg on the 256MB VM.
CLIP_OUT_HEIGHT = 480


@dataclass
class _Segment:
    seq: int
    duration: float
    data: bytes
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
        self._init_segment: Optional[bytes] = None
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
        self._segments.clear()
        self._seen_seqs.clear()
        self._init_segment = None
        log.info(f"[recorder] room {self.room_id} stop")

    # Clip window parameters.
    PRE_SEC = 5.0
    POST_SEC = 30.0
    MAX_TOTAL_SEC = 120.0  # cap to avoid runaway coalescing

    def request_clip(self, gift_id: int, effect_id: int, label: str):
        """Fire-and-forget: request a clip at the current wall time.

        If a clip is already pending, append this trigger to it (extending
        close_at up to MAX_TOTAL_SEC from the first trigger). Otherwise,
        spawn a new _finalize_clip task.
        """
        if not self._running or not self._segments:
            log.warning(f"[recorder] room {self.room_id} clip skipped: not buffering")
            return
        now = time.time()
        trig = _Trigger(wall_ts=now, gift_id=gift_id, effect_id=effect_id, label=label)

        p = self._pending_clip
        if p is not None:
            cap = p.first_wall + self.MAX_TOTAL_SEC
            new_close = min(now + self.POST_SEC, cap)
            if new_close > p.close_at:
                p.close_at = new_close
            p.triggers.append(trig)
            log.info(f"[recorder] room {self.room_id} trigger coalesced ({len(p.triggers)} total)")
            return

        self._pending_clip = _PendingClip(
            first_wall=now,
            close_at=now + self.POST_SEC,
            triggers=[trig],
        )
        self._pending_clip.task = asyncio.create_task(self._finalize_clip(self._pending_clip))

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
            init = self._init_segment
            if not init:
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

            # Write raw fmp4 (init + segments concatenated) then remux to clean mp4.
            with tempfile.NamedTemporaryFile(suffix=".m4s", delete=False) as fp:
                raw_path = fp.name
                fp.write(init)
                for s in selected:
                    fp.write(s.data)
            try:
                async with vap_composite.FFMPEG_LOCK:
                    proc = await asyncio.create_subprocess_exec(
                        "ffmpeg", "-y", "-i", raw_path,
                        "-vf", f"scale=-2:{CLIP_OUT_HEIGHT}",
                        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
                        "-threads", "1",
                        "-c:a", "copy",
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

            # Build VAP overlays for each trigger, keyed by gift_id (fallback: effect_id).
            clip_anchor = selected[0].wall_ts
            vap_triggers: list[vap_composite.VapTrigger] = []
            for t in p.triggers:
                urls = effect_catalog.get_by_gift(t.gift_id) or effect_catalog.get_by_effect(t.effect_id)
                if not urls:
                    log.info(f"[recorder] no VAP for gift={t.gift_id} effect={t.effect_id}")
                    continue
                fetched = await vap_composite.fetch_vap(urls[0], urls[1])
                if not fetched:
                    continue
                mp4_path, meta = fetched
                vap_triggers.append(vap_composite.VapTrigger(
                    offset_sec=t.wall_ts - clip_anchor,
                    mp4_path=mp4_path,
                    meta=meta,
                ))

            if vap_triggers:
                # Produce two variants — fullscreen + native — for comparison.
                for layout in ("fullscreen", "native"):
                    out_variant = out_dir / f"{base_name}_{layout}.mp4"
                    ok = await vap_composite.composite(
                        str(base_path), vap_triggers, str(out_variant), layout=layout,
                    )
                    if ok:
                        sz = out_variant.stat().st_size / 1024
                        log.info(f"[recorder] composited {out_variant.name} ({sz:.0f}KB)")
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
        params = {
            "room_id": self.room_id, "protocol": "1", "format": "2",
            "codec": "0", "qn": 10000, "platform": "web", "ptype": 8,
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

        if init_uri and self._init_segment is None:
            init_url = init_uri if init_uri.startswith("http") else self._seg_host + init_uri
            async with self._session.get(init_url) as r:
                self._init_segment = await r.read()

        for seq, dur, uri in pending:
            if seq in self._seen_seqs:
                continue
            self._seen_seqs.add(seq)
            seg_url = uri if uri.startswith("http") else self._seg_host + uri
            try:
                async with self._session.get(seg_url) as r:
                    body = await r.read()
            except Exception as ex:
                log.info(f"[recorder] seg {seq} fetch err: {ex}")
                continue
            self._segments.append(_Segment(seq, dur, body, time.time()))

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
    removed_vap = _sweep(vap_composite.VAP_CACHE, recurse_dirs=False)
    if removed_clips or removed_vap:
        log.info(f"[recorder] cleaned {removed_clips} clips, {removed_vap} vap cache")
