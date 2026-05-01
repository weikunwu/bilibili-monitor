"""管理员 API

权限分两档：
  • admin: 全部管理功能（用户/房间 CRUD + 改角色 + 续费码 + 默认机器人）
  • staff: 普通用户 + 续费码（发/看列表），其它拒绝
"""

import asyncio
import math
import random
import sqlite3
import time

import aiohttp
import requests as req
from fastapi import APIRouter, Depends, Query, Request, HTTPException

from ..auth import require_admin, require_admin_or_staff
from ..bili_client import BiliLiveClient
from ..config import (
    HEADERS, MASTER_INFO_API, QR_GENERATE_API, QR_POLL_API, ROOM_INFO_API, log,
)
from ..crypto import encrypt_cookies
from ..db import (
    list_users, create_user, delete_user, assign_user_rooms, update_user_role,
    add_room as db_add_room, remove_room as db_remove_room, get_all_rooms,
    create_renewal_token, list_renewal_tokens,
    list_default_bots, upsert_default_bot, update_default_bot_name,
)
from ..manager import manager

router = APIRouter()
admin_dep = [Depends(require_admin)]
staff_dep = [Depends(require_admin_or_staff)]


@router.get("/api/admin/users", dependencies=admin_dep)
async def get_users():
    return list_users()


@router.post("/api/admin/users", dependencies=admin_dep)
async def add_user(request: Request):
    body = await request.json()
    email = body["email"].strip().lower()
    password = body["password"]
    role = body.get("role", "user")
    if role not in ("admin", "staff", "user"):
        raise HTTPException(400, "角色不合法")
    try:
        return create_user(email, password, role)
    except sqlite3.IntegrityError:
        raise HTTPException(400, "该邮箱已存在")


@router.delete("/api/admin/users/{user_id}", dependencies=admin_dep)
async def remove_user(user_id: int):
    delete_user(user_id)
    return {"ok": True}


@router.post("/api/admin/users/{user_id}/rooms", dependencies=admin_dep)
async def set_user_rooms(user_id: int, request: Request):
    body = await request.json()
    room_ids = body["room_ids"]
    assign_user_rooms(user_id, room_ids)
    return {"ok": True, "room_ids": room_ids}


@router.put("/api/admin/users/{user_id}/role", dependencies=admin_dep)
async def set_user_role(user_id: int, request: Request):
    body = await request.json()
    role = body.get("role", "")
    if role not in ("admin", "staff", "user"):
        raise HTTPException(400, "角色不合法")
    update_user_role(user_id, role)
    return {"ok": True, "role": role}


# ── Room management ──

@router.post("/api/admin/rooms", dependencies=admin_dep)
async def add_room(request: Request):
    body = await request.json()
    room_id = int(body["room_id"])
    existing = [r[0] for r in get_all_rooms()]
    if room_id in existing:
        raise HTTPException(400, "该房间已存在")
    db_add_room(room_id)
    # Create an in-memory client and fetch room info immediately
    client = manager.add_room(room_id)
    await client.ensure_info()
    return {"ok": True, "room_id": room_id}


# 每 bot 分到的点赞目标：对齐 B 站每号每房每天 1000 的限制。
# 注意 BiliLiveClient.LIKE_MAX_TOTAL=1500 是单次 send_likes 的硬上限（含 buffer，
# 因为上报数量与实际入账不是 1:1），分配口径用这个 1000。
_LIKE_PER_BOT_TARGET = 1000
# 同一目标房间互斥：dispatch 期间不允许重复触发（避免多 bot 撞同一房间）
_like_dispatch_running: set[int] = set()


