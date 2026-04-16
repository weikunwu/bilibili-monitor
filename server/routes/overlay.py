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


def _build_recent_gift_users(rows) -> list[dict]:
    """Aggregate today's gifts by user; order by last-seen gift timestamp desc.

    rows: iterable of (user_name, user_id, timestamp, extra_json)
    """
    users: dict = {}
    for user_name, user_id, ts, extra_json in rows:
        try:
            extra = json.loads(extra_json)
        except Exception:
            continue
        key = user_name or str(user_id)
        if key not in users:
            users[key] = {
                "user_name": user_name,
                "avatar": extra.get("avatar", ""),
                "gifts": {},
                "gift_coins": {},
                "gift_imgs": {},
                "gift_actions": {},
                "gift_ids": {},
                "guard_level": 0,
                "total_coin": 0,
                "_last_ts": ts,
            }
        u = users[key]
        if ts > u["_last_ts"]:
            u["_last_ts"] = ts
        gift_name = extra.get("gift_name", "?")
        num = extra.get("num", 1)
        u["gifts"][gift_name] = u["gifts"].get(gift_name, 0) + num
        tc = extra.get("total_coin", 0)
        u["total_coin"] += tc
        u["gift_coins"][gift_name] = u["gift_coins"].get(gift_name, 0) + tc
        if not u["avatar"] and extra.get("avatar"):
            u["avatar"] = extra["avatar"]
        gift_img = extra.get("gift_img", "")
        if gift_img and gift_name not in u["gift_imgs"]:
            u["gift_imgs"][gift_name] = gift_img
        action = extra.get("action", "投喂")
        blind_name = extra.get("blind_name", "")
        if gift_name not in u["gift_actions"]:
            u["gift_actions"][gift_name] = f"{blind_name} 爆出" if blind_name else action
        gid = extra.get("gift_id", 0)
        if gid and gift_name not in u["gift_ids"]:
            u["gift_ids"][gift_name] = gid
        gl = extra.get("guard_level", 0)
        if gl and (not u["guard_level"] or gl < u["guard_level"]):
            u["guard_level"] = gl

    ordered = sorted(users.values(), key=lambda x: x["_last_ts"], reverse=True)
    for u in ordered:
        u.pop("_last_ts", None)
    return ordered[:MAX_USERS]


@router.get("/api/overlay/gifts/{room_id}")
async def overlay_gifts(
    room_id: int,
    token: str = Query(..., description="overlay token, generated from room settings"),
    max: int = Query(MAX_USERS, ge=1, le=MAX_USERS),
):
    """Return up to `max` most-recently-active users' today gift aggregate. Requires overlay token."""
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
        "SELECT user_name, user_id, timestamp, extra_json FROM events "
        "WHERE event_type='gift' AND room_id=? AND timestamp >= ? AND timestamp < ? "
        "AND extra_json NOT LIKE '%\"coin_type\": \"silver\"%'",
        (room_id, utc_start, utc_end),
    ).fetchall()
    conn.close()

    users = _build_recent_gift_users(rows)
    return {"room_id": room_id, "users": users[:max]}
