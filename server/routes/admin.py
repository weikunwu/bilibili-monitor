"""管理员 API

权限分两档：
  • admin: 全部管理功能（用户/房间 CRUD + 改角色 + 续费码）
  • staff: 普通用户 + 续费码（发/看列表），其它拒绝
"""

import asyncio
import random
import sqlite3

from fastapi import APIRouter, Depends, Request, HTTPException

from ..auth import require_admin, require_admin_or_staff
from ..bili_client import BiliLiveClient
from ..config import log
from ..db import (
    list_users, create_user, delete_user, assign_user_rooms, update_user_role,
    add_room as db_add_room, remove_room as db_remove_room, get_all_rooms,
    create_renewal_token, list_renewal_tokens,
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
    """随机抽 _LIKE_MAX_BOTS 个有 bot cookie 的房间（当前房间的 bot 优先入选），
    每个 bot 给该房间刷 _LIKE_PER_BOT 次点赞。每个 bot 自己限频、并行执行，
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

    # 候选池：有 bot cookie + 没在跑别的点赞 + 没在风控冷却
    candidates = [
        c for c in manager.all_clients().values()
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
        f"{b.bot_uid}({b.bot_name or '?'}@room{b.real_room_id})" for b in selected
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
