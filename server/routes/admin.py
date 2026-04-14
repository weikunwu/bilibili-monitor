"""管理员 API"""

import asyncio
import sqlite3
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request, HTTPException

from ..auth import require_admin
from ..db import (
    list_users, create_user, delete_user, assign_user_rooms,
    add_room as db_add_room, remove_room as db_remove_room, get_all_rooms,
    save_event,
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
            label = str(t.get("label", "debug"))
            gift_id = int(t.get("gift_id", 0))
            num = int(t.get("num", 1))
            await session.request_clip(
                gift_id=gift_id,
                effect_id=int(t.get("effect_id", 0)),
                label=label,
                num=num,
            )
            # Also drop a synthetic event into the DB so the row shows up in
            # the relevant list (礼物/大航海) with a working 下载录屏 button.
            # user_name must equal `label` so the clips/match endpoint pairs
            # them. Supports three shapes based on payload:
            #   • guard_level > 0 → 大航海 event (total督/提督/舰长)
            #   • blind_name set  → 盲盒爆出 gift event
            #   • else            → plain gift event
            now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            gift_name = t.get("gift_name") or "调试礼物"
            gift_img = t.get("gift_img") or ""
            gift_gif = t.get("gift_gif") or ""
            avatar = t.get("avatar") or ""
            price = int(t.get("price", 22330))
            guard_level = int(t.get("guard_level", 0))
            user_id = int(t.get("user_id", 0)) or 99999999
            if guard_level in (1, 2, 3):
                guard_names = {1: "总督", 2: "提督", 3: "舰长"}
                save_event({
                    "timestamp": now_iso,
                    "event_type": "guard",
                    "user_name": label,
                    "user_id": user_id,
                    "content": "开通",
                    "room_id": room_id,
                    "extra": {
                        "guard_level": guard_level,
                        "guard_name": guard_names[guard_level],
                        "num": num,
                        "price": price,
                        "avatar": avatar,
                        "gift_img": gift_img,
                        "gift_gif": gift_gif,
                    },
                })
            else:
                blind_name = t.get("blind_name") or ""
                save_event({
                    "timestamp": now_iso,
                    "event_type": "gift",
                    "user_name": label,
                    "user_id": user_id,
                    "content": f"{gift_name} x{num}",
                    "room_id": room_id,
                    "extra": {
                        "gift_name": gift_name,
                        "gift_id": gift_id,
                        "num": num,
                        "price": price,
                        "total_coin": price * num,
                        "action": f"{blind_name} 爆出" if blind_name else "投喂",
                        "blind_name": blind_name,
                        "blind_price": int(t.get("blind_price", 0)),
                        "avatar": avatar,
                        "gift_img": gift_img,
                        "gift_gif": gift_gif,
                        "guard_level": 0,
                    },
                })

    asyncio.create_task(_fire())
    return {"ok": True, "room_id": room_id, "triggers": len(triggers)}
