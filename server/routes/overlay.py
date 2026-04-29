"""OBS-overlay 公开接口：主播把"今天最近收到的礼物"叠加到直播画面。

访问无需登录，但必须带合法的 overlay token（由登录用户从房间设置生成）。
token 校验通过后只返回只读的礼物聚合，不含任何账户/密码/cookie。
"""

import asyncio
import json
import sqlite3
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

import aiohttp
from fastapi import APIRouter, HTTPException, Query, Request

from ..config import DB_PATH, HEADERS, ROOM_INFO_API
from ..db import verify_overlay_token, get_overlay_settings, get_live_started_at, is_room_expired
from ..manager import manager


router = APIRouter()

MAX_EVENTS = 20  # 绝对上限；实际 N 由房间设置决定

# ── 速率限制 ──
# 每个 IP 在 60 秒窗口内的调用次数上限（超过返回 429）。
# gifts: 正常 poll 12/min (每 5 秒一次)，留 5x buffer
RATE_LIMIT = {
    "gifts": (60, 60.0),
    "weekly_tasks": (60, 60.0),
}

# 心动每周进度（原名"疯狂星期五"）：直接走 B 站官方接口，数值和直播间里的小组件一致。
CRAZY_FRIDAY_API = "https://api.live.bilibili.com/xlive/custom-activity-interface/general/friday/GetCrazyFridayData"
# 兜底里程碑 —— 接口正常时用接口返回的 collect_task_list，拉不到时用这个。
WEEKLY_TASK_DEFAULT_MILESTONES = [20, 60, 120, 180]
# ── 心动每周进度 per-room 缓存 ──
# 前端 5s poll；10s TTL 保证多观众/多 OBS 共看同一房时 B站 QPS 收敛到 1/10s/room。
# 同房间并发 miss 用 lock 串行化，避免 thundering herd 一起打 B 站。
WEEKLY_CACHE_TTL = 10.0
_weekly_cache: dict[int, tuple[float, dict]] = {}
_weekly_cache_locks: dict[int, asyncio.Lock] = {}
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
    event_id: int, event_type: str, user_name: str, user_id: int,
    content: str, extra_json: str,
) -> dict | None:
    """Convert a single event row into a card item dict for the overlay.

    返回值里 `type` 决定前端用哪个 canvas 渲染器：
      - gift / guard → GiftUser shape，走 generateGiftCard
      - superchat → 扁平的 LiveEvent shape（含 content + extra），走 generateSuperChatCard
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
        # 大航海按等级选模板色：总督=金(≥10000)/提督=紫(≥1000)/舰长=蓝(<1000)
        tier_coin = 10000 if guard_level == 1 else (1000 if guard_level == 2 else 0)
        return {
            "type": "guard",
            "event_id": event_id,
            "user_name": user_name or str(user_id),
            "avatar": extra.get("avatar", ""),
            "gifts": {name: num},
            "gift_coins": {name: tier_coin},
            "gift_imgs": {name: extra.get("gift_img", "")} if extra.get("gift_img") else {},
            "gift_actions": {name: "开通"},
            "gift_ids": {name: 0},
            "guard_level": guard_level,
            "total_coin": total_coin,
        }
    if event_type == "superchat":
        # generateSuperChatCard 读的是 LiveEvent shape：{user_name, content, extra}
        return {
            "type": "superchat",
            "event_id": event_id,
            "user_name": user_name or str(user_id),
            "content": content or "",
            "extra": extra,
        }
    gift_name = extra.get("gift_name", "?")
    num = extra.get("num", 1)
    total_coin = extra.get("total_coin", 0)
    action = extra.get("action", "投喂")
    blind_name = extra.get("blind_name", "")
    action_str = f"{blind_name} 爆出" if blind_name else action
    guard_level = extra.get("guard_level", 0)
    # 卡片颜色按本次事件的价值（total_coin）决定。extra.guard_level 是送礼
    # 用户当前的舰队等级，只是身份信息，不参与颜色计算 —— 之前用 guard_level
    # 覆盖过，导致提督送高价礼物变成紫卡。大航海购买走 event_type=="guard"
    # 分支，不会进到这里。
    tier_coin = total_coin
    return {
        "type": "gift",
        "event_id": event_id,
        "user_name": user_name or str(user_id),
        "avatar": extra.get("avatar", ""),
        "gifts": {gift_name: num},
        "gift_coins": {gift_name: tier_coin},
        "gift_imgs": {gift_name: extra.get("gift_img", "")} if extra.get("gift_img") else {},
        "gift_actions": {gift_name: action_str},
        "gift_ids": {gift_name: extra.get("gift_id", 0)} if extra.get("gift_id") else {},
        "guard_level": guard_level,
        "total_coin": total_coin,
    }


def _pass_filters(event_type: str, extra: dict, settings: dict) -> bool:
    """根据房间设置判断事件是否应展示：
      - 类型：show_gift / show_blind / show_guard / show_superchat
      - 价格：按 price_mode (总价 total_coin / 单价 price) 在 [min_price, max_price] 区间内。
        extra 里 price/total_coin 的单位是"电池"（raw 金瓜子 / 100），
        10 电池 = 1 元；min_price / max_price 以元为单位；0 表示不限。
    """
    if event_type == "guard":
        if not settings.get("show_guard"):
            return False
        total = (extra.get("price", 0) or 0) * (extra.get("num", 1) or 1)
        unit = extra.get("price", 0) or 0
    elif event_type == "superchat":
        if not settings.get("show_superchat"):
            return False
        # SC 的 extra.price 就是电池数，没有 "数量"，total=unit
        total = extra.get("price", 0) or 0
        unit = total
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
    if is_room_expired(room_id):
        raise HTTPException(status_code=410, detail="房间已到期")
    settings = get_overlay_settings(room_id)
    max_events = int(settings.get("max_events") or 10)
    max_events = min(max(max_events, 1), MAX_EVENTS)

    beijing_tz = timezone(timedelta(hours=8))
    now_bj = datetime.now(beijing_tz)
    time_range = settings.get("time_range") or "today"
    if time_range == "week":
        # 本周：以周一 00:00 北京时间为起点
        monday_bj = (now_bj - timedelta(days=now_bj.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
        start_bj = monday_bj
        end_bj = monday_bj + timedelta(days=7)
    elif time_range == "live":
        # 本次直播：以 bili_client 最后一次记录的 LIVE 时间为起点。
        # 如果主播当前没开播（live_started_at 为空），直接返空，不展示任何事件。
        live_iso = get_live_started_at(room_id)
        if not live_iso:
            return {"room_id": room_id, "users": []}
        try:
            live_dt = datetime.fromisoformat(live_iso.replace("Z", "+00:00"))
            if live_dt.tzinfo is None:
                live_dt = live_dt.replace(tzinfo=timezone.utc)
            start_bj = live_dt.astimezone(beijing_tz)
        except ValueError:
            return {"room_id": room_id, "users": []}
        # 结束取现在 + 1 分钟（覆盖未来几秒事件）
        end_bj = now_bj + timedelta(minutes=1)
    else:
        # today
        start_bj = now_bj.replace(hour=0, minute=0, second=0, microsecond=0)
        end_bj = start_bj + timedelta(days=1)
    utc_start = start_bj.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    utc_end = end_bj.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
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
    if settings.get("show_superchat"):
        wanted_types.append("superchat")
    if not wanted_types:
        return {"room_id": room_id, "users": []}

    placeholders = ",".join("?" for _ in wanted_types)
    conn = sqlite3.connect(str(DB_PATH))
    # 多拉一些然后 Python 侧按设置过滤。buffer 要足够大，否则低价礼物会把高价事件
    # 挤出扫描窗口（比如 min_price=500 设置本意是过滤小礼，但小礼在 SQL 阶段没被
    # 过滤掉仍然占扫描名额，导致总督/SC 反而不见了）。单房间一周 qualifying
    # 事件量级在 10³，max_events * 100 足够覆盖；SQLite 在此量级毫秒可完成。
    scan_limit = max_events * 100
    rows = conn.execute(
        f"SELECT id, event_type, user_name, user_id, content, extra_json FROM events "
        f"WHERE event_type IN ({placeholders}) AND room_id=? "
        f"AND timestamp >= ? AND timestamp < ? "
        f"AND COALESCE(json_extract(extra_json, '$.coin_type'), '') != 'silver' "
        f"ORDER BY id DESC LIMIT ?",
        (*wanted_types, room_id, utc_start, utc_end, scan_limit),
    ).fetchall()
    conn.close()

    items: list[dict] = []
    for r in rows:
        event_id, event_type, uname, uid, content, extra_json = r
        try:
            extra = json.loads(extra_json)
        except Exception:
            continue
        if not _pass_filters(event_type, extra, settings):
            continue
        g = _row_to_gift_user(event_id, event_type, uname, uid, content or "", extra_json)
        if g:
            items.append(g)
        if len(items) >= max_events:
            break
    # 字段名保留 "users" 向后兼容（老 overlay 页面里的 key），前端只认 item.type。
    return {
        "room_id": room_id, "users": items,
        "scroll_enabled": bool(settings.get("scroll_enabled", True)),
        "scroll_speed": int(settings.get("scroll_speed") or 40),
    }


async def _resolve_streamer_uid(room_id: int) -> int:
    """Return the streamer's uid (ruid) for a room. 0 if unresolvable.

    先读 manager 里已连接的 client 缓存；没缓存就打 B 站 Room.get_info 拉一次。
    """
    client = manager.get(room_id)
    uid = getattr(client, "streamer_uid", 0) if client else 0
    if uid:
        return int(uid)
    try:
        async with aiohttp.ClientSession(headers=HEADERS, timeout=aiohttp.ClientTimeout(total=8)) as s:
            async with s.get(ROOM_INFO_API, params={"room_id": room_id}) as r:
                d = await r.json(content_type=None)
                if d.get("code") == 0:
                    return int((d.get("data") or {}).get("uid") or 0)
    except Exception:
        pass
    return 0


@router.get("/api/overlay/weekly-tasks/{room_id}")
async def overlay_weekly_tasks(
    room_id: int,
    request: Request,
    token: str = Query(..., description="overlay token, generated from room settings"),
):
    """Return this week's 心动盲盒 progress directly from B站's Crazy Friday API.

    数值和主播直播间里"收集心动盲盒 N/M"小组件一模一样（normal_task_collect_cnt +
    collect_task_list）。不再查我们自己的 events 表 —— 官方接口是唯一真源、
    跟观众实时看到的完全对齐。
    """
    _check_rate(request, "weekly_tasks")
    if not verify_overlay_token(room_id, token):
        raise HTTPException(status_code=403, detail="invalid overlay token")
    if is_room_expired(room_id):
        raise HTTPException(status_code=410, detail="房间已到期")
    # 房间没在监听中就不让 overlay 继续刷 —— 否则 B 站心动接口被空打、主播也会
    # 误以为 overlay 还正常工作但其实弹幕/礼物那一栏已经不再更新。前端收到 409
    # 把卡藏掉但继续 poll，用户再点"开始监听"即可自动恢复。
    client = manager.get(room_id)
    if client is None or not client._running:
        raise HTTPException(status_code=409, detail="房间未开启监听")

    ruid = await _resolve_streamer_uid(room_id)
    if not ruid:
        # 不缓存：ruid 一般只在房间首次启动/断线期间拿不到，下次轮询可能就 OK。
        return {
            "room_id": room_id,
            "count": 0,
            "milestones": WEEKLY_TASK_DEFAULT_MILESTONES,
            "error": "no_streamer_uid",
        }
    return await _get_weekly_tasks_cached(room_id, ruid)


async def _fetch_weekly_tasks(room_id: int, ruid: int) -> dict:
    params = {"room_id": room_id, "ruid": ruid, "config_id": 1}
    try:
        async with aiohttp.ClientSession(headers=HEADERS, timeout=aiohttp.ClientTimeout(total=8)) as s:
            async with s.get(CRAZY_FRIDAY_API, params=params) as r:
                d = await r.json(content_type=None)
    except Exception:
        return {
            "room_id": room_id,
            "count": 0,
            "milestones": WEEKLY_TASK_DEFAULT_MILESTONES,
            "error": "fetch_failed",
        }

    if d.get("code") != 0:
        return {
            "room_id": room_id,
            "count": 0,
            "milestones": WEEKLY_TASK_DEFAULT_MILESTONES,
            "error": f"api_code_{d.get('code')}",
        }

    data = d.get("data") or {}
    proc = (data.get("anchor_process_map") or {}).get(str(ruid)) or {}
    count = int(proc.get("normal_task_collect_cnt") or 0)
    # collect_task_list: [{target, sp_probability, limit, level}, ...] —— 按 target 升序
    task_list = data.get("collect_task_list") or []
    milestones: list[int] = []
    for t in task_list:
        try:
            v = int(t.get("target") or 0)
            if v > 0:
                milestones.append(v)
        except (TypeError, ValueError):
            continue
    milestones.sort()
    if not milestones:
        milestones = list(WEEKLY_TASK_DEFAULT_MILESTONES)

    # 暴击任务（plus_task）字段。前端在 plus_task_status > 0 且 target > 0 时切换到暴击 tracker。
    plus_task_count = int(proc.get("plus_task_collect_cnt") or 0)
    plus_task_target = int(proc.get("plus_task_target_cnt") or 0)
    plus_task_status = int(proc.get("plus_task_status") or 0)

    return {
        "room_id": room_id,
        "count": count,
        "milestones": milestones,
        "blind_gift_name": data.get("blind_gift_name") or "心动盲盒",
        "grand_prize_name": data.get("grand_prize_name") or "",
        "cycle_start_time": data.get("cycle_start_time") or 0,
        "cycle_settlement_time": data.get("cycle_settlement_time") or 0,
        "cycle_end_time": data.get("cycle_end_time") or 0,
        "plus_task_count": plus_task_count,
        "plus_task_target": plus_task_target,
        "plus_task_status": plus_task_status,
        "plus_gift_name": data.get("plus_gift_name") or "",
        "plus_gift_img": data.get("plus_gift_img") or "",
    }


async def _get_weekly_tasks_cached(room_id: int, ruid: int) -> dict:
    """Per-room TTL 缓存 + 单 room 并发锁。

    热路径：缓存命中直接返回，不等锁。miss 时 lock 内 double-check，确保同房间
    并发 miss 只打 B 站 一次，其余请求读刚写入的缓存。错误响应也进缓存，避免
    B 站短暂抖动时反复重试放大压力；TTL 到期自然重试。"""
    now = time.time()
    entry = _weekly_cache.get(room_id)
    if entry and now - entry[0] < WEEKLY_CACHE_TTL:
        return entry[1]
    lock = _weekly_cache_locks.get(room_id)
    if lock is None:
        lock = asyncio.Lock()
        _weekly_cache_locks[room_id] = lock
    async with lock:
        entry = _weekly_cache.get(room_id)
        if entry and time.time() - entry[0] < WEEKLY_CACHE_TTL:
            return entry[1]
        payload = await _fetch_weekly_tasks(room_id, ruid)
        _weekly_cache[room_id] = (time.time(), payload)
        return payload


