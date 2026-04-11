"""房间和指令 API"""

import asyncio

from fastapi import APIRouter, Depends, Query, Request, HTTPException
from fastapi.responses import HTMLResponse

from ..db import get_room_commands, save_command_state, get_command, set_room_active
from ..auth import require_room_access

router = APIRouter()


@router.get("/api/rooms")
async def get_rooms(request: Request):
    from ..app import bili_clients
    allowed = getattr(request.state, "allowed_rooms", None)
    return [
        {
            "room_id": c.room_id,
            "real_room_id": c.real_room_id,
            "streamer_name": c.streamer_name,
            "streamer_avatar": c.streamer_avatar,
            "room_title": c.room_title,
            "live_status": c.live_status,
            "ruid": c.ruid,
            "followers": c.followers,
            "guard_count": c.guard_count,
            "area_name": c.area_name,
            "parent_area_name": c.parent_area_name,
            "announcement": c.announcement,
            "bot_uid": c.uid if c.cookies.get("SESSDATA") else 0,
            "active": c._running,
        }
        for c in bili_clients.values()
        if allowed is None or c.room_id in allowed
    ]


@router.get("/api/commands")
async def list_commands(room_id: int = Query(...)):
    return get_room_commands(room_id)


@router.post("/api/rooms/{room_id}/stop")
async def stop_room(room_id: int, _=Depends(require_room_access)):
    from ..app import bili_clients

    if room_id not in bili_clients:
        raise HTTPException(404, "房间不存在")

    client = bili_clients[room_id]
    client.stop()
    set_room_active(room_id, False)
    return {"ok": True, "room_id": room_id}


@router.post("/api/rooms/{room_id}/start")
async def start_room(room_id: int, _=Depends(require_room_access)):
    from ..app import bili_clients

    if room_id not in bili_clients:
        raise HTTPException(404, "房间不存在")

    client = bili_clients[room_id]
    if client._running:
        raise HTTPException(400, "房间已在运行中")

    set_room_active(room_id, True)
    asyncio.create_task(client.run())
    return {"ok": True, "room_id": room_id}


@router.post("/api/commands/{cmd_id}/toggle")
async def toggle_command(cmd_id: str, room_id: int = Query(...)):
    cmd = get_command(room_id, cmd_id)
    if not cmd:
        return HTMLResponse('{"error":"not found"}', status_code=404)
    cmd["enabled"] = not cmd["enabled"]
    save_command_state(room_id, cmd_id, cmd["enabled"])
    return {"id": cmd_id, "room_id": room_id, "enabled": cmd["enabled"]}