async def _resolve_room_info(room_id: int) -> tuple[int, int, str, str]:
    """display room_id → (real_room_id, streamer_uid, room_title, streamer_name)。
    托管房间走现有 BiliLiveClient（避免重复打 API）；非托管直接打 ROOM_INFO_API。
    无副作用——不写 DB、不动 manager。"""
    if room_id <= 0:
        raise HTTPException(400, "请输入有效房间号")
    target = manager.get(room_id)
    if target:
        if not target.streamer_uid:
            await target.ensure_info()
        if target.streamer_uid:
            return (
                target.real_room_id, target.streamer_uid,
                target.room_title or "", target.streamer_name or "",
            )
    async with aiohttp.ClientSession(headers=HEADERS) as session:
        async with session.get(ROOM_INFO_API, params={"room_id": room_id}) as resp:
            data = await resp.json(content_type=None)
        if data.get("code") != 0:
            raise HTTPException(400, f"房间号无效: {data.get('message') or data.get('code')}")
        info = data.get("data") or {}
        real_room_id = int(info.get("room_id") or room_id)
        streamer_uid = int(info.get("uid") or 0)
        room_title = info.get("title") or ""
        if not streamer_uid:
            raise HTTPException(400, "未取到目标房间主播 UID")
        streamer_name = ""
        try:
            async with session.get(MASTER_INFO_API, params={"uid": streamer_uid}) as resp:
                d = await resp.json(content_type=None)
                if d.get("code") == 0:
                    streamer_name = ((d.get("data") or {}).get("info") or {}).get("uname") or ""
        except Exception:
            pass
        return real_room_id, streamer_uid, room_title, streamer_name


async def _run_likes_dispatch(
    dispatch_room_id: int,
    target_real_room_id: int,
    target_streamer_uid: int,
    selected: list[BiliLiveClient],
    plan: list[int],
    *,
    log_tag: str,
) -> dict:
    """启动后台 task，让 selected[i] 给目标房间刷 plan[i] 次点赞。互斥锁
    用 dispatch_room_id；调用前 caller 已校验过非占用。selected 必须非空，
    每个 bot 已被 caller 标记 _like_running=True。"""
    actual_total = sum(plan)
    avg_interval = (BiliLiveClient.LIKE_BATCH_INTERVAL_LO + BiliLiveClient.LIKE_BATCH_INTERVAL_HI) / 2
    eta_seconds = int((max(plan) / BiliLiveClient.LIKE_BATCH_SIZE) * avg_interval)

    _like_dispatch_running.add(dispatch_room_id)
    bot_summary = ", ".join(
        f"{b.bot_uid}({b.bot_name or '?'}:{n})" for b, n in zip(selected, plan)
    )
    log.info(
        f"[{log_tag}-dispatch] target=room{target_real_room_id}(anchor_uid={target_streamer_uid}) "
        f"total={actual_total} bots={len(selected)} → [{bot_summary}]"
    )

    async def _run_one(bot: BiliLiveClient, n: int):
        log.info(
            f"[{log_tag}] bot={bot.bot_uid}({bot.bot_name or '?'}) → "
            f"target=room{target_real_room_id} 开始 total={n}"
        )
        try:
            await bot.send_likes(
                n, target_room_id=target_real_room_id,
                target_streamer_uid=target_streamer_uid,
            )
        except Exception as e:
            log.warning(f"[{log_tag}] bot={bot.bot_uid} → room={target_real_room_id} 异常: {e}")
        finally:
            bot._like_running = False

    async def _run_all():
        try:
            await asyncio.gather(
                *(_run_one(b, n) for b, n in zip(selected, plan)),
                return_exceptions=True,
            )
        finally:
            _like_dispatch_running.discard(dispatch_room_id)
            log.info(
                f"[{log_tag}-dispatch] target=room{target_real_room_id} 全部 bot 跑完，dispatch 释放"
            )

    asyncio.create_task(_run_all())
    return {
        "scheduled": actual_total,
        "eta_seconds": eta_seconds,
        "bot_count": len(selected),
        "bots": [
            {"uid": b.bot_uid, "name": b.bot_name, "plan": n}
            for b, n in zip(selected, plan)
        ],
    }


def _select_like_candidates() -> list[BiliLiveClient]:
    """默认机器人池里 cookie 完整 + 没在跑别的点赞 + 没在风控冷却。已 shuffle。"""
    candidates = [
        b for b in manager.all_default_bots().values()
        if b.cookies.get("SESSDATA") and b.bot_uid
        and not b._like_running and not b._is_bot_cooling()
    ]
    random.shuffle(candidates)
    return candidates


