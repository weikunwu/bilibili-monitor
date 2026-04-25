"""管理员 API

权限分两档：
  • admin: 全部管理功能（用户/房间 CRUD + 改角色 + 续费码 + 默认机器人）
  • staff: 普通用户 + 续费码（发/看列表），其它拒绝
"""

import asyncio
import random
import sqlite3
import time

import aiohttp
import requests as req
from fastapi import APIRouter, Depends, Query, Request, HTTPException

from ..auth import require_admin, require_admin_or_staff
from ..bili_client import BiliLiveClient
from ..config import HEADERS, QR_GENERATE_API, QR_POLL_API, log
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


_LIKE_PER_BOT = 1000
_LIKE_MAX_BOTS = 5
# 同一目标房间互斥：dispatch 期间不允许重复触发（避免 5×N 个 bot 撞同一房间）
_like_dispatch_running: set[int] = set()


@router.post("/api/admin/rooms/{room_id}/like", dependencies=admin_dep)
async def trigger_room_likes(room_id: int):
    """从默认机器人池 + 目标房间自己的 bot 里抽 _LIKE_MAX_BOTS 个，每个给目标
    房间刷 _LIKE_PER_BOT 次点赞。目标房间 bot 优先入选；不借用别的监控房间的 bot
    （避免拿别主播的号给本房刷赞影响他们的风控）。每个 bot 自己限频、并行执行，
    dispatch 后台跑；同一目标房间未跑完前重复触发返回 409。"""
    target = manager.get(room_id)
    if not target:
        raise HTTPException(404, "房间不存在")
    if room_id in _like_dispatch_running:
        raise HTTPException(409, "该房间正在点赞中，请等当前批次跑完")
    if not target.streamer_uid:
        await target.ensure_info()
    if not target.streamer_uid:
        raise HTTPException(400, "未取到目标房间主播 UID")
    target_real_room_id = target.real_room_id
    target_streamer_uid = target.streamer_uid

    # 候选池：默认机器人池 + 目标房间自己的 bot；不借用其他监控房间的 bot。
    # 全部要求有 bot cookie + 没在跑别的点赞 + 没在风控冷却。
    pool = list(manager.all_default_bots().values()) + [target]
    candidates = [
        c for c in pool
        if c.cookies.get("SESSDATA") and c.bot_uid
        and not c._like_running and not c._is_bot_cooling()
    ]
    if not candidates:
        raise HTTPException(400, "当前没有可用的机器人（全部未绑定/在跑/冷却中）")

    # 当前房间的 bot 优先入选，剩下从其它候选里随机抽
    if target in candidates:
        others = [c for c in candidates if c is not target]
        random.shuffle(others)
        selected = [target] + others[:_LIKE_MAX_BOTS - 1]
    else:
        random.shuffle(candidates)
        selected = candidates[:_LIKE_MAX_BOTS]

    per_bot = _LIKE_PER_BOT
    avg_interval = (BiliLiveClient.LIKE_BATCH_INTERVAL_LO + BiliLiveClient.LIKE_BATCH_INTERVAL_HI) / 2
    eta_seconds = int((per_bot / BiliLiveClient.LIKE_BATCH_SIZE) * avg_interval)
    total = per_bot * len(selected)

    for bot in selected:
        bot._like_running = True
    _like_dispatch_running.add(room_id)
    bot_summary = ", ".join(
        f"{b.bot_uid}({b.bot_name or '?'}@"
        f"{'default' if b.is_default_bot else f'room{b.real_room_id}'})"
        for b in selected
    )
    log.info(
        f"[批量点赞-dispatch] target=room{target_real_room_id}(anchor_uid={target_streamer_uid}) "
        f"per_bot={per_bot} bots={len(selected)} → [{bot_summary}]"
    )

    async def _run_one(bot: BiliLiveClient):
        log.info(
            f"[批量点赞] bot={bot.bot_uid}({bot.bot_name or '?'}) → target=room{target_real_room_id} 开始 total={per_bot}"
        )
        try:
            await bot.send_likes(
                per_bot,
                target_room_id=target_real_room_id,
                target_streamer_uid=target_streamer_uid,
            )
        except Exception as e:
            log.warning(f"[批量点赞] bot={bot.bot_uid} → room={target_real_room_id} 异常: {e}")
        finally:
            bot._like_running = False

    async def _run_all():
        try:
            await asyncio.gather(*(_run_one(b) for b in selected), return_exceptions=True)
        finally:
            _like_dispatch_running.discard(room_id)
            log.info(f"[批量点赞-dispatch] target=room{target_real_room_id} 全部 bot 跑完，dispatch 释放")

    asyncio.create_task(_run_all())
    return {
        "ok": True, "room_id": room_id,
        "scheduled": total, "eta_seconds": eta_seconds,
        "bot_count": len(selected),
        "bots": [{"uid": b.bot_uid, "name": b.bot_name} for b in selected],
    }


@router.delete("/api/admin/rooms/{room_id}", dependencies=admin_dep)
async def remove_room(room_id: int):
    existing = [r[0] for r in get_all_rooms()]
    if room_id not in existing:
        raise HTTPException(404, "房间不存在")
    if manager.has(room_id):
        manager.remove_room(room_id)
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


@router.get("/api/admin/default-bots", dependencies=admin_dep)
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


@router.get("/api/admin/default-bots/qrcode", dependencies=admin_dep)
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


@router.get("/api/admin/default-bots/poll", dependencies=admin_dep)
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


@router.delete("/api/admin/default-bots/{uid}", dependencies=admin_dep)
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


@router.post("/api/admin/default-bots/{uid}/recharge", dependencies=admin_dep)
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


@router.get("/api/admin/default-bots/{uid}/recharge/status", dependencies=admin_dep)
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
