"""事件查询、统计、礼物汇总 API"""

import json
import sqlite3
from datetime import datetime, timezone, timedelta
from typing import Optional

import aiohttp
from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response

from ..config import DB_PATH, BASE_DIR, HEADERS, log
from ..auth import require_room_access
from ..manager import manager

router = APIRouter()


@router.get("/api/proxy-image")
async def proxy_image(url: str = Query(...)):
    """代理 B站 CDN 图片，解决前端 CORS 问题"""
    if not url.startswith("https://") and not url.startswith("http://"):
        return Response(status_code=400)
    try:
        async with aiohttp.ClientSession(headers=HEADERS) as session:
            async with session.get(url) as resp:
                content_type = resp.headers.get("Content-Type", "image/png")
                data = await resp.read()
                return Response(content=data, media_type=content_type, headers={
                    "Cache-Control": "public, max-age=86400",
                    "Access-Control-Allow-Origin": "*",
                })
    except Exception:
        return Response(status_code=502)


def _today_utc_range(tz_offset: Optional[int] = None) -> tuple[str, str]:
    if tz_offset is not None:
        user_tz = timezone(timedelta(minutes=-tz_offset))
    else:
        user_tz = timezone.utc
    user_now = datetime.now(user_tz)
    user_today_start = user_now.replace(hour=0, minute=0, second=0, microsecond=0)
    user_today_end = user_today_start + timedelta(days=1)
    utc_start = user_today_start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    utc_end = user_today_end.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return utc_start, utc_end