@router.post("/api/admin/popularity/likes", dependencies=staff_dep)
async def popularity_likes(request: Request):
    """对任意 B 站直播间号刷 N 次点赞。bot 数 = ceil(count/_LIKE_PER_BOT_TARGET)，
    上限是当前可用默认 bot 数；每 bot 分到 ≤ _LIKE_PER_BOT_TARGET。
    房间不必在 manager 里。"""
    body = await request.json()
    try:
        room_id = int(body.get("room_id", 0))
        count = int(body.get("count", 0))
    except (TypeError, ValueError):
        raise HTTPException(400, "room_id / count 必须是整数")
    if count <= 0:
        raise HTTPException(400, "点赞数必须 > 0")
    if room_id in _like_dispatch_running:
        raise HTTPException(409, "该房间正在点赞中，请等当前批次跑完")

    real_room_id, streamer_uid, room_title, streamer_name = await _resolve_room_info(room_id)

    candidates = _select_like_candidates()
    if not candidates:
        raise HTTPException(400, "当前没有可用的默认机器人（全部在跑/冷却中）")
    max_total = len(candidates) * _LIKE_PER_BOT_TARGET
    if count > max_total:
        raise HTTPException(
            400,
            f"点赞数 {count} 超过上限：当前 {len(candidates)} 个可用 bot × "
            f"{_LIKE_PER_BOT_TARGET}/bot = {max_total}",
        )
    n_bots = min(math.ceil(count / _LIKE_PER_BOT_TARGET), len(candidates))
    selected = candidates[:n_bots]
    base, rem = divmod(count, n_bots)
    plan = [
        min(_LIKE_PER_BOT_TARGET, base + (1 if i < rem else 0))
        for i in range(n_bots)
    ]

    for bot in selected:
        bot._like_running = True
    result = await _run_likes_dispatch(
        room_id, real_room_id, streamer_uid, selected, plan, log_tag="人气-点赞",
    )
    return {
        "ok": True, "room_id": room_id, "real_room_id": real_room_id,
        "room_title": room_title, "streamer_name": streamer_name, **result,
    }


@router.delete("/api/admin/rooms/{room_id}", dependencies=admin_dep)
async def remove_room(room_id: int):
    existing = [r[0] for r in get_all_rooms()]
    if room_id not in existing:
        raise HTTPException(404, "房间不存在")
    if manager.has(room_id):
        await manager.remove_room(room_id)
    db_remove_room(room_id)
    return {"ok": True, "room_id": room_id}


# ── Renewal tokens (admin + staff) ──

@router.post("/api/admin/renewal-tokens", dependencies=staff_dep)
async def new_renewal_token(request: Request):
    body = await request.json() if request.headers.get("content-length") else {}
    months = int(body.get("months", 1))
    count = int(body.get("count", 1))
    if months < 1 or months > 12:
        raise HTTPException(400, "months 必须在 1~12")
    if count < 1 or count > 100:
        raise HTTPException(400, "count 必须在 1~100")
    return {"tokens": [create_renewal_token(months) for _ in range(count)]}


@router.get("/api/admin/renewal-tokens", dependencies=staff_dep)
async def get_renewal_tokens():
    return list_renewal_tokens()


# ── 默认机器人池：和具体房间无关，仅 admin 管理 ──
# 用独立的 _qr_sessions 而不是复用 routes/bot.py 的，免得 (qrcode_key →
# room_id) 那套结构跟 (qrcode_key → bot UID 占位) 混到一起；过期 TTL 一致。
_default_bot_qr_sessions: dict[str, tuple[req.Session, float]] = {}
_QR_TTL_SEC = 300


def _gc_default_bot_qr():
    now = time.time()
    for k in [k for k, (_, ts) in _default_bot_qr_sessions.items() if now - ts > _QR_TTL_SEC]:
        _default_bot_qr_sessions.pop(k, None)


# 钱包电池数缓存：{uid: (battery, fetched_at_monotonic)}
# 默认 60s 过期。前端「刷新电池」按钮带 ?force=1 强制绕过缓存。
# 串行拉避免一个 admin 操作就同时炸 N 个请求给 B 站，N 大了风控会注意。
_wallet_cache: dict[int, tuple[int, float]] = {}
_WALLET_TTL_SEC = 60.0


