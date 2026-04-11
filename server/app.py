"""FastAPI 应用组装和启动"""

import asyncio
from typing import Optional

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import BASE_DIR, HEADERS, log
from .db import init_db, cleanup_old_events
from .auth import AuthMiddleware, get_session_user, get_user_allowed_rooms, handle_login, handle_logout
from .bili_api import load_gift_config, load_guard_list
from .bili_client import BiliLiveClient
from .crypto import load_cookies
from .routes import events, rooms, bot, admin

app = FastAPI(title="B站直播监控")

# ── Static files ──
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
FRONTEND_DIST = BASE_DIR / "frontend" / "dist"
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="frontend-assets")

# ── Auth middleware ──
app.add_middleware(AuthMiddleware)

# ── Routes ──
app.include_router(events.router)
app.include_router(rooms.router)
app.include_router(bot.router)
app.include_router(admin.router)


@app.post("/api/auth")
async def auth_login(request: Request):
    return await handle_login(request)


@app.post("/api/logout")
async def auth_logout(request: Request):
    return await handle_logout(request)


@app.get("/api/me")
async def get_me(request: Request):
    return {
        "user_id": getattr(request.state, "user_id", None),
        "email": getattr(request.state, "user_email", None),
        "role": getattr(request.state, "user_role", None),
    }


@app.get("/")
async def index():
    return FileResponse(BASE_DIR / "frontend" / "dist" / "index.html")


# ── WebSocket ──
ws_clients: dict[WebSocket, Optional[list[int]]] = {}
bili_clients: dict[int, BiliLiveClient] = {}


async def broadcast_event(event: dict):
    dead = set()
    room_id = event.get("room_id")
    for client, allowed_rooms in ws_clients.items():
        if allowed_rooms is not None and room_id and room_id not in allowed_rooms:
            continue
        try:
            await client.send_json(event)
        except Exception:
            dead.add(client)
    for d in dead:
        ws_clients.pop(d, None)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    token = ws.cookies.get("auth_token")
    user = get_session_user(token)
    if not user:
        await ws.close(code=1008)
        return
    allowed_rooms = get_user_allowed_rooms(user["user_id"], user["role"])
    await ws.accept()
    ws_clients[ws] = allowed_rooms
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        ws_clients.pop(ws, None)


# ── Main ──

async def main(room_ids: list[int], port: int):
    global bili_clients
    init_db()
    cleanup_old_events()

    await load_gift_config(HEADERS)
    for rid in room_ids:
        await load_guard_list(rid, HEADERS)

    for rid in room_ids:
        cookies = load_cookies(rid)
        client = BiliLiveClient(rid, on_event=broadcast_event, cookies=cookies)
        bili_clients[rid] = client

    config = uvicorn.Config(app, host="0.0.0.0", port=port, log_level="info")
    server = uvicorn.Server(config)

    log.info(f"启动监控: 房间 {room_ids} | Web: http://localhost:{port}")

    await asyncio.gather(
        server.serve(),
        *(client.run() for client in bili_clients.values()),
    )
