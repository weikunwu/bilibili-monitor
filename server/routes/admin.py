"""管理员 API"""

import sqlite3

from fastapi import APIRouter, Depends, Request, HTTPException

from ..auth import require_admin
from ..db import (
    list_users, create_user, delete_user, assign_user_rooms,
    add_room as db_add_room, remove_room as db_remove_room, get_all_rooms_with_active,
)
from ..manager import manager

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
    existing = [r[0] for r in get_all_rooms_with_active()]
    if room_id in existing:
        raise HTTPException(400, "该房间已存在")
    db_add_room(room_id)
    return {"ok": True, "room_id": room_id}


@router.delete("/api/admin/rooms/{room_id}")
async def remove_room(room_id: int):
    existing = [r[0] for r in get_all_rooms_with_active()]
    if room_id not in existing:
        raise HTTPException(404, "房间不存在")
    if manager.has(room_id):
        manager.remove_room(room_id)
    db_remove_room(room_id)
    return {"ok": True, "room_id": room_id}
