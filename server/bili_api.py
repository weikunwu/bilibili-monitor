"""B站 API 工具：Wbi 签名、礼物配置、大航海列表"""

import hashlib
import re
import time
from urllib.parse import urlencode

import aiohttp

from .config import (
    HEADERS, NAV_API, WBI_KEY_INDEX_TABLE, ROOM_INFO_API,
    GIFT_CONFIG_API, log,
)

# ── Caches ──
gift_img_cache: dict[int, str] = {}
gift_price_cache: dict[int, int] = {}
gift_gif_cache: dict[int, str] = {}
guard_cache: dict[int, dict[int, int]] = {}

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


async def load_gift_config(headers: dict):
    try:
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get(GIFT_CONFIG_API, params={"platform": "pc"}) as resp:
                data = await resp.json(content_type=None)
                if data.get("code") == 0:
                    for g in data["data"].get("list", []):
                        gift_img_cache[g["id"]] = g.get("img_basic", "")
                        gift_price_cache[g["id"]] = g.get("price", 0)
                        gif_url = g.get("gif", "")
                        if gif_url:
                            gift_gif_cache[g["id"]] = gif_url
                    log.info(f"加载礼物配置: {len(gift_img_cache)} 种礼物")
    except Exception as e:
        log.error(f"加载礼物配置失败: {e}")


async def load_guard_list(room_id: int, headers: dict):
    try:
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get(ROOM_INFO_API, params={"room_id": room_id}) as resp:
                data = await resp.json(content_type=None)
                if data.get("code") != 0:
                    return
                ruid = data["data"]["uid"]

            guards = {}
            for page in range(1, 10):
                async with session.get(
                    "https://api.live.bilibili.com/xlive/app-room/v2/guardTab/topList",
                    params={"roomid": room_id, "ruid": ruid, "page": page, "page_size": 50},
                ) as resp:
                    data = await resp.json(content_type=None)
                    if data.get("code") != 0:
                        break
                    d = data["data"]
                    for g in d.get("top3", []) + d.get("list", []):
                        guards[g["uid"]] = g["guard_level"]
                    if not d.get("list"):
                        break

            guard_cache[room_id] = guards
            log.info(f"加载大航海列表 (房间 {room_id}): {len(guards)} 人")
    except Exception as e:
        log.error(f"加载大航海列表失败 (房间 {room_id}): {e}")
