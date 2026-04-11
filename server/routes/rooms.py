"""房间和指令 API"""

from fastapi import APIRouter, Depends, Query, Request, HTTPException
from fastapi.responses import HTMLResponse

from ..db import get_room_commands, save_command_state, get_command, get_all_rooms_with_active
from ..auth import require_room_access
from ..manager import manager

router = APIRouter()


@router.get("/api/rooms")
async def get_rooms(request: Request):
    import asyncio
    allowed = getattr(request.state, "allowed_rooms", None)
    db_rooms = get_all_rooms_with_active()

    # Lazy fetch: ensure room info is loaded for clients that haven't fetched yet
    clients_to_fetch = []
    for room_id, _ in db_rooms:
        if allowed is not None and room_id not in allowed:
            continue
        c = manager.get(room_id)
        if c and not c._info_fetched:
            clients_to_fetch.append(c.ensure_info())
    if clients_to_fetch:
        await asyncio.gather(*clients_to_fetch, return_exceptions=True)

    result = []
    for room_id, active in db_rooms:
        if allowed is not None and room_id not in allowed:
            continue
        c = manager.get(room_id)
        if c:
            result.append({
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
                "bot_name": c.bot_name if c.cookies.get("SESSDATA") else "",
                "active": c._running,
            })
        else:
            result.append({
                "room_id": room_id, "real_room_id": room_id,
                "streamer_name": "", "streamer_avatar": "", "room_title": "",
                "live_status": 0, "ruid": 0, "followers": 0, "guard_count": 0,
                "area_name": "", "parent_area_name": "", "announcement": "",
                "bot_uid": 0, "bot_name": "", "active": bool(active),
            })
    return result


@router.get("/api/commands")
async def list_commands(room_id: int = Query(...)):
    return get_room_commands(room_id)


@router.post("/api/rooms/{room_id}/stop")
async def stop_room(room_id: int, _=Depends(require_room_access)):
    if not manager.has(room_id):
        raise HTTPException(404, "房间不存在")
    manager.stop_room(room_id)
    return {"ok": True, "room_id": room_id}


@router.post("/api/rooms/{room_id}/start")
async def start_room(room_id: int, _=Depends(require_room_access)):
    client = manager.get(room_id)
    if client and client._running:
        raise HTTPException(400, "房间已在运行中")
    if client and not client.cookies.get("SESSDATA"):
        raise HTTPException(400, "请先绑定机器人后再启动监控")
    await manager.start_room(room_id)
    return {"ok": True, "room_id": room_id}


@router.post("/api/commands/{cmd_id}/toggle")
async def toggle_command(cmd_id: str, room_id: int = Query(...)):
    cmd = get_command(room_id, cmd_id)
    if not cmd:
        return HTMLResponse('{"error":"not found"}', status_code=404)
    cmd["enabled"] = not cmd["enabled"]
    save_command_state(room_id, cmd_id, cmd["enabled"])
    return {"id": cmd_id, "room_id": room_id, "enabled": cmd["enabled"]}