async def _get_battery_cached(client, uid: int, force: bool) -> int | None:
    if not force:
        cached = _wallet_cache.get(uid)
        if cached and time.monotonic() - cached[1] < _WALLET_TTL_SEC:
            return cached[0]
    if not client:
        return None
    w = await client.fetch_wallet_status()
    if not w:
        return None
    battery = int(w.get("gold", 0)) // 100
    _wallet_cache[uid] = (battery, time.monotonic())
    return battery


@router.get("/api/admin/default-bots", dependencies=staff_dep)
async def get_default_bots(force: int = 0):
    """返回 [{uid, name, has_cookie, created_at, in_memory, needs_relogin,
    cooling, battery}]。100 金瓜子 = 1 电池。
    钱包**串行**拉、**带 60s 缓存**：force=1 绕过缓存重拉所有 bot。"""
    rows = list_default_bots()
    out = []
    for r in rows:
        client = manager.default_bot(r["uid"])
        try:
            battery = await _get_battery_cached(client, r["uid"], bool(force))
        except Exception:
            battery = None
        out.append({
            **r,
            "in_memory": client is not None,
            "needs_relogin": bool(client and client._needs_relogin),
            "cooling": bool(client and client._is_bot_cooling()),
            "battery": battery,
        })
    return out


@router.get("/api/admin/default-bots/qrcode", dependencies=staff_dep)
async def default_bot_qrcode():
    _gc_default_bot_qr()
    session = req.Session()
    resp = session.get(QR_GENERATE_API, headers=HEADERS)
    data = resp.json()
    if data.get("code") != 0:
        return {"error": "生成二维码失败"}
    qrcode_key = data["data"]["qrcode_key"]
    _default_bot_qr_sessions[qrcode_key] = (session, time.time())
    return {"url": data["data"]["url"], "qrcode_key": qrcode_key}


@router.get("/api/admin/default-bots/poll", dependencies=staff_dep)
async def default_bot_poll(qrcode_key: str = Query(...)):
    entry = _default_bot_qr_sessions.get(qrcode_key)
    if not entry:
        return {"code": -1, "message": "请先获取二维码"}
    session, _ts = entry
    resp = session.get(QR_POLL_API, params={"qrcode_key": qrcode_key}, headers=HEADERS)
    poll_data = resp.json().get("data", {})
    code = poll_data.get("code", -1)

    if code == 0:
        cookies = {}
        for key in ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"):
            val = session.cookies.get(key) or resp.cookies.get(key)
            if val:
                cookies[key] = val
        rt = poll_data.get("refresh_token") or ""
        if rt:
            cookies["refresh_token"] = rt
        try:
            uid = int(cookies.get("DedeUserID", 0))
        except (TypeError, ValueError):
            uid = 0
        if not uid or not cookies.get("SESSDATA"):
            return {"code": -1, "message": "登录信息不全，请重试"}
        encrypted = encrypt_cookies(cookies)
        upsert_default_bot(uid, "", encrypted)
        client = manager.add_default_bot(uid, cookies)
        # 拉一次 NAV_API 把 bot_name 填上，前端列表才能显示昵称
        await client.refresh_bot_identity()
        if client.bot_name:
            update_default_bot_name(uid, client.bot_name)
        _default_bot_qr_sessions.pop(qrcode_key, None)
        log.info(f"[default-bot] 扫码绑定成功 UID={uid} name={client.bot_name!r}")
        return {"code": 0, "message": "绑定成功", "uid": uid, "name": client.bot_name}
    elif code == 86101:
        return {"code": 86101, "message": "等待扫码"}
    elif code == 86090:
        return {"code": 86090, "message": "已扫码，请确认"}
    elif code == 86038:
        _default_bot_qr_sessions.pop(qrcode_key, None)
        return {"code": 86038, "message": "二维码已过期"}
    else:
        return {"code": code, "message": "未知状态"}


