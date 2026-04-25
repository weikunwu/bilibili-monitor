"""管理员 API

权限分两档：
  • admin: 全部管理功能（用户/房间 CRUD + 改角色 + 续费码）
  • staff: 普通用户 + 续费码（发/看列表），其它拒绝
"""

import asyncio
import sqlite3

from fastapi import APIRouter, Depends, Request, HTTPException

from ..auth import require_admin, require_admin_or_staff
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


@router.post("/api/admin/rooms/{room_id}/like", dependencies=admin_dep)
async def trigger_room_likes(room_id: int):
    """用该房间机器人 cookie 上报 1000 次点赞，分批 + 频控。
    长任务后台跑（~30s），HTTP 立即返回；同房间互斥，重复触发返回 409。"""
    client = manager.get(room_id)
    if not client:
        raise HTTPException(404, "房间不存在")
    if not client.cookies.get("SESSDATA") or not client.bot_uid:
        raise HTTPException(400, "该房间未绑定机器人")
    if client._like_running:
        raise HTTPException(409, "该房间正在点赞中，请等当前批次跑完")
    total = 1000
    # 预估时长：批数 × 平均间隔（前端用来锁按钮 + 给提示）
    avg_interval = (client.LIKE_BATCH_INTERVAL_LO + client.LIKE_BATCH_INTERVAL_HI) / 2
    eta_seconds = int((total / client.LIKE_BATCH_SIZE) * avg_interval)
    client._like_running = True

    async def _run():
        try:
            await client.send_likes(total)
        except Exception as e:
            log.warning(f"[批量点赞] room={room_id} 任务异常: {e}")
        finally:
            client._like_running = False

    asyncio.create_task(_run())
    return {
        "ok": True, "room_id": room_id,
        "scheduled": total, "eta_seconds": eta_seconds,
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
