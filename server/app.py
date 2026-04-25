"""FastAPI 应用组装和启动"""

import asyncio

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import FileResponse, RedirectResponse, Response, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from datetime import datetime, timezone, timedelta

from .config import BASE_DIR, CLIP_RETENTION_HOURS, log
from .db import (
    init_db, cleanup_old_events, mark_events_clip_expired,
    get_expired_active_rooms, get_expired_rooms_for_reminder, incr_expired_reminder_count,
)
from .auth import AuthMiddleware, get_session_user, get_user_allowed_rooms, handle_login, handle_logout, handle_change_password, handle_send_register_code, handle_register, handle_send_reset_code, handle_reset_password, purge_stale_rate_limits as purge_auth_rate_limits
from .routes.rooms import purge_stale_rate_limits as purge_room_rate_limits
from .routes.effects import (
    purge_stale_cooldowns as purge_entry_effect_cooldowns,
    purge_orphan_effect_files,
)
from . import turnstile
from .manager import manager
from . import recorder, effect_catalog, gift_catalog
from .routes import events, rooms, bot, admin, clips, overlay, afdian, effects

app = FastAPI(title="狗狗机器人")


# Fly 每月只有 30GB 出流量。给所有静态资源贴 Cache-Control，让前置 CDN
# (Cloudflare) 能缓存边缘命中、不回源；浏览器二次访问也能直接走本地缓存
# 不发请求。/assets/* 是 Vite 打包带 hash 的产物（内容变 → 文件名变），
# 所以可以放心 immutable 一年；/static/* 是仓库里固定的卡片模板/边框图，
# 改动罕见但不带 hash，给 1 天兜底，etag/last-modified 自然走条件请求。
class CachedStaticFiles(StaticFiles):
    def __init__(self, *args, cache_control: str = "", **kwargs):
        self._cache_control = cache_control
        super().__init__(*args, **kwargs)

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        if self._cache_control:
            resp.headers["Cache-Control"] = self._cache_control
        return resp


# ── Static files ──
app.mount(
    "/static",
    CachedStaticFiles(directory=BASE_DIR / "static", cache_control="public, max-age=86400"),
    name="static",
)
FRONTEND_DIST = BASE_DIR / "frontend" / "dist"
if FRONTEND_DIST.exists():
    app.mount(
        "/assets",
        CachedStaticFiles(
            directory=FRONTEND_DIST / "assets",
            cache_control="public, max-age=31536000, immutable",
        ),
        name="frontend-assets",
    )

# ── Auth middleware ──
app.add_middleware(AuthMiddleware)


@app.middleware("http")
async def redirect_to_canonical(request: Request, call_next):
    host = request.headers.get("host", "").split(":")[0].lower()
    if host in ("bilibili-monitor.fly.dev", "www.blackbubu.us"):
        target = f"https://blackbubu.us{request.url.path}"
        if request.url.query:
            target += f"?{request.url.query}"
        return RedirectResponse(target, status_code=301)
    return await call_next(request)

# ── Routes ──
app.include_router(events.router)
app.include_router(rooms.router)
app.include_router(bot.router)
app.include_router(admin.router)
app.include_router(clips.router)
app.include_router(overlay.router)
app.include_router(afdian.router)
app.include_router(effects.router)


@app.post("/api/auth")
async def auth_login(request: Request):
    return await handle_login(request)


@app.post("/api/logout")
async def auth_logout(request: Request):
    return await handle_logout(request)


@app.post("/api/change-password")
async def auth_change_password(request: Request):
    return await handle_change_password(request)


@app.post("/api/register/send-code")
async def auth_send_register_code(request: Request):
    return await handle_send_register_code(request)


@app.post("/api/register/verify")
async def auth_register(request: Request):
    return await handle_register(request)


@app.post("/api/password-reset/send-code")
async def auth_send_reset_code(request: Request):
    return await handle_send_reset_code(request)


@app.post("/api/password-reset/verify")
async def auth_reset_password(request: Request):
    return await handle_reset_password(request)


@app.get("/api/public-config")
async def public_config():
    return {
        "turnstile_site_key": turnstile.site_key() if turnstile.enabled() else "",
    }


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


@app.get("/register")
async def spa_register_fallback():
    return FileResponse(BASE_DIR / "frontend" / "dist" / "index.html")


@app.get("/login")
async def spa_login_fallback():
    return FileResponse(BASE_DIR / "frontend" / "dist" / "index.html")


@app.get("/forgot-password")
async def spa_forgot_password_fallback():
    return FileResponse(BASE_DIR / "frontend" / "dist" / "index.html")


@app.get("/overlay/{path:path}")
async def spa_overlay_fallback():
    return FileResponse(BASE_DIR / "frontend" / "dist" / "index.html")


