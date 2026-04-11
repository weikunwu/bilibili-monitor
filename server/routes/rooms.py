"""房间和指令 API"""

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse

from ..db import get_room_commands, save_command_state, get_command

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
            "room_title": c.room_title,
            "popularity": c.popularity,
        }
        for c in bili_clients.values()
        if allowed is None or c.room_id in allowed
    ]


@router.get("/api/commands")
async def list_commands(room_id: int = Query(...)):
    return get_room_commands(room_id)


@router.post("/api/commands/{cmd_id}/toggle")
async def toggle_command(cmd_id: str, room_id: int = Query(...)):
    cmd = get_command(room_id, cmd_id)
    if not cmd:
        return HTMLResponse('{"error":"not found"}', status_code=404)
    cmd["enabled"] = not cmd["enabled"]
    save_command_state(room_id, cmd_id, cmd["enabled"])
    return {"id": cmd_id, "room_id": room_id, "enabled": cmd["enabled"]}
