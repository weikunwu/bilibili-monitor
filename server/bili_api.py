"""B站 API 工具：Wbi 签名、礼物配置、大航海列表"""

import hashlib
import re
import time
from urllib.parse import urlencode

import aiohttp

from .config import (
    HEADERS, NAV_API, WBI_KEY_INDEX_TABLE, log,
)

# ── Caches ──
_wbi_key_cache = ""


async def get_wbi_key(headers: dict) -> str:
    global _wbi_key_cache
    if _wbi_key_cache:
        return _wbi_key_cache
    async with aiohttp.ClientSession(headers=headers) as session:
        async with session.get(NAV_API) as resp:
            data = await resp.json(content_type=None)
            if data.get("code") != 0:
                return ""
            wbi_img = data["data"]["wbi_img"]
            img_key = wbi_img["img_url"].rsplit("/", 1)[-1].split(".")[0]
            sub_key = wbi_img["sub_url"].rsplit("/", 1)[-1].split(".")[0]
            raw = img_key + sub_key
            _wbi_key_cache = "".join(raw[i] for i in WBI_KEY_INDEX_TABLE if i < len(raw))
            return _wbi_key_cache


def wbi_sign(params: dict, wbi_key: str) -> dict:
    params["wts"] = int(time.time())
    sorted_params = sorted(params.items())
    filtered = [(k, re.sub(r"[!'()*]", "", str(v))) for k, v in sorted_params]
    query = urlencode(filtered)
    w_rid = hashlib.md5((query + wbi_key).encode()).hexdigest()
    params["w_rid"] = w_rid
    return params


# uid -> avatar cache, small + process-local. B站 face URLs don't change
# often, so caching avoids hammering the user-info API on repeat guards.
_avatar_cache: dict[int, str] = {}


def _strip_ip_prefix(s: str) -> str:
    s = (s or "").strip()
    for p in ("IP属地：", "IP属地:"):
        if s.startswith(p):
            return s[len(p):].strip()
    return s


async def fetch_user_ip_location(uid: int, headers: dict) -> str:
    """Return the IP 属地 (province) for a uid, or '' if unknown.
    Tries acc/info first (legacy `ip_location` — mostly empty now since B站
    stopped populating it), then falls back to the user's dynamic feed where
    each item carries `pub_location`. Requires bot SESSDATA in headers to
    avoid 412 anti-crawl on the dynamic endpoint."""
    if not uid:
        return ""
    try:
        wbi_key = await get_wbi_key(headers)
        async with aiohttp.ClientSession(headers=headers) as session:
            if wbi_key:
                params = wbi_sign({"mid": uid}, wbi_key)
                url = "https://api.bilibili.com/x/space/wbi/acc/info?" + urlencode(params)
                async with session.get(url) as resp:
                    d1 = await resp.json(content_type=None)
                if d1.get("code") == 0:
                    dd = d1.get("data") or {}
                    loc = _strip_ip_prefix(dd.get("ip_location") or "")
                    if loc:
                        return loc
                    log.info(f"[ip_loc] acc/info uid={uid} empty ip_location; keys={sorted(dd.keys())}")
                else:
                    log.info(f"[ip_loc] acc/info uid={uid} code={d1.get('code')} msg={d1.get('message')}")

            # Fallback: most recent dynamic post carries pub_location.
            feed = "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space"
            try:
                async with session.get(feed, params={"host_mid": uid}) as resp:
                    status = resp.status
                    text = await resp.text()
                d2 = None
                try:
                    import json as _json
                    d2 = _json.loads(text)
                except Exception:
                    log.info(f"[ip_loc] feed uid={uid} non-json status={status} body={text[:120]!r}")
                    return ""
            except Exception as ex:
                log.info(f"[ip_loc] feed uid={uid} err={ex}")
                return ""
            if d2.get("code") != 0:
                log.info(f"[ip_loc] feed uid={uid} code={d2.get('code')} msg={d2.get('message')}")
                return ""
            items = ((d2.get("data") or {}).get("items")) or []
            log.info(f"[ip_loc] feed uid={uid} n_items={len(items)}")
            for it in items:
                ma = (it.get("modules") or {}).get("module_author") or {}
                loc = _strip_ip_prefix(ma.get("pub_location") or "")
                if loc:
                    return loc
            return ""
    except Exception as ex:
        log.info(f"[ip_loc] uid={uid} err={ex}")
        return ""


async def fetch_user_avatar(uid: int, headers: dict) -> str:
    """Resolve a user's avatar URL by uid. Returns '' on any failure."""
    if not uid:
        return ""
    cached = _avatar_cache.get(uid)
    if cached is not None:
        return cached
    try:
        wbi_key = await get_wbi_key(headers)
        if not wbi_key:
            return ""
        params = wbi_sign({"mid": uid}, wbi_key)
        url = "https://api.bilibili.com/x/space/wbi/acc/info?" + urlencode(params)
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get(url) as resp:
                data = await resp.json(content_type=None)
        if data.get("code") != 0:
            log.info(f"[avatar] uid={uid} code={data.get('code')} msg={data.get('message')}")
            return ""
        face = data.get("data", {}).get("face", "") or ""
        _avatar_cache[uid] = face
        return face
    except Exception as ex:
        log.info(f"[avatar] uid={uid} err={ex}")
        return ""




