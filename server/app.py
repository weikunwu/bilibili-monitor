"""FastAPI 应用组装和启动"""

import asyncio
import time

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, RedirectResponse, Response, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from datetime import datetime, timezone, timedelta

from .config import BASE_DIR, CLIP_RETENTION_HOURS, DATA_DIR, log
from .db import (
    init_db, cleanup_old_events, mark_events_clip_expired,
    get_expired_active_rooms, get_expired_rooms_for_reminder, incr_expired_reminder_count,
    list_pending_payment_orders, expire_stale_pending_orders, apply_payment_order,
)
from .auth import AuthMiddleware, get_session_user, get_user_allowed_rooms, handle_login, handle_logout, handle_change_password, handle_send_register_code, handle_register, handle_send_reset_code, handle_reset_password, purge_stale_rate_limits as purge_auth_rate_limits
from .routes.rooms import purge_stale_rate_limits as purge_room_rate_limits
from .routes.payments import purge_stale_rate_limits as purge_payment_rate_limits
from .effect_trigger import purge_stale_cooldowns as purge_entry_effect_cooldowns
from .routes.effects import purge_orphan_effect_files
from . import turnstile, notify
from .manager import manager
from . import recorder, effect_catalog, gift_catalog
from .payments import zpay
from .routes import events, rooms, bot, admin, clips, overlay, afdian, effects, payments

app = FastAPI(title="狗狗机器人")


# 启动状态 sentinel：检测上次进程是否被 SIGKILL/OOM 杀掉。
# 干净退出 = uvicorn 正常关时 on_event("shutdown") 改写成 STOPPED；
# OOM/SIGKILL = 不会触发任何 hook，文件停留在 RUNNING → 下次启动时检测到 → 推送告警。
_BOOT_SENTINEL = DATA_DIR / "boot_state.txt"


def _read_boot_sentinel() -> tuple[str, int]:
    try:
        parts = _BOOT_SENTINEL.read_text().strip().split()
        if len(parts) >= 2:
            return parts[0], int(parts[1])
    except (OSError, ValueError):
        pass
    return "", 0


def _write_boot_sentinel(state: str, ts: int) -> None:
    try:
        _BOOT_SENTINEL.write_text(f"{state} {ts}\n")
    except OSError as e:
        log.warning(f"[boot] sentinel write fail: {e}")


@app.on_event("shutdown")
async def _mark_clean_shutdown():
    state, _ = _read_boot_sentinel()
    if state == "RUNNING":
        _write_boot_sentinel("STOPPED", int(time.time()))


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


# 给二进制响应（image/video/audio/font）打 Content-Encoding: identity 标记，
# 让外层 GZipMiddleware 跳过压缩 —— 这些 content-type 已经压过，再 gzip
# 一次只浪费 CPU、对大视频还会破坏 Range/206 语义。
# 必须比 GZipMiddleware 更内层（更早注册），才能在响应出栈时先于 GZip 决策。
class _SkipGZipForBinary:
    SKIP_PREFIXES = (b"image/", b"video/", b"audio/", b"font/")

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        async def wrapped_send(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                ct = b""
                for k, v in headers:
                    if k.lower() == b"content-type":
                        ct = v.lower()
                        break
                if any(ct.startswith(p) for p in self.SKIP_PREFIXES):
                    headers.append((b"content-encoding", b"identity"))
                    message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, wrapped_send)


app.add_middleware(_SkipGZipForBinary)

# 给所有 >1KB 的响应套 gzip。fly egress 30GB/月，API JSON 压缩比通常 5-8x：
# 一次 2000 条礼物 ~1.2MB → ~200KB，单点能省 80% 出流量。
# CF 在 fly 前面也会保留 Content-Encoding=gzip 直接转发到浏览器。
app.add_middleware(GZipMiddleware, minimum_size=1024)


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
app.include_router(payments.router)


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
    manager.load_all_default_bots()

    asyncio.create_task(_check_unclean_restart())

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
        _periodic_memory_log(),
        _periodic_payment_reconcile(),
        effect_catalog.run_periodic(),
        *run_tasks,
    )