@router.delete("/api/admin/default-bots/{uid}", dependencies=staff_dep)
async def remove_default_bot(uid: int):
    if manager.default_bot(uid) is None and uid not in {b["uid"] for b in list_default_bots()}:
        raise HTTPException(404, "机器人不存在")
    manager.remove_default_bot(uid)
    _wallet_cache.pop(uid, None)
    return {"ok": True, "uid": uid}


# ── 充值（B 站 直播间金瓜子）──
# 流程：管理员在前端选金额 + 渠道（QR=支付宝/微信扫码 / cash=PayPal/信用卡）
# 后端用 bot cookie 调 B 站 createQrCodeOrder / createCashOrder，把支付页 url
# 或 pay_center_params 返给前端去开新 tab 完成支付。前端轮询 queryOrderStatus
# 直到付款完成，再调 myGoldWallet 刷新电池数。
# 1 元 = 1000 金瓜子 = 10 电池；接口里 pay_cash 单位是金瓜子、goods_num 是元数。

_RECHARGE_QR_API = "https://api.live.bilibili.com/xlive/revenue/v1/order/createQrCodeOrder"
_RECHARGE_CASH_API = "https://api.live.bilibili.com/xlive/revenue/v1/order/createCashOrder"
_RECHARGE_QUERY_API = "https://api.live.bilibili.com/xlive/revenue/v1/order/queryOrderStatus"


async def _recharge_headers(client) -> dict:
    """充值 / 查单 复用一套 headers。
    重点：必须像 send_likes 那样带上 buvid3+buvid4，否则风控直接 -352
    （B站 web 真实流量里这两个 cookie 一直在）。"""
    await client._ensure_buvid_pair()
    headers = client._make_cookie_header()
    if client.buvid3 and client.buvid4:
        existing = headers.get("Cookie", "")
        sep = "; " if existing else ""
        headers["Cookie"] = f"{existing}{sep}buvid3={client.buvid3}; buvid4={client.buvid4}"
    headers["Content-Type"] = "application/x-www-form-urlencoded"
    headers["Origin"] = "https://live.bilibili.com"
    # 任意房间号都行，B 站只校验是 live.bilibili.com 子域；用一个固定常驻房间。
    headers["Referer"] = "https://live.bilibili.com/1"
    return headers


@router.post("/api/admin/default-bots/{uid}/recharge", dependencies=staff_dep)
async def recharge_default_bot(uid: int, request: Request):
    """下单。body: {yuan: int, channel: 'qr' | 'cash'}.
    返回 {order_id, code_url?, pay_center_params?, expire}。"""
    body = await request.json()
    try:
        yuan = int(body.get("yuan", 0))
    except (TypeError, ValueError):
        raise HTTPException(400, "金额必须是整数")
    channel = body.get("channel", "qr")
    if channel not in ("qr", "cash"):
        raise HTTPException(400, "channel 必须是 'qr' 或 'cash'")
    # B 站 充值面板最大档位 19980 元；这里保守限到 1998 元（最大单档）。
    if yuan < 1 or yuan > 1998:
        raise HTTPException(400, "金额需在 1~1998 元")

    client = manager.default_bot(uid)
    if not client or not client.cookies.get("SESSDATA"):
        raise HTTPException(404, "机器人不存在或未登录")
    csrf = client.cookies.get("bili_jct", "")
    if not csrf:
        raise HTTPException(400, "csrf (bili_jct) 缺失")

    pay_cash = yuan * 1000  # 金瓜子
    form = {
        "platform": "pc",
        "pay_cash": str(pay_cash),
        "context_id": "1",
        "context_type": "10",
        "goods_id": "1",
        "goods_num": str(yuan),
        "goods_type": "2",
        "live_statistics": '{"pc_client":"pcWeb","jumpfrom":"-99998","room_category":"-99998","trackid":"-999998"}',
        "statistics": '{"platform":0,"pc_client":"pcWeb"}',
        "ios_bp": "0",
        "common_bp": "0",
        "csrf_token": csrf,
        "csrf": csrf,
        "visit_id": "",
    }
    if channel == "qr":
        form["build"] = "0"
        form["pay_bp"] = "0"
        url = _RECHARGE_QR_API
    else:
        url = _RECHARGE_CASH_API

    async with aiohttp.ClientSession(headers=await _recharge_headers(client)) as session:
        async with session.post(url, data=form) as resp:
            data = await resp.json(content_type=None)
            if data.get("code") != 0:
                log.warning(
                    f"[recharge] uid={uid} channel={channel} yuan={yuan} 下单失败: {data}"
                )
                raise HTTPException(400, f"B站下单失败: {data.get('message')!r} code={data.get('code')}")
            d = data.get("data") or {}
            log.info(
                f"[recharge] uid={uid} channel={channel} yuan={yuan} order_id={d.get('order_id')}"
            )
            return {
                "order_id": d.get("order_id"),
                "code_url": d.get("code_url", ""),
                "pay_center_params": d.get("pay_center_params"),
                "expire": int(d.get("expire", 300)),
            }


