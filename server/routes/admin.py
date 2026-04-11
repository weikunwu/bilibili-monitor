"""管理员 API"""

import sqlite3

from fastapi import APIRouter, Depends, Request, HTTPException

from ..config import DB_PATH
from ..auth import require_admin
from ..crypto import hash_password
from ..manager import manager

router = APIRouter(dependencies=[Depends(require_admin)])


@router.get("/api/admin/users")
async def list_users():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT id, email, role, created_at FROM users").fetchall()
    result = []
    for r in rows:
        rooms = [x[0] for x in conn.execute(
            "SELECT room_id FROM user_rooms WHERE user_id = ?", (r["id"],)
        ).fetchall()]
        result.append({**dict(r), "rooms": rooms})
    conn.close()
    return result


@router.post("/api/admin/users")
async def create_user(request: Request):
    body = await request.json()
    email = body["email"].strip().lower()
    password = body["password"]
    role = body.get("role", "user")
    conn = sqlite3.connect(str(DB_PATH))
    try:
        conn.execute(
            "INSERT INTO users (email, password_hash, role) VALUES (?,?,?)",
            (email, hash_password(password), role),
        )
        conn.commit()
        user_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(400, "该邮箱已存在")
    conn.close()
    return {"id": user_id, "email": email, "role": role}


@router.delete("/api/admin/users/{user_id}")
async def delete_user(user_id: int):
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM user_rooms WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@router.post("/api/admin/users/{user_id}/rooms")
async def assign_rooms(user_id: int, request: Request):
    body = await request.json()
    room_ids = body["room_ids"]
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("DELETE FROM user_rooms WHERE user_id = ?", (user_id,))
    for rid in room_ids:
        conn.execute("INSERT INTO user_rooms (user_id, room_id) VALUES (?,?)", (user_id, rid))
    conn.commit()
    conn.close()
    return {"ok": True, "room_ids": room_ids}


# ── Room management ──

@router.post("/api/admin/rooms")
async def add_room(request: Request):
    body = await request.json()
    room_id = int(body["room_id"])
    if manager.has(room_id):
        raise HTTPException(400, "该房间已存在")

    client = manager.add_room(room_id)

    return {
        "ok": True,
        "room_id": room_id,
        "real_room_id": client.real_room_id,
        "streamer_name": client.streamer_name,
    }


@router.delete("/api/admin/rooms/{room_id}")
async def remove_room(room_id: int):
    if not manager.has(room_id):
        raise HTTPException(404, "房间不存在")
    manager.remove_room(room_id)
    return {"ok": True, "room_id": room_id}