@router.get("/api/events")
async def get_events(
    room_id: int = Query(...),
    type: Optional[str] = Query(None),
    user_name: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    time_from: Optional[str] = Query(None),
    time_to: Optional[str] = Query(None),
    _=Depends(require_room_access),
):
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conditions = ["room_id=?"]
    params: list = [room_id]
    if type:
        conditions.append("event_type=?")
        params.append(type)
    if time_from:
        conditions.append("timestamp>=?")
        params.append(time_from)
    if time_to:
        conditions.append("timestamp<=?")
        params.append(time_to)
    if user_name:
        conditions.append("user_name=?")
        params.append(user_name)
    # exclude silver coin gifts (free gifts like 辣条)
    conditions.append("extra_json NOT LIKE '%\"coin_type\": \"silver\"%'")
    where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
    rows = conn.execute(
        f"SELECT * FROM events{where} ORDER BY id DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@router.get("/api/stats")
async def get_stats(room_id: int = Query(...), _=Depends(require_room_access)):
    conn = sqlite3.connect(str(DB_PATH))
    rp = [room_id]
    total = conn.execute("SELECT COUNT(*) FROM events WHERE room_id=?", rp).fetchone()[0]
    danmu_count = conn.execute("SELECT COUNT(*) FROM events WHERE event_type='danmu' AND room_id=?", rp).fetchone()[0]
    gift_count = conn.execute("SELECT COUNT(*) FROM events WHERE event_type='gift' AND room_id=?", rp).fetchone()[0]
    sc_count = conn.execute("SELECT COUNT(*) FROM events WHERE event_type='superchat' AND room_id=?", rp).fetchone()[0]
    guard_count = conn.execute("SELECT COUNT(*) FROM events WHERE event_type='guard' AND room_id=?", rp).fetchone()[0]
    sc_rows = conn.execute("SELECT extra_json FROM events WHERE event_type='superchat' AND room_id=?", rp).fetchall()
    sc_total = 0
    for row in sc_rows:
        try:
            extra = json.loads(row[0])
            sc_total += extra.get("price", 0)
        except Exception:
            pass
    conn.close()
    client = manager.get(room_id)
    pop = client.popularity if client else 0
    return {
        "total": total, "danmu": danmu_count, "gift": gift_count,
        "superchat": sc_count, "guard": guard_count, "sc_total_price": sc_total,
        "popularity": pop,
    }


def _build_gift_users(rows, sort_by: str = "value") -> dict:
    users: dict = {}
    for user_name, user_id, extra_json in rows:
        extra = json.loads(extra_json)
        key = user_name or str(user_id)
        if key not in users:
            users[key] = {
                "user_name": user_name, "avatar": extra.get("avatar", ""),
                "gifts": {}, "gift_coins": {}, "gift_imgs": {}, "gift_actions": {},
                "guard_level": 0, "total_coin": 0, "gift_ids": {},
            }
        gift_name = extra.get("gift_name", "?")
        num = extra.get("num", 1)
        users[key]["gifts"][gift_name] = users[key]["gifts"].get(gift_name, 0) + num
        tc = extra.get("total_coin", 0)
        users[key]["total_coin"] += tc
        users[key]["gift_coins"][gift_name] = users[key]["gift_coins"].get(gift_name, 0) + tc
        if not users[key]["avatar"] and extra.get("avatar"):
            users[key]["avatar"] = extra["avatar"]
        gift_img = extra.get("gift_img", "")
        if gift_img and gift_name not in users[key]["gift_imgs"]:
            users[key]["gift_imgs"][gift_name] = gift_img
        action = extra.get("action", "投喂")
        blind_name = extra.get("blind_name", "")
        if gift_name not in users[key]["gift_actions"]:
            users[key]["gift_actions"][gift_name] = f"{blind_name} 爆出" if blind_name else action
        gid = extra.get("gift_id", 0)
        if gid and gift_name not in users[key]["gift_ids"]:
            users[key]["gift_ids"][gift_name] = gid
        gif_url = extra.get("gift_gif", "")
        if gif_url and gift_name not in users[key].get("gift_gifs", {}):
            users[key].setdefault("gift_gifs", {})[gift_name] = gif_url
        gl = extra.get("guard_level", 0)
        if gl and (not users[key]["guard_level"] or gl < users[key]["guard_level"]):
            users[key]["guard_level"] = gl

    if sort_by == "tier":
        def _tier(battery: float) -> int:
            if battery >= 10000: return 0  # gold (≥1000元)
            if battery >= 5000: return 1   # pink (≥500元)
            if battery >= 1000: return 2   # purple (≥100元)
            return 3                        # blue

        for u in users.values():
            sorted_names = sorted(
                u["gifts"].keys(),
                key=lambda n: (_tier(u["gift_coins"].get(n, 0)), -(u["gift_coins"].get(n, 0))),
            )
            u["gifts"] = {n: u["gifts"][n] for n in sorted_names}
            u["gift_coins"] = {n: u["gift_coins"][n] for n in sorted_names if n in u["gift_coins"]}

    return users


@router.get("/api/gift-summary")
async def gift_summary(
    room_id: int = Query(...),
    date: Optional[str] = Query(None),
    user_name: Optional[str] = Query(None),
    blind_only: bool = Query(False),
    sort: str = Query("value"),
    _=Depends(require_room_access),
):
    beijing_tz = timezone(timedelta(hours=8))
    conn = sqlite3.connect(str(DB_PATH))
    if date:
        where = "event_type='gift' AND room_id=? AND timestamp LIKE ? AND extra_json NOT LIKE '%\"coin_type\": \"silver\"%'"
        params: list = [room_id, date + "%"]
    else:
        now_bj = datetime.now(beijing_tz)
        bj_start = now_bj.replace(hour=0, minute=0, second=0, microsecond=0)
        bj_end = bj_start + timedelta(days=1)
        utc_start = bj_start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        utc_end = bj_end.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        where = "event_type='gift' AND room_id=? AND timestamp >= ? AND timestamp < ? AND extra_json NOT LIKE '%\"coin_type\": \"silver\"%'"
        params = [room_id, utc_start, utc_end]
    if user_name:
        where += " AND user_name=?"
        params.append(user_name)
    if blind_only:
        where += " AND extra_json LIKE '%blind_name%' AND extra_json NOT LIKE '%\"blind_name\": \"\"%'"
    rows = conn.execute(f"SELECT user_name, user_id, extra_json FROM events WHERE {where}", params).fetchall()
    conn.close()

    users = _build_gift_users(rows, sort_by=sort)
    result = sorted(users.values(), key=lambda x: x["total_coin"], reverse=True)
    display_date = date if date else datetime.now(beijing_tz).strftime("%Y-%m-%d")
    return {"date": display_date, "users": result}


def _beijing_time_range(period: str) -> tuple[str, str, str]:
    """Return (utc_start, utc_end, display_label) for a given period in Beijing time."""
    beijing_tz = timezone(timedelta(hours=8))
    now_bj = datetime.now(beijing_tz)
    if period == "yesterday":
        day = now_bj - timedelta(days=1)
        start = day.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
        label = start.strftime("%Y-%m-%d")
    elif period == "this_month":
        start = now_bj.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        end = now_bj.replace(hour=23, minute=59, second=59, microsecond=0) + timedelta(seconds=1)
        label = start.strftime("%Y-%m")
    elif period == "last_month":
        first_this = now_bj.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        last_month_end = first_this
        last_month_start = (first_this - timedelta(days=1)).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        start = last_month_start
        end = last_month_end
        label = start.strftime("%Y-%m")
    else:  # today
        start = now_bj.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
        label = start.strftime("%Y-%m-%d")
    utc_start = start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    utc_end = end.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return utc_start, utc_end, label


@router.get("/api/blind-box-summary")
async def blind_box_summary(
    room_id: int = Query(...),
    period: str = Query("today"),
    user_name: Optional[str] = Query(None),
    _=Depends(require_room_access),
):
    utc_start, utc_end, label = _beijing_time_range(period)
    conn = sqlite3.connect(str(DB_PATH))
    where = "event_type='gift' AND room_id=? AND timestamp >= ? AND timestamp < ? AND extra_json LIKE '%blind_name%' AND extra_json NOT LIKE '%\"blind_name\": \"\"%'"
    params: list = [room_id, utc_start, utc_end]
    if user_name:
        where += " AND user_name=?"
        params.append(user_name)
    rows = conn.execute(f"SELECT user_name, user_id, extra_json FROM events WHERE {where}", params).fetchall()
    conn.close()

    users: dict[str, dict] = {}
    for uname, uid, extra_json in rows:
        try:
            extra = json.loads(extra_json)
        except (json.JSONDecodeError, TypeError):
            continue
        blind_name = extra.get("blind_name", "")
        if not blind_name:
            continue
        key = f"{uid}_{uname}"
        if key not in users:
            users[key] = {
                "user_name": uname, "user_id": uid,
                "avatar": extra.get("avatar", ""),
                "total_boxes": 0, "total_cost": 0, "total_value": 0,
                "boxes": {},
            }
        if extra.get("avatar"):
            users[key]["avatar"] = extra["avatar"]
        num = extra.get("num", 1)
        price = extra.get("price", 0)
        blind_price = extra.get("blind_price", 0)
        gift_name = extra.get("gift_name", "")

        users[key]["total_boxes"] += num
        users[key]["total_cost"] += blind_price * num
        users[key]["total_value"] += price * num

        box_key = blind_name
        if box_key not in users[key]["boxes"]:
            users[key]["boxes"][box_key] = {"name": blind_name, "count": 0, "cost": 0, "value": 0, "gifts": {}}
        users[key]["boxes"][box_key]["count"] += num
        users[key]["boxes"][box_key]["cost"] += blind_price * num
        users[key]["boxes"][box_key]["value"] += price * num

        if gift_name not in users[key]["boxes"][box_key]["gifts"]:
            users[key]["boxes"][box_key]["gifts"][gift_name] = {"count": 0, "value": 0, "img": extra.get("gift_img", "")}
        users[key]["boxes"][box_key]["gifts"][gift_name]["count"] += num
        users[key]["boxes"][box_key]["gifts"][gift_name]["value"] += price * num

    result = sorted(users.values(), key=lambda x: x["total_boxes"], reverse=True)
    for u in result:
        u["profit"] = u["total_value"] - u["total_cost"]
        for box in u["boxes"].values():
            box["profit"] = box["value"] - box["cost"]
            box["gifts"] = sorted(box["gifts"].values(), key=lambda x: x["value"], reverse=True)
        u["boxes"] = list(u["boxes"].values())

    return {"period": label, "users": result}


@router.get("/api/gift-gif")
async def get_gift_gif(gift_id: int = Query(...)):
    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute(
        "SELECT extra_json FROM events WHERE event_type='gift' AND extra_json LIKE ? LIMIT 1",
        (f'%"gift_id": {gift_id}%',),
    ).fetchone()
    conn.close()
    gif_url = ""
    if row:
        try:
            extra = json.loads(row[0])
            gif_url = extra.get("gift_gif", "")
        except (json.JSONDecodeError, TypeError):
            pass
    return {"gift_id": gift_id, "gif": gif_url}

