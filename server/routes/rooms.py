"""房间和指令 API"""

from fastapi import APIRouter, Depends, Query, Request, HTTPException
from fastapi.responses import HTMLResponse

from ..db import get_room_commands, save_command_state, get_command, get_all_rooms, get_room_save_danmu, set_room_save_danmu
from ..auth import require_room_access
from ..config import ROOM_INFO_API, MASTER_INFO_API
from ..manager import manager

router = APIRouter()


async def _fetch_room_info(room_id: int) -> dict:
    """Fetch room info from Bilibili API for rooms without a client."""
    import aiohttp
    base = {
        "room_id": room_id, "real_room_id": room_id,
        "streamer_name": "", "streamer_avatar": "", "room_title": "",
        "live_status": 0, "ruid": 0, "followers": 0,
        "area_name": "", "parent_area_name": "", "announcement": "",
        "bot_uid": 0, "bot_name": "", "active": False,
    }
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                ROOM_INFO_API,
                params={"room_id": room_id},
            ) as resp:
                data = await resp.json(content_type=None)
                if data.get("code") == 0:
                    info = data["data"]
                    base["real_room_id"] = info.get("room_id", room_id)
                    base["room_title"] = info.get("title", "")
                    base["live_status"] = info.get("live_status", 0)
                    base["area_name"] = info.get("area_name", "")
                    base["parent_area_name"] = info.get("parent_area_name", "")
                    ruid = info.get("uid", 0)
                    base["ruid"] = ruid
                    if ruid:
                        async with session.get(
                            MASTER_INFO_API,
                            params={"uid": ruid},
                        ) as resp2:
                            d2 = await resp2.json(content_type=None)
                            if d2.get("code") == 0:
                                base["streamer_name"] = d2["data"]["info"].get("uname", "")
                                base["streamer_avatar"] = d2["data"]["info"].get("face", "")
                                base["followers"] = d2["data"].get("follower_num", 0)
    except Exception:
        pass
    return base


@router.get("/api/rooms")
async def get_rooms(request: Request):
    import asyncio
    allowed = getattr(request.state, "allowed_rooms", None)
    db_rooms = get_all_rooms()

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
                "live_status": c.live_status if c._running else 0,
                "ruid": c.ruid,
                "followers": c.followers,

                "area_name": c.area_name,
                "parent_area_name": c.parent_area_name,
                "announcement": c.announcement,
                "bot_uid": c.uid if c.cookies.get("SESSDATA") else 0,
                "bot_name": c.bot_name if c.cookies.get("SESSDATA") else "",
                "active": c._running,
                "save_danmu": get_room_save_danmu(c.real_room_id),
            })
        else:
            # No client in memory — fetch basic info from Bilibili API
            info = await _fetch_room_info(room_id)
            info["active"] = bool(active)
            info["save_danmu"] = get_room_save_danmu(room_id)
            result.append(info)
    return result


@router.get("/api/commands")
async def list_commands(room_id: int = Query(...), _=Depends(require_room_access)):
    return get_room_commands(room_id)


@router.post("/api/rooms/{room_id}/stop")
async def stop_room(room_id: int, _=Depends(require_room_access)):
    if not manager.has(room_id):
        raise HTTPException(404, "房间不存在")
    manager.stop_room(room_id)
    return {"ok": True, "room_id": room_id}


@router.post("/api/rooms/{room_id}/start")
async def start_room(room_id: int, request: Request, _=Depends(require_room_access)):
    client = manager.get(room_id)
    if client and client._running:
        raise HTTPException(400, "房间已在运行中")
    is_admin = getattr(request.state, "user_role", "") == "admin"
    if not is_admin and client and not client.cookies.get("SESSDATA"):
        raise HTTPException(400, "请先绑定机器人后再启动监控")
    await manager.start_room(room_id)
    return {"ok": True, "room_id": room_id}


@router.post("/api/rooms/{room_id}/save-danmu")
async def toggle_save_danmu(room_id: int, request: Request, _=Depends(require_room_access)):
    body = await request.json()
    enabled = bool(body.get("enabled", True))
    set_room_save_danmu(room_id, enabled)
    return {"ok": True, "room_id": room_id, "save_danmu": enabled}


@router.post("/api/commands/{cmd_id}/toggle")
async def toggle_command(cmd_id: str, room_id: int = Query(...), _=Depends(require_room_access)):
    cmd = get_command(room_id, cmd_id)
    if not cmd:
        return HTMLResponse('{"error":"not found"}', status_code=404)
    cmd["enabled"] = not cmd["enabled"]
    save_command_state(room_id, cmd_id, cmd["enabled"])
    return {"id": cmd_id, "room_id": room_id, "enabled": cmd["enabled"]}
