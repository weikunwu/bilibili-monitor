"""OBS-overlay 公开接口：主播把"今天最近收到的礼物"叠加到直播画面。

访问无需登录，但必须带合法的 overlay token（由登录用户从房间设置生成）。
token 校验通过后只返回只读的礼物聚合，不含任何账户/密码/cookie。
"""

import json
import sqlite3
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query

from ..config import DB_PATH
from ..db import verify_overlay_token


router = APIRouter()

MAX_USERS = 10


def _row_to_gift_user(event_id: int, user_name: str, user_id: int, extra_json: str) -> dict | None:
    """Convert a single gift event row into a GiftUser-shaped dict (one gift entry).

    The frontend renderer expects GiftUser with gifts/gift_coins/gift_imgs/gift_actions/gift_ids
    maps keyed by gift name. For overlay we never aggregate — each event is its own card.
    """
    try:
        extra = json.loads(extra_json)
    except Exception:
        return None
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


@router.get("/api/overlay/gifts/{room_id}")
async def overlay_gifts(
    room_id: int,
    token: str = Query(..., description="overlay token, generated from room settings"),
    max: int = Query(MAX_USERS, ge=1, le=MAX_USERS),
):
    """Return the most recent N gift events (today, Beijing time) as individual cards.

    不做聚合：每条礼物事件 = 一张卡。Requires overlay token.
    """
    if not verify_overlay_token(room_id, token):
        raise HTTPException(status_code=403, detail="invalid overlay token")
    beijing_tz = timezone(timedelta(hours=8))
    now_bj = datetime.now(beijing_tz)
    bj_start = now_bj.replace(hour=0, minute=0, second=0, microsecond=0)
    bj_end = bj_start + timedelta(days=1)
    utc_start = bj_start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    utc_end = bj_end.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    conn = sqlite3.connect(str(DB_PATH))
    rows = conn.execute(
        "SELECT id, user_name, user_id, extra_json FROM events "
        "WHERE event_type='gift' AND room_id=? AND timestamp >= ? AND timestamp < ? "
        "AND extra_json NOT LIKE '%\"coin_type\": \"silver\"%' "
        "ORDER BY id DESC LIMIT ?",
        (room_id, utc_start, utc_end, max),
    ).fetchall()
    conn.close()

    items = [g for g in (_row_to_gift_user(*r) for r in rows) if g]
    return {"room_id": room_id, "users": items}
