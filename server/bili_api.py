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
# B 站不定期轮换 wbi_img/sub_url 的 url 段，长期复用同一 mixin_key 会被
# -352/-799 拒。两层防御：6h TTL 主动重拉 + 调用方命中风控时显式 invalidate。
_WBI_TTL_SEC = 6 * 3600
_wbi_key_cache = ""
_wbi_key_fetched_at = 0.0


async def get_wbi_key(headers: dict, force: bool = False) -> str:
    """返回 mixin_key（带 6h TTL 缓存）。force=True 跳过缓存重拉。
    nav 拉失败时回落到旧 key（避免无 key 状态完全打不出请求）。"""
    global _wbi_key_cache, _wbi_key_fetched_at
    now = time.time()
    if not force and _wbi_key_cache and now - _wbi_key_fetched_at < _WBI_TTL_SEC:
        return _wbi_key_cache
    async with aiohttp.ClientSession(headers=headers) as session:
        async with session.get(NAV_API) as resp:
            data = await resp.json(content_type=None)
            if data.get("code") != 0:
                # nav 拉失败：保留旧 key（可能仍可用），别空串让所有 wbi 端点炸
                log.warning(f"[wbi] NAV_API 拉 mixin_key 失败 code={data.get('code')}")
                return _wbi_key_cache
            wbi_img = data["data"]["wbi_img"]
            img_key = wbi_img["img_url"].rsplit("/", 1)[-1].split(".")[0]
            sub_key = wbi_img["sub_url"].rsplit("/", 1)[-1].split(".")[0]
            raw = img_key + sub_key
            new_key = "".join(raw[i] for i in WBI_KEY_INDEX_TABLE if i < len(raw))
            if new_key:
                if _wbi_key_cache and new_key != _wbi_key_cache:
                    log.info("[wbi] mixin_key 轮换检测到，已更新缓存")
                _wbi_key_cache = new_key
                _wbi_key_fetched_at = now
            return _wbi_key_cache


def invalidate_wbi_key() -> None:
    """让缓存的 mixin_key 失效，下次 get_wbi_key 强制从 nav 重拉。
    调用方在收到 wbi 相关风控码（-352/-799）时调；多余调用代价小（一次 nav）。"""
    global _wbi_key_cache, _wbi_key_fetched_at
    _wbi_key_cache = ""
    _wbi_key_fetched_at = 0.0


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


_USER_CARD_API = "https://api.bilibili.com/x/web-interface/card"


async def fetch_user_avatar(uid: int, headers: dict) -> str:
    """Resolve a user's avatar URL by uid. Returns '' on any failure.
    走 x/web-interface/card —— 老的用户名片接口，不要 WBI 签名，比
    x/space/wbi/acc/info 少一次 nav + 一次 wbi_sign 计算，且少一处对
    wbi 系统的依赖（mixin_key 轮换炸了不会拖累头像）。"""
    if not uid:
        return ""
    cached = _avatar_cache.get(uid)
    if cached is not None:
        return cached
    try:
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get(_USER_CARD_API, params={"mid": uid}) as resp:
                data = await resp.json(content_type=None)
        if data.get("code") != 0:
            log.info(f"[avatar] uid={uid} code={data.get('code')} msg={data.get('message')}")
            return ""
        card = (data.get("data") or {}).get("card") or {}
        face = card.get("face", "") or ""
        _avatar_cache[uid] = face
        return face
    except Exception as ex:
        log.info(f"[avatar] uid={uid} err={ex}")
        return ""




