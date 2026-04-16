"""OBS-overlay 公开接口：主播把"今天最近收到的礼物"叠加到直播画面。

访问无需登录，但必须带合法的 overlay token（由登录用户从房间设置生成）。
token 校验通过后只返回只读的礼物聚合，不含任何账户/密码/cookie。
"""

import json
import sqlite3
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

import aiohttp
from fastapi import APIRouter, HTTPException, Query, Request, Response

from ..config import DB_PATH, HEADERS
from ..db import verify_overlay_token, get_overlay_settings
from .events import _is_allowed_proxy_host


router = APIRouter()

MAX_EVENTS = 20  # 绝对上限；实际 N 由房间设置决定

# ── 速率限制 ──
# 每个 IP 在 60 秒窗口内的调用次数上限（超过返回 429）。
# gifts: 正常 poll 12/min (每 5 秒一次)，留 5x buffer
# proxy-image: 每次 poll 最多 20 张图 (10 头像 + 10 礼物图)，浏览器 24h 缓存；留 15x buffer
RATE_LIMIT = {
    "gifts": (60, 60.0),
    "proxy": (300, 60.0),
}
# name -> {ip: deque[timestamp]}
_rate_buckets: dict[str, dict[str, deque[float]]] = defaultdict(lambda: defaultdict(deque))


def _client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_rate(request: Request, bucket: str):
    limit, window = RATE_LIMIT[bucket]
    ip = _client_ip(request)
    q = _rate_buckets[bucket][ip]
    now = time.time()
    cutoff = now - window
    while q and q[0] < cutoff:
        q.popleft()
    if len(q) >= limit:
        raise HTTPException(status_code=429, detail="rate limit exceeded")
    q.append(now)


def _row_to_gift_user(
    event_id: int, event_type: str, user_name: str, user_id: int, extra_json: str,
) -> dict | None:
    """Convert a single event row into a GiftUser-shaped dict (one entry).

    支持 gift（含盲盒）和 guard 两类，前端 canvas 渲染器复用同一套字段。
    """
    try:
        extra = json.loads(extra_json)
    except Exception:
        return None
    if event_type == "guard":
        guard_level = extra.get("guard_level", 0)
        name = extra.get("guard_name") or {1: "总督", 2: "提督", 3: "舰长"}.get(guard_level, "大航海")
        num = extra.get("num", 1)
        price = extra.get("price", 0)
        total_coin = price * num
        return {
            "event_id": event_id,
            "user_name": user_name or str(user_id),
            "avatar": extra.get("avatar", ""),
            "gifts": {name: num},
            "gift_coins": {name: total_coin},
            "gift_imgs": {name: extra.get("gift_img", "")} if extra.get("gift_img") else {},
            "gift_actions": {name: "开通"},
            "gift_ids": {name: 0},
            "guard_level": guard_level,
            "total_coin": total_coin,
        }
    gift_name = extra.get("gift_name", "?")
    num = extra.get("num", 1)
    total_coin = extra.get("total_coin", 0)
    action = extra.get("action", "投喂")
    blind_name = extra.get("blind_name", "")
    action_str = f"{blind_name} 爆出" if blind_name else action
    return {
        "event_id": event_id,
        "user_name": user_name or str(user_id),
        "avatar": extra.get("avatar", ""),
        "gifts": {gift_name: num},
        "gift_coins": {gift_name: total_coin},
        "gift_imgs": {gift_name: extra.get("gift_img", "")} if extra.get("gift_img") else {},
        "gift_actions": {gift_name: action_str},
        "gift_ids": {gift_name: extra.get("gift_id", 0)} if extra.get("gift_id") else {},
        "guard_level": extra.get("guard_level", 0),
        "total_coin": total_coin,
    }


def _pass_filters(event_type: str, extra: dict, settings: dict) -> bool:
    """根据房间设置判断事件是否应展示：
      - 类型：show_gift / show_blind / show_guard
      - 价格：按 price_mode (总价 total_coin / 单价 price) 在 [min_price, max_price] 区间内。
        extra 里 price/total_coin 的单位是"电池"（raw 金瓜子 / 100），
        10 电池 = 1 元；min_price / max_price 以元为单位；0 表示不限。
    """
    if event_type == "guard":
        if not settings.get("show_guard"):
            return False
        total = (extra.get("price", 0) or 0) * (extra.get("num", 1) or 1)
        unit = extra.get("price", 0) or 0
    else:
        is_blind = bool(extra.get("blind_name"))
        if is_blind and not settings.get("show_blind"):
            return False
        if not is_blind and not settings.get("show_gift"):
            return False
        total = extra.get("total_coin", 0) or 0
        unit = extra.get("price", 0) or 0
    value_coin = total if settings.get("price_mode") == "total" else unit
    value_yuan = value_coin / 10.0
    mn = settings.get("min_price", 0) or 0
    mx = settings.get("max_price", 0) or 0
    if mn and value_yuan < mn:
        return False
    if mx and value_yuan > mx:
        return False
    return True


