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
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlencode

import aiohttp

from .config import HEADERS, log, DATA_DIR


PLAYURL_API = "https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo"

# How many seconds of recent segments to keep in RAM (pre-event buffer).
# 12s gives us plenty of headroom for pre_sec up to ~10.
BUFFER_SECONDS = 12

# Poll cadence for m3u8 refresh. B站 fmp4 lists have TARGETDURATION=1, so 1s
# is enough to catch each new segment.
POLL_INTERVAL = 1.0

# Directory where final clips are written.
CLIP_ROOT = DATA_DIR / "clips"


@dataclass
class _Segment:
    seq: int
    duration: float
    data: bytes
    wall_ts: float  # when we fetched it, for post-event timing


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

    async def clip(
        self,
        label: str,
        pre_sec: float = 5.0,
        post_sec: float = 30.0,
    ) -> Optional[str]:
        """Save a clip covering roughly [now - pre_sec, now + post_sec].
        Returns absolute path to .mp4 or None on failure."""
        if not self._running or not self._segments:
            log.warning(f"[recorder] room {self.room_id} clip skipped: not buffering")
            return None

        trigger_wall = time.time()

        # Wait for `post_sec` more content to arrive post-trigger.
        deadline = trigger_wall + post_sec + 2
        while time.time() < deadline:
            latest = self._segments[-1] if self._segments else None
            if latest and latest.wall_ts - trigger_wall >= post_sec:
                break
            await asyncio.sleep(0.5)

        # Pick segments: pre-event window back from trigger, plus everything after.
        pre_cutoff = trigger_wall - pre_sec
        selected = [s for s in self._segments if s.wall_ts >= pre_cutoff]
        if not selected:
            log.warning(f"[recorder] room {self.room_id} clip: no segments in window")
            return None

        init = self._init_segment
        if not init:
            log.warning(f"[recorder] room {self.room_id} clip: no init segment")
            return None

        # Write raw fmp4 (init + segments concatenated) then remux to mp4.
        out_dir = CLIP_ROOT / str(self.room_id)
        out_dir.mkdir(parents=True, exist_ok=True)
        ts_name = time.strftime("%Y%m%d_%H%M%S", time.localtime(trigger_wall))
        safe_label = "".join(c for c in label if c.isalnum() or c in "-_")[:32]
        out_path = out_dir / f"{ts_name}_{safe_label}.mp4"

        with tempfile.NamedTemporaryFile(suffix=".m4s", delete=False) as fp:
            raw_path = fp.name
            fp.write(init)
            for s in selected:
                fp.write(s.data)

        try:
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg", "-y", "-i", raw_path, "-c", "copy",
                "-movflags", "+faststart", str(out_path),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, err = await proc.communicate()
            if proc.returncode != 0:
                log.warning(f"[recorder] ffmpeg fail rc={proc.returncode}: {err.decode(errors='replace')[:400]}")
                return None
        finally:
            try:
                os.unlink(raw_path)
            except OSError:
                pass

        secs_covered = sum(s.duration for s in selected)
        size_kb = out_path.stat().st_size / 1024
        log.info(f"[recorder] room {self.room_id} clip {out_path.name} ({secs_covered:.1f}s, {size_kb:.0f}KB)")
        return str(out_path)

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

        # Evict old segments beyond BUFFER_SECONDS (but keep them if an in-flight
        # clip() is still collecting post-event data — clip() reads atomically).
        cutoff = time.time() - BUFFER_SECONDS
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
    """Delete clip files older than max_age_hours. Called periodically."""
    if not CLIP_ROOT.exists():
        return
    cutoff = time.time() - max_age_hours * 3600
    removed = 0
    for room_dir in CLIP_ROOT.iterdir():
        if not room_dir.is_dir():
            continue
        for f in room_dir.iterdir():
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink()
                    removed += 1
            except OSError:
                pass
    if removed:
        log.info(f"[recorder] cleaned {removed} old clips")
