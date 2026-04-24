"""事件查询、统计、礼物汇总 API"""

import json
import sqlite3
import time
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query

from ..config import DB_PATH, BASE_DIR
from ..auth import require_room_access
from ..manager import manager
from ..time_utils import enforce_query_range

router = APIRouter()

# stats 短 TTL 缓存：每次 save_event 也会 bump room 的版本号，保证数据写入后
# 下一次 /api/stats 立刻看到新值；用户静态看页时 TTL 兜底，避免重复聚合全表。
_STATS_TTL_SEC = 15.0
_stats_cache: dict[int, tuple[float, dict]] = {}


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


def _query_events(
    room_id: int, type: Optional[str], user_name: Optional[str],
    time_from: Optional[str], time_to: Optional[str], limit: int, offset: int,
) -> list[dict]:
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
    conditions.append("COALESCE(coin_type, '') != 'silver'")
    where = " WHERE " + " AND ".join(conditions)
    rows = conn.execute(
        f"SELECT id, room_id, timestamp, event_type, user_name, user_id, content, extra_json "
        f"FROM events{where} ORDER BY id DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


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
    enforce_query_range(time_from, time_to)
    return _query_events(room_id, type, user_name, time_from, time_to, limit, offset)


def _make_typed_endpoint(event_type: str):
    async def handler(
        room_id: int = Query(...),
        user_name: Optional[str] = Query(None),
        limit: int = Query(2000, ge=1, le=5000),
        offset: int = Query(0, ge=0),
        time_from: Optional[str] = Query(None),
        time_to: Optional[str] = Query(None),
        _=Depends(require_room_access),
    ):
        enforce_query_range(time_from, time_to)
        return _query_events(room_id, event_type, user_name, time_from, time_to, limit, offset)
    return handler


for _t in ("danmu", "gift", "guard", "superchat"):
    router.add_api_route(f"/api/events/{_t}", _make_typed_endpoint(_t), methods=["GET"])


def _compute_stats(room_id: int) -> dict:
    """单次 GROUP BY 拿回四类事件的 COUNT；比 5 次独立 COUNT 少 5x 往返。
    SC 的 price 直接 SUM 真列，不再 json_extract。"""
    conn = sqlite3.connect(str(DB_PATH))
    rows = conn.execute(
        "SELECT event_type, COUNT(*) FROM events WHERE room_id=? GROUP BY event_type",
        (room_id,),
    ).fetchall()
    counts = {r[0]: r[1] for r in rows}
    total = sum(counts.values())
    sc_total = conn.execute(
        "SELECT COALESCE(SUM(price), 0) "
        "FROM events WHERE event_type='superchat' AND room_id=?",
        (room_id,),
    ).fetchone()[0] or 0
    conn.close()
    return {
        "total": total,
        "danmu": counts.get("danmu", 0),
        "gift": counts.get("gift", 0),
        "superchat": counts.get("superchat", 0),
        "guard": counts.get("guard", 0),
        "sc_total_price": sc_total,
    }


@router.get("/api/stats")
async def get_stats(room_id: int = Query(...), _=Depends(require_room_access)):
    # TTL 缓存：stats 聚合是纯 COUNT，15 秒内的陈旧数据可接受；popularity 不缓存
    # (由内存 client 取，实时)。
    now = time.time()
    hit = _stats_cache.get(room_id)
    if hit and now - hit[0] < _STATS_TTL_SEC:
        stats = hit[1]
    else:
        stats = _compute_stats(room_id)
        _stats_cache[room_id] = (now, stats)
    client = manager.get(room_id)
    pop = client.popularity if client else 0
    return {**stats, "popularity": pop}


def _gift_summary_sql(where: str, params: list) -> list[tuple]:
    """SQL 侧按 (user_id, gift_name) 聚合礼物事件，避免拉全量 extra_json
    到 Python 再 json.loads 循环汇总。

    数值字段用 SUM 聚合；guard_level 取 "最小非零"（总督=1 优于 舰长=3）；
    展示字段 (avatar/action/blind_name/img) 从该组最早一条事件 (MIN(id))
    的 extra_json 取值 —— 保持与旧的 "first-seen wins" 语义一致。
    """
    conn = sqlite3.connect(str(DB_PATH))
    rows = conn.execute(f"""
        WITH agg AS (
          SELECT
            user_id,
            gift_name AS gn,
            MIN(id) AS first_id,
            SUM(COALESCE(num, 1))                                 AS num_sum,
            SUM(COALESCE(total_coin, 0))                          AS coin_sum,
            MIN(CASE WHEN guard_level > 0 THEN guard_level END)   AS guard_level
          FROM events
          WHERE {where}
          GROUP BY user_id, gift_name
        )
        SELECT
          e.user_name,
          agg.user_id,
          agg.gn,
          agg.num_sum,
          agg.coin_sum,
          json_extract(e.extra_json, '$.avatar'),
          json_extract(e.extra_json, '$.gift_img'),
          json_extract(e.extra_json, '$.gift_gif'),
          CAST(json_extract(e.extra_json, '$.gift_id') AS INTEGER),
          agg.guard_level,
          json_extract(e.extra_json, '$.action'),
          e.blind_name
        FROM agg
        JOIN events e ON e.id = agg.first_id
        ORDER BY agg.first_id
    """, params).fetchall()
    conn.close()
    return rows


def _build_gift_users_from_agg(rows: list[tuple], sort_by: str = "value") -> dict:
    """把 SQL 侧聚合后的行再组装成按用户嵌套的字典（前端期望的形状）。"""
    users: dict = {}
    for (user_name, user_id, gift_name, num_sum, coin_sum, avatar, gift_img,
         gift_gif, gift_id, guard_level, action, blind_name) in rows:
        key = user_id  # 用 uid 去重，避免用户改名后被拆成两行
        u = users.get(key)
        if u is None:
            u = users[key] = {
                "user_name": user_name or str(user_id), "avatar": avatar or "",
                "gifts": {}, "gift_coins": {}, "gift_imgs": {}, "gift_actions": {},
                "guard_level": 0, "total_coin": 0, "gift_ids": {}, "gift_gifs": {},
            }
        gname = gift_name or "?"
        u["gifts"][gname] = num_sum or 0
        # 大航海礼物按等级映射到模板色：总督=金/提督=紫/舰长=蓝。
        # 只有礼物本身是 舰长/提督/总督 时才按等级上色；送礼人自己是
        # 舰长/提督/总督 不影响其它礼物的卡片颜色。
        is_guard_buy = gname in ("舰长", "提督", "总督")
        if is_guard_buy and guard_level:
            u["gift_coins"][gname] = 10000 if guard_level == 1 else (1000 if guard_level == 2 else 0)
        else:
            u["gift_coins"][gname] = coin_sum or 0
        u["total_coin"] += (coin_sum or 0)
        if avatar and not u["avatar"]:
            u["avatar"] = avatar
        if gift_img:
            u["gift_imgs"][gname] = gift_img
        if gift_gif:
            u["gift_gifs"][gname] = gift_gif
        if gift_id:
            u["gift_ids"][gname] = gift_id
        u["gift_actions"][gname] = (
            f"{blind_name} 爆出" if blind_name else (action or "投喂")
        )
        if guard_level and (not u["guard_level"] or guard_level < u["guard_level"]):
            u["guard_level"] = guard_level

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
    if date:
        where = "event_type='gift' AND room_id=? AND timestamp LIKE ? AND COALESCE(coin_type, '') != 'silver'"
        params: list = [room_id, date + "%"]
    else:
        now_bj = datetime.now(beijing_tz)
        bj_start = now_bj.replace(hour=0, minute=0, second=0, microsecond=0)
        bj_end = bj_start + timedelta(days=1)
        utc_start = bj_start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        utc_end = bj_end.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        where = "event_type='gift' AND room_id=? AND timestamp >= ? AND timestamp < ? AND COALESCE(coin_type, '') != 'silver'"
        params = [room_id, utc_start, utc_end]
    if user_name:
        where += " AND user_name=?"
        params.append(user_name)
    if blind_only:
        where += " AND COALESCE(blind_name, '') != ''"

    agg_rows = _gift_summary_sql(where, params)
    users = _build_gift_users_from_agg(agg_rows, sort_by=sort)
    result = sorted(users.values(), key=lambda x: x["total_coin"], reverse=True)
    display_date = date if date else datetime.now(beijing_tz).strftime("%Y-%m-%d")
    return {"date": display_date, "users": result}


@router.get("/api/blind-box-summary")
async def blind_box_summary(
    room_id: int = Query(...),
    time_from: str = Query(...),
    time_to: str = Query(...),
    user_name: Optional[str] = Query(None),
    _=Depends(require_room_access),
):
    enforce_query_range(time_from, time_to)
    utc_start, utc_end = time_from, time_to
    label = f"{time_from[:10]} ~ {time_to[:10]}"
    # SQL 侧按 (user_id, blind_name, gift_name) 聚合，Python 只做最后一层字典嵌套。
    where = (
        "event_type='gift' AND room_id=? AND timestamp >= ? AND timestamp < ? "
        "AND COALESCE(blind_name, '') != ''"
    )
    params: list = [room_id, utc_start, utc_end]
    if user_name:
        where += " AND user_name=?"
        params.append(user_name)

    conn = sqlite3.connect(str(DB_PATH))
    rows = conn.execute(f"""
        SELECT
          MAX(user_name)                                           AS user_name,
          user_id                                                   AS user_id,
          blind_name                                                AS blind_name,
          gift_name                                                 AS gift_name,
          SUM(COALESCE(num, 1))                                     AS num_sum,
          SUM(COALESCE(price, 0) * COALESCE(num, 1))                AS value_sum,
          SUM(COALESCE(json_extract(extra_json, '$.blind_price'), 0) *
              COALESCE(num, 1))                                     AS cost_sum,
          MAX(json_extract(extra_json, '$.avatar'))                 AS avatar,
          MAX(json_extract(extra_json, '$.gift_img'))               AS gift_img
        FROM events
        WHERE {where}
        GROUP BY user_id, blind_name, gift_name
    """, params).fetchall()
    conn.close()

    users: dict = {}
    for uname, uid, blind_name, gift_name, num_sum, value_sum, cost_sum, avatar, gift_img in rows:
        if not blind_name:
            continue
        u = users.get(uid)
        if u is None:
            u = users[uid] = {
                "user_name": uname or "", "user_id": uid,
                "avatar": avatar or "",
                "total_boxes": 0, "total_cost": 0, "total_value": 0,
                "boxes": {},
            }
        if avatar and not u["avatar"]:
            u["avatar"] = avatar
        num = num_sum or 0
        value = value_sum or 0
        cost = cost_sum or 0
        u["total_boxes"] += num
        u["total_cost"] += cost
        u["total_value"] += value

        box = u["boxes"].get(blind_name)
        if box is None:
            box = u["boxes"][blind_name] = {
                "name": blind_name, "count": 0, "cost": 0, "value": 0, "gifts": {},
            }
        box["count"] += num
        box["cost"] += cost
        box["value"] += value

        gname = gift_name or ""
        box["gifts"][gname] = {
            "name": gname, "count": num, "value": value, "img": gift_img or "",
        }

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

