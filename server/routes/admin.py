"""管理员 API"""

import asyncio
import sqlite3

from fastapi import APIRouter, Depends, Request, HTTPException

from ..auth import require_admin
from ..db import (
    list_users, create_user, delete_user, assign_user_rooms,
    add_room as db_add_room, remove_room as db_remove_room, get_all_rooms,
)
from ..manager import manager
from .. import recorder

router = APIRouter(dependencies=[Depends(require_admin)])


@router.get("/api/admin/users")
async def get_users():
    return list_users()


@router.post("/api/admin/users")
async def add_user(request: Request):
    body = await request.json()
    email = body["email"].strip().lower()
    password = body["password"]
    role = body.get("role", "user")
    try:
        return create_user(email, password, role)
    except sqlite3.IntegrityError:
        raise HTTPException(400, "该邮箱已存在")


@router.delete("/api/admin/users/{user_id}")
async def remove_user(user_id: int):
    delete_user(user_id)
    return {"ok": True}


@router.post("/api/admin/users/{user_id}/rooms")
async def set_user_rooms(user_id: int, request: Request):
    body = await request.json()
    room_ids = body["room_ids"]
    assign_user_rooms(user_id, room_ids)
    return {"ok": True, "room_ids": room_ids}


# ── Room management ──

@router.post("/api/admin/rooms")
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


@router.delete("/api/admin/rooms/{room_id}")
async def remove_room(room_id: int):
    existing = [r[0] for r in get_all_rooms()]
    if room_id not in existing:
        raise HTTPException(404, "房间不存在")
    if manager.has(room_id):
        manager.remove_room(room_id)
    db_remove_room(room_id)
    return {"ok": True, "room_id": room_id}


# ── Debug / manual clip trigger ──

@router.post("/api/admin/debug/test-clip")
async def debug_test_clip(request: Request):
    """Manually fire synthetic clip triggers against a running room.

    Body:
        {
          "room_id": <real_room_id>,   # must have an active recorder session
          "triggers": [
            {"gift_id": 35560, "offset_sec": 0,  "label": "shahuang"},
            {"gift_id": 32132, "offset_sec": 10, "label": "castle"},
          ]
        }

    The triggers fire inside the running process (no extra python, no OOM).
    Output lands at data/clips/<room_id>/.
    """
    body = await request.json()
    room_id = int(body.get("room_id", 0))
    triggers = body.get("triggers") or []
    if not room_id or not triggers:
        raise HTTPException(400, "需要 room_id 和 triggers")

    session = recorder.get_session(room_id)
    if not session or not session._running:
        raise HTTPException(404, "房间无活跃录屏 session (需要直播中 + auto_clip 开)")

    async def _fire():
        for t in triggers:
            off = float(t.get("offset_sec", 0))
            if off > 0:
                await asyncio.sleep(off)
            await session.request_clip(
                gift_id=int(t.get("gift_id", 0)),
                effect_id=int(t.get("effect_id", 0)),
                label=str(t.get("label", "debug")),
                num=int(t.get("num", 1)),
            )

    asyncio.create_task(_fire())
    return {"ok": True, "room_id": room_id, "triggers": len(triggers)}