# ── 人气票批量投递 ──
# admin 在房间卡里输入数量，按"每 bot 每房间每整点小时段 200 张"的 B 站限制拆
# 到多个默认机器人上**串行**送出。
# gift_id 直接硬编码 33988 + price 100 金瓜子（= 1 电池/张）：实测线上数据
# 看 33988 是全平台通用主流款；少数房会出现 34003 / 34102 变种但占比极小，
# 不值得每次 admin 操作多打一发 roomGiftConfig API。
# 额度计帐进程内 dict，重启清零。

_POPULARITY_GIFT_ID = 33988
_POPULARITY_GIFT_PRICE = 100  # 金瓜子；100 金瓜子 = 1 电池
_POPULARITY_PER_BOT_HOURLY = 200
# {room_id: {hour_bucket: {bot_uid: count_sent}}}；hour_bucket = epoch // 3600
_popularity_used: dict[int, dict[int, dict[int, int]]] = {}


def _popularity_room_buckets(room_id: int) -> dict[int, int]:
    """返回该房间当前小时桶的 {bot_uid: count_sent}，并清掉已过期的桶。"""
    bucket = int(time.time() // 3600)
    room = _popularity_used.setdefault(room_id, {})
    for k in list(room.keys()):
        if k < bucket:
            del room[k]
    return room.setdefault(bucket, {})


def _popularity_bot_remaining(room_id: int, bot_uid: int) -> int:
    used = _popularity_room_buckets(room_id).get(bot_uid, 0)
    return max(0, _POPULARITY_PER_BOT_HOURLY - used)


def _popularity_record(room_id: int, bot_uid: int, count: int) -> None:
    bm = _popularity_room_buckets(room_id)
    bm[bot_uid] = bm.get(bot_uid, 0) + count


def _eligible_default_bots() -> list[BiliLiveClient]:
    """默认机器人池里 cookie/uid 完整、不需重扫、不在冷却的可用 bot。
    按 bot_uid 去重——同一 UID 出现多次（理论上 manager dict 已用 UID 索引
    不会重复，但保留这一层防御性去重，未来若加入 target room bot 等其它来源
    也能用同一函数）。"""
    seen: set[int] = set()
    out: list[BiliLiveClient] = []
    for b in manager.all_default_bots().values():
        if not b.cookies.get("SESSDATA") or not b.bot_uid:
            continue
        if b.bot_uid in seen:
            continue
        if b._needs_relogin or b._is_bot_cooling():
            continue
        seen.add(b.bot_uid)
        out.append(b)
    return out


# 多 bot 之间的随机间隔（秒）：单 bot 内部已经按 GIFT_BATCH_INTERVAL_*
# 隔开了，bot 与 bot 之间再加一道，避免连环 POST 被 IP 维度盯上。
_POPULARITY_BOT_GAP_LO = 2.0
_POPULARITY_BOT_GAP_HI = 4.0


async def _run_popularity_vote(
    accounting_room_id: int,
    target_real_room: int,
    target_streamer_uid: int,
    count: int,
) -> dict:
    """串行从默认池给目标房间送 N 张人气票。剩余额度大的 bot 先送，
    每 bot 这小时对该房间最多 _POPULARITY_PER_BOT_HOURLY 张；命中风控/电池不够
    跳下个；全失败 raise 4xx，部分成功 ok=True。
    accounting_room_id 用于本进程内的 hourly 计帐桶（display ID 即可）。"""
    if count < 100 or count % 100 != 0:
        raise HTTPException(400, "数量必须是 100 的整数倍（最小 100）")

    gift_id = _POPULARITY_GIFT_ID
    gift_price = _POPULARITY_GIFT_PRICE

    # 候选 bot：(bot, 这小时剩余额度, 钱包金瓜子)。剩余额度 = 200 − 已送；
    # 钱包决定它最多送得起多少张；两者取 min 才是真正的可送上限。
    bots = _eligible_default_bots()
    if not bots:
        raise HTTPException(400, "默认机器人池为空 / 全部冷却或需重扫")

    candidates: list[tuple[BiliLiveClient, int, int]] = []  # (bot, cap, gold)
    for bot in bots:
        rem = _popularity_bot_remaining(accounting_room_id, bot.bot_uid)
        if rem <= 0:
            continue
        wallet = await bot.fetch_wallet_status()
        gold = int(wallet.get("gold", 0))
        max_affordable = gold // gift_price
        cap = min(rem, max_affordable)
        if cap <= 0:
            continue
        candidates.append((bot, cap, gold))

    if not candidates:
        raise HTTPException(400, "所有默认机器人本小时额度耗尽或电池不够")

    total_capacity = sum(c[1] for c in candidates)
    if count > total_capacity:
        raise HTTPException(
            429,
            f"本小时累计可送 {total_capacity} 张（请求 {count} 张）。"
            f"每 bot 每房间每小时上限 {_POPULARITY_PER_BOT_HOURLY}，可用 bot {len(candidates)} 个",
        )

    # 串行：剩余额度多的 bot 先送，省得反复换
    candidates.sort(key=lambda x: x[1], reverse=True)
    log.info(
        f"[人气票] room={target_real_room} 请求={count} gift_id={gift_id} "
        f"price={gift_price} 候选 bot={len(candidates)} 串行送"
    )

    sent_total = 0
    used_bots: list[dict] = []
    failures: list[dict] = []
    aborted_by_cooling = False
    for idx, (bot, cap, _gold) in enumerate(candidates):
        if sent_total >= count:
            break
        send_n = min(cap, count - sent_total)
        # 单 bot 内部走 send_gift_batches：拆 ≤GIFT_BATCH_SIZE 张/批，批间
        # 1.5–3s 间隔，命中风控时把 cooling 信号往上抛。
        result = await bot.send_gift_batches(
            gift_id=gift_id, gift_price=gift_price, total=send_n,
            target_room_id=target_real_room,
            target_streamer_uid=target_streamer_uid,
            log_tag="人气票",
        )
        sent = int(result.get("sent", 0))
        if sent > 0:
            _popularity_record(accounting_room_id, bot.bot_uid, sent)
            _wallet_cache.pop(bot.bot_uid, None)
            sent_total += sent
            used_bots.append({"uid": bot.bot_uid, "name": bot.bot_name, "sent": sent})
        if sent < send_n:
            failures.append({
                "uid": bot.bot_uid, "name": bot.bot_name,
                "tried": send_n, "sent": sent,
                "error": str(result.get("last_error", "")),
                "cooling": bool(result.get("cooling")),
            })
        # 命中硬风控：B 站从 IP/账号关联维度可能盯上了，让后续 bot 也别再
        # 撞同一道墙。直接 break，剩下的没送的算请求未完成。
        if result.get("cooling"):
            aborted_by_cooling = True
            log.warning(
                f"[人气票] room={target_real_room} bot={bot.bot_uid} 命中风控，"
                f"提前终止后续 {len(candidates) - idx - 1} 个 bot"
            )
            break
        # bot 与 bot 之间随机间隔，避免紧邻的 POST 被 IP 维度盯上
        if idx < len(candidates) - 1 and sent_total < count:
            await asyncio.sleep(random.uniform(
                _POPULARITY_BOT_GAP_LO, _POPULARITY_BOT_GAP_HI,
            ))

    if sent_total == 0:
        # 全部失败 → 4xx 把首例错误提到前端
        msg = "全部失败"
        if failures:
            f = failures[0]
            msg = f"全部失败，首例: {f['name'] or f['uid']} {f['error']}"
        raise HTTPException(400, msg)

    return {
        "ok": True,
        "requested": count,
        "sent": sent_total,
        "aborted_by_cooling": aborted_by_cooling,
        "gift_id": gift_id,
        "gift_price": gift_price,
        "bots": used_bots,
        "failures": failures,
        "total_remaining_this_hour": sum(
            _popularity_bot_remaining(accounting_room_id, b.bot_uid) for b in bots
        ),
    }


@router.post("/api/admin/rooms/{room_id}/popularity-vote", dependencies=admin_dep)
async def send_popularity_vote(room_id: int, request: Request):
    """房间卡片上的「人气票」按钮：托管房间走这条。"""
    body = await request.json()
    try:
        count = int(body.get("count", 0))
    except (TypeError, ValueError):
        raise HTTPException(400, "数量必须是整数")
    if not manager.get(room_id):
        raise HTTPException(404, "房间不存在")
    real_room_id, streamer_uid, _, _ = await _resolve_room_info(room_id)
    result = await _run_popularity_vote(room_id, real_room_id, streamer_uid, count)
    return {"room_id": room_id, **result}


@router.post("/api/admin/popularity/vote", dependencies=staff_dep)
async def popularity_vote(request: Request):
    """对任意 B 站直播间号送 N 张人气票。房间不必在 manager 里。"""
    body = await request.json()
    try:
        room_id = int(body.get("room_id", 0))
        count = int(body.get("count", 0))
    except (TypeError, ValueError):
        raise HTTPException(400, "room_id / count 必须是整数")
    real_room_id, streamer_uid, room_title, streamer_name = await _resolve_room_info(room_id)
    result = await _run_popularity_vote(room_id, real_room_id, streamer_uid, count)
    return {
        "room_id": room_id, "real_room_id": real_room_id,
        "room_title": room_title, "streamer_name": streamer_name, **result,
    }


@router.get("/api/admin/rooms/{room_id}/popularity-vote/quota", dependencies=admin_dep)
async def get_popularity_quota(room_id: int):
    """前端打开弹窗时拉一次：累计剩余 = Σ 每个可用 bot 的 (200 − 已送)。
    不查钱包（modal 打开时不想拉一圈 wallet API），所以 remaining 是"理论上限"
    而非"实际可送"——电池不够的 bot 也算进去。真实送出的拉去看 sent 字段。"""
    bots = _eligible_default_bots()
    remaining = sum(_popularity_bot_remaining(room_id, b.bot_uid) for b in bots)
    return {
        "remaining": remaining,
        "per_bot_limit": _POPULARITY_PER_BOT_HOURLY,
        "available_bot_count": len(bots),
    }


@router.get("/api/admin/default-bots/{uid}/recharge/status", dependencies=staff_dep)
async def query_recharge_status(uid: int, order_id: str):
    """轮询订单状态。{status: int}。status=1 待支付；付完返回的具体值
    （2 / 3 等）要实测——前端拿到 != 1 就当成功，再调 wallet 刷新电池。"""
    client = manager.default_bot(uid)
    if not client or not client.cookies.get("SESSDATA"):
        raise HTTPException(404, "机器人不存在或未登录")
    csrf = client.cookies.get("bili_jct", "")
    form = {"order_id": order_id, "csrf_token": csrf, "csrf": csrf, "visit_id": ""}
    async with aiohttp.ClientSession(headers=await _recharge_headers(client)) as session:
        async with session.post(_RECHARGE_QUERY_API, data=form) as resp:
            data = await resp.json(content_type=None)
            if data.get("code") != 0:
                raise HTTPException(400, f"查单失败: {data.get('message')!r}")
            d = data.get("data") or {}
            # 付款完成时清缓存，让下次列表请求拉到新电池数（不用等 60s TTL 过期）
            if d.get("status") not in (None, 1):
                _wallet_cache.pop(uid, None)
            return d