# 爬虫 / 浏览器 devtools 的小文件，不走 AuthMiddleware 重定向 → 直接短路返回。
@app.get("/robots.txt")
async def robots_txt():
    return PlainTextResponse("User-agent: *\nDisallow: /\n")


@app.get("/sitemap.xml")
async def sitemap_xml():
    return Response(status_code=404)


@app.get("/styles.css.map")
async def styles_css_map():
    return Response(status_code=204)


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

async def main(port: int, listen: bool = True):
    init_db()
    cleanup_old_events()
    gift_catalog.load_from_db()
    manager.load_all()

    config = uvicorn.Config(app, host="0.0.0.0", port=port, log_level="info")
    server = uvicorn.Server(config)

    if listen:
        run_tasks = manager.get_run_tasks()
        log.info(f"启动监控: {len(run_tasks)} 个活跃房间 / {len(manager.all_clients())} 个总房间 | Web: http://localhost:{port}")
    else:
        run_tasks = []
        log.info(f"仅服务器模式（不启动事件监听）/ {len(manager.all_clients())} 个总房间 | Web: http://localhost:{port}")

    await asyncio.gather(
        server.serve(),
        _periodic_clip_cleanup(),
        _periodic_expiration_check(),
        _periodic_memory_cleanup(),
        effect_catalog.run_periodic(),
        *run_tasks,
    )


async def _periodic_memory_cleanup():
    """每 5 分钟扫一次，清掉限流 dict / 欢迎去重 dict 里已失效的 key。
    这些 dict 的值本身到期不影响判定，但 key 不会被自动回收，长跑会涨。"""
    while True:
        await asyncio.sleep(300)
        try:
            purge_auth_rate_limits()
            purge_room_rate_limits()
            purge_entry_effect_cooldowns()
            total = 0
            for client in list(manager.all_clients().values()):
                total += client.purge_stale_welcome()
            if total:
                log.debug(f"[mem cleanup] purged {total} stale welcome entries")
        except Exception as e:
            log.warning(f"[mem cleanup] {e}")


async def _periodic_clip_cleanup():
    """Delete clips older than CLIP_RETENTION_HOURS every hour. Also sweep orphan entry-effect files."""
    while True:
        try:
            recorder.cleanup_old_clips(max_age_hours=CLIP_RETENTION_HOURS)
            # 磁盘清完同步把事件表里过期事件的 has_clip 翻回 false
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=CLIP_RETENTION_HOURS)).strftime("%Y-%m-%d %H:%M:%S")
            n = mark_events_clip_expired(cutoff)
            if n:
                log.info(f"[clip cleanup] 事件 has_clip 翻 false: {n} 条")
        except Exception as e:
            log.warning(f"[clip cleanup] {e}")
        try:
            n = purge_orphan_effect_files()
            if n:
                log.info(f"[effect-orphan] 清掉 {n} 个孤儿文件")
        except Exception as e:
            log.warning(f"[effect-orphan] {e}")
        await asyncio.sleep(3600)


async def _periodic_expiration_check():
    """每分钟扫一次：
    1) 到期且还在监听 → 停止监听
    2) 到期后发"续费提醒"弹幕：立刻 1 条 + 之后每天 1 条，最多 5 条。
       续费（set_room_expires_at）时计数会被重置回 0。
    expires_at 是 UTC 字符串，字典序 = 时间序。"""
    while True:
        try:
            now = datetime.now(timezone.utc)
            now_utc = now.strftime("%Y-%m-%d %H:%M:%S")
            for rid in get_expired_active_rooms(now_utc):
                log.info(f"房间 {rid} 到期，自动停止监听")
                manager.stop_room(rid)
            for rid, exp_str, sent in get_expired_rooms_for_reminder(now_utc):
                try:
                    exp_dt = datetime.strptime(exp_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                except ValueError:
                    continue
                hours = (now - exp_dt).total_seconds() / 3600
                # 第 k 条期望时间：到期 + (k-1)*24h。想发几条 = min(5, floor(hours/24) + 1)。
                expected = min(5, int(hours // 24) + 1)
                if sent >= expected:
                    continue
                client = manager.get(rid)
                if not client or not client.cookies.get("SESSDATA"):
                    continue  # 没 cookie 发不了，等用户下次重新绑定再补
                try:
                    await client.send_danmu("狗狗机器人已到期")
                    new_count = incr_expired_reminder_count(rid)
                    log.info(f"房间 {rid} 到期提醒 {new_count}/5 已发送")
                except Exception as e:
                    log.warning(f"[expiration reminder] room={rid} {e}")
        except Exception as e:
            log.warning(f"[expiration check] {e}")
        await asyncio.sleep(60)