async def _check_unclean_restart():
    """启动时读 boot sentinel：RUNNING 状态意味着上次进程被外力杀掉
    （OOM / SIGKILL / fly health-check 失败），推送告警。"""
    try:
        state, ts = _read_boot_sentinel()
        now = int(time.time())
        if state == "RUNNING" and ts:
            uptime_min = max(0, (now - ts) // 60)
            boot_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
            log.warning(f"[boot] 上次未干净退出 (上次启动 {boot_str}, 运行 {uptime_min} 分钟)")
            await notify.send(
                "bilibili-monitor 异常重启",
                f"上次启动: {boot_str}\n"
                f"运行 {uptime_min} 分钟后被杀（无 graceful shutdown）\n"
                f"疑似 OOM / fly health-check 失败 —— "
                f"飞行中的 clip finalize、bot 任务都会被打断。"
            )
        _write_boot_sentinel("RUNNING", now)
    except Exception as e:
        log.warning(f"[boot] check err: {e}")


# 256MB VM；这个值之上 OOM kill 风险显著上升，留 50MB 裕度给突发。
# 触发后 30 分钟冷却，避免持续高位时每分钟刷一条推送。
_MEM_ALERT_THRESHOLD_MB = 200
_MEM_ALERT_COOLDOWN_SEC = 1800
_last_mem_alert_ts = 0.0


async def _periodic_memory_log():
    """每 60 秒记一次 RSS；超过阈值时推送告警（30 分钟冷却）。
    256MB VM 接近 OOM 前能从日志看出趋势，事后排障也能回答"是不是又涨爆了"。
    /proc/self/status 是 Linux only —— macOS 本地开发会静默 noop。"""
    global _last_mem_alert_ts
    while True:
        await asyncio.sleep(60)
        try:
            with open("/proc/self/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        rss_mb = int(line.split()[1]) // 1024
                        log.info(f"[mem] RSS={rss_mb} MB")
                        now = time.time()
                        if rss_mb >= _MEM_ALERT_THRESHOLD_MB and now - _last_mem_alert_ts >= _MEM_ALERT_COOLDOWN_SEC:
                            _last_mem_alert_ts = now
                            log.warning(f"[mem] RSS={rss_mb}MB 超阈值 {_MEM_ALERT_THRESHOLD_MB}MB")
                            await notify.send(
                                "bilibili-monitor 内存高",
                                f"RSS = {rss_mb} MB (阈值 {_MEM_ALERT_THRESHOLD_MB} MB / VM 总 256 MB)\n"
                                f"接近 OOM kill 阈值，建议 ssh 看 /proc 或重启释放。"
                            )
                        break
        except Exception:
            pass


async def _periodic_memory_cleanup():
    """每 5 分钟扫一次，清掉限流 dict / 欢迎去重 dict 里已失效的 key。
    这些 dict 的值本身到期不影响判定，但 key 不会被自动回收，长跑会涨。"""
    while True:
        await asyncio.sleep(300)
        try:
            purge_auth_rate_limits()
            purge_room_rate_limits()
            purge_payment_rate_limits()
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
                await manager.stop_room(rid)
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


async def _periodic_payment_reconcile():
    """每 5 分钟扫一次 pending 付款订单做对账：
      • 仍 pending 且创建后 ≤ 24h → 调 zpay.query_order 兜底（防 notify 丢/我们停过服）
        查到已支付 → apply_payment_order 续期房间
      • 仍 pending 且创建后 > 24h → 标记 expired，避免表越堆越大
    场景：用户扫码付完立刻关浏览器 + 我们 notify 没收到（fly 重启正好那一刻、
    zpay 重试间隔 > 我们前端轮询超时），不靠这个 task 房间永远不会续期。"""
    while True:
        try:
            pending = list_pending_payment_orders(within_hours=24)
            for o in pending:
                if o["provider"] != "zpay":
                    continue
                otn = o["out_trade_no"]
                try:
                    status, ext = await zpay.query_order(otn)
                except Exception as e:
                    log.warning(f"[payment-reconcile] query 异常 {otn}: {e}")
                    continue
                if status == "paid":
                    ok, info = apply_payment_order(otn, external_trade_no=ext, raw_json="reconcile")
                    if ok:
                        log.info(f"[payment-reconcile] 兜底应用成功 {otn} → expires_at={info}")
            n = expire_stale_pending_orders(older_than_hours=24)
            if n > 0:
                log.info(f"[payment-reconcile] 把 {n} 条超 24h 未付订单标记 expired")
        except Exception as e:
            log.warning(f"[payment-reconcile] {e}")
        await asyncio.sleep(300)
