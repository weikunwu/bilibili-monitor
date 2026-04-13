"""FastAPI 应用组装和启动"""

import asyncio

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import BASE_DIR, log
from .db import init_db, cleanup_old_events
from .auth import AuthMiddleware, get_session_user, get_user_allowed_rooms, handle_login, handle_logout
from .manager import manager
from . import recorder, effect_catalog
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


@app.get("/room/{path:path}")
async def spa_room_fallback():
    return FileResponse(BASE_DIR / "frontend" / "dist" / "index.html")


@app.get("/admin")
async def spa_admin_fallback():
    return FileResponse(BASE_DIR / "frontend" / "dist" / "index.html")


# ── WebSocket ──

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    token = ws.cookies.get("auth_token")
    user = get_session_user(token)
    if not user:
        await ws.close(code=1008)
        return
    allowed_rooms = get_user_allowed_rooms(user["user_id"], user["role"])
    await ws.accept()
    manager.add_ws(ws, allowed_rooms)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        manager.remove_ws(ws)


# ── Main ──

async def main(port: int):
    init_db()
    cleanup_old_events()
    manager.load_all()

    config = uvicorn.Config(app, host="0.0.0.0", port=port, log_level="info")
    server = uvicorn.Server(config)

    run_tasks = manager.get_run_tasks()
    log.info(f"启动监控: {len(run_tasks)} 个活跃房间 / {len(manager.all_clients())} 个总房间 | Web: http://localhost:{port}")

    await asyncio.gather(
        server.serve(),
        _periodic_clip_cleanup(),
        effect_catalog.run_periodic(),
        *run_tasks,
    )


async def _periodic_clip_cleanup():
    """Delete clips older than 24h every hour."""
    while True:
        try:
            recorder.cleanup_old_clips(max_age_hours=24)
        except Exception as e:
            log.warning(f"[clip cleanup] {e}")
        await asyncio.sleep(3600)