@router.get("/api/overlay/gifts/{room_id}")
async def overlay_gifts(
    room_id: int,
    request: Request,
    token: str = Query(..., description="overlay token, generated from room settings"),
):
    """Return the most recent N events (today, Beijing time) as individual cards.

    过滤/数量上限由房间级 overlay_settings 决定；不做聚合，每条事件 = 一张卡。
    """
    _check_rate(request, "gifts")
    if not verify_overlay_token(room_id, token):
        raise HTTPException(status_code=403, detail="invalid overlay token")
    settings = get_overlay_settings(room_id)
    max_events = int(settings.get("max_events") or 10)
    max_events = min(max(max_events, 1), MAX_EVENTS)

    beijing_tz = timezone(timedelta(hours=8))
    now_bj = datetime.now(beijing_tz)
    bj_start = now_bj.replace(hour=0, minute=0, second=0, microsecond=0)
    bj_end = bj_start + timedelta(days=1)
    utc_start = bj_start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    utc_end = bj_end.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    # "清除" 会写一个 cleared_at，overlay 只展示其后的事件
    cleared_at = (settings.get("cleared_at") or "").strip()
    if cleared_at and cleared_at > utc_start:
        utc_start = cleared_at

    # 构造类型条件
    wanted_types: list[str] = []
    if settings.get("show_gift") or settings.get("show_blind"):
        wanted_types.append("gift")
    if settings.get("show_guard"):
        wanted_types.append("guard")
    if not wanted_types:
        return {"room_id": room_id, "users": []}

    placeholders = ",".join("?" for _ in wanted_types)
    conn = sqlite3.connect(str(DB_PATH))
    # 多拉一些然后 Python 侧按设置过滤；最多扫 max_events * 5 条保证性能
    scan_limit = max_events * 5
    rows = conn.execute(
        f"SELECT id, event_type, user_name, user_id, extra_json FROM events "
        f"WHERE event_type IN ({placeholders}) AND room_id=? "
        f"AND timestamp >= ? AND timestamp < ? "
        f"AND COALESCE(json_extract(extra_json, '$.coin_type'), '') != 'silver' "
        f"ORDER BY id DESC LIMIT ?",
        (*wanted_types, room_id, utc_start, utc_end, scan_limit),
    ).fetchall()
    conn.close()

    items: list[dict] = []
    for r in rows:
        event_id, event_type, uname, uid, extra_json = r
        try:
            extra = json.loads(extra_json)
        except Exception:
            continue
        if not _pass_filters(event_type, extra, settings):
            continue
        g = _row_to_gift_user(event_id, event_type, uname, uid, extra_json)
        if g:
            items.append(g)
        if len(items) >= max_events:
            break
    return {"room_id": room_id, "users": items}


@router.get("/api/overlay/proxy-image/{room_id}")
async def overlay_proxy_image(
    room_id: int,
    request: Request,
    token: str = Query(...),
    url: str = Query(...),
):
    """叠加页用的 B站 CDN 图片代理，token 鉴权防滥用 (主接口 /api/proxy-image 仍需登录)。"""
    _check_rate(request, "proxy")
    if not verify_overlay_token(room_id, token):
        raise HTTPException(status_code=403, detail="invalid overlay token")
    if not _is_allowed_proxy_host(url):
        return Response(status_code=400)
    try:
        async with aiohttp.ClientSession(headers=HEADERS) as session:
            async with session.get(url, allow_redirects=False) as resp:
                content_type = resp.headers.get("Content-Type", "image/png")
                data = await resp.read()
                return Response(content=data, media_type=content_type, headers={
                    "Cache-Control": "public, max-age=86400",
                    "Access-Control-Allow-Origin": "*",
                })
    except Exception:
        return Response(status_code=502)
