"""Full-screen gift effect catalog.

Fetches B站's gift → VAP animation (mp4 + json alpha manifest) mapping from
fullScSpecialEffect/GetEffectConfListV2. The catalog is cached in memory and
refreshed periodically. Used by the clip recorder to composite the
弹幕栏 big animation onto the recorded HLS video.

NOTE: must be called WITHOUT base_version param — otherwise the server returns
an empty delta assuming the client has an up-to-date cache.
"""

import asyncio
import json
from typing import Optional

import aiohttp

from .config import HEADERS, log


EFFECT_API = "https://api.live.bilibili.com/xlive/general-interface/v1/fullScSpecialEffect/GetEffectConfListV2"

# gift_id → (web_mp4_url, web_mp4_json_url)
_by_gift: dict[int, tuple[str, str]] = {}
# effect_id → (web_mp4_url, web_mp4_json_url)  — some events only carry effect_id
_by_effect: dict[int, tuple[str, str]] = {}
# url → duration_sec (lazily fetched from the VAP json's info.f / info.fps)
_duration_cache: dict[str, float] = {}


async def refresh() -> int:
    """Fetch full catalog. Returns count on success, 0 on failure."""
    params = {"platform": "pc", "room_id": "1"}  # any room_id works; no base_version
    try:
        async with aiohttp.ClientSession(headers=HEADERS, timeout=aiohttp.ClientTimeout(total=15)) as s:
            async with s.get(EFFECT_API, params=params) as r:
                data = await r.json(content_type=None)
    except Exception as e:
        log.warning(f"[effect_catalog] fetch failed: {e}")
        return 0
    if data.get("code") != 0:
        log.warning(f"[effect_catalog] api code={data.get('code')} msg={data.get('message')}")
        return 0

    conf_list = data.get("data", {}).get("full_sc_resource", {}).get("conf_list", [])
    new_by_gift: dict[int, tuple[str, str]] = {}
    new_by_effect: dict[int, tuple[str, str]] = {}
    for c in conf_list:
        mp4 = c.get("web_mp4") or ""
        mp4_json = c.get("web_mp4_json") or ""
        if not mp4 or not mp4_json:
            continue
        eff_id = c.get("id", 0)
        if eff_id:
            new_by_effect[eff_id] = (mp4, mp4_json)
        for gid in c.get("bind_gift_ids") or []:
            if gid:
                new_by_gift[gid] = (mp4, mp4_json)

    _by_gift.clear(); _by_gift.update(new_by_gift)
    _by_effect.clear(); _by_effect.update(new_by_effect)
    log.info(f"[effect_catalog] loaded {len(_by_gift)} gifts / {len(_by_effect)} effects")
    return len(_by_gift)


def get_by_gift(gift_id: int) -> Optional[tuple[str, str]]:
    return _by_gift.get(gift_id)


def get_by_effect(effect_id: int) -> Optional[tuple[str, str]]:
    return _by_effect.get(effect_id)


async def fetch_duration(json_url: str) -> Optional[float]:
    """Return the VAP animation duration in seconds (info.f / info.fps).

    Downloads the small sidecar json once and caches. Returns None on any
    failure so the caller can fall back to a default.
    """
    if not json_url:
        return None
    cached = _duration_cache.get(json_url)
    if cached is not None:
        return cached
    try:
        async with aiohttp.ClientSession(headers=HEADERS, timeout=aiohttp.ClientTimeout(total=10)) as s:
            async with s.get(json_url) as r:
                data = json.loads(await r.text())
    except Exception as e:
        log.info(f"[effect_catalog] duration fetch failed for {json_url[-40:]}: {e}")
        return None
    info = (data or {}).get("info") or {}
    f = info.get("f") or 0
    fps = info.get("fps") or 0
    if not (f and fps):
        return None
    dur = f / fps
    _duration_cache[json_url] = dur
    return dur


async def run_periodic(interval_sec: int = 6 * 3600):
    """Refresh every `interval_sec` (default 6h)."""
    while True:
        await refresh()
        await asyncio.sleep(interval_sec)
