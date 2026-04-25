"""B站机器人绑定 API（QR 扫码）"""

import sqlite3
import time

import requests as req
from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..config import DB_PATH, QR_GENERATE_API, QR_POLL_API, HEADERS, log
from ..crypto import save_cookies
from ..db import save_bot_buvid3, save_bot_buvid4, set_relogin_alerted
from ..auth import require_room_access
from ..manager import manager

router = APIRouter()

# Keyed by qrcode_key so concurrent binds across different rooms don't
# clobber each other's target room id. Previously a single global
# `qr_session` was reused — if user B requested a QR for room 200 while
# user A was still scanning for room 100, A's cookies would bind to B's
# room after poll read the overwritten global.
_qr_sessions: dict[str, tuple[req.Session, int, float]] = {}
_QR_TTL_SEC = 300  # QR codes themselves expire in ~3 min; give a little slack.


def _gc_qr_sessions():
    now = time.time()
    for k in [k for k, (_, _, ts) in _qr_sessions.items() if now - ts > _QR_TTL_SEC]:
        _qr_sessions.pop(k, None)


@router.get("/api/bot/status")
async def bot_status(room_id: int = Query(...), _=Depends(require_room_access)):
    client = manager.get(room_id)
    if not client:
        return {"logged_in": False, "uid": 0}
    logged_in = bool(client.cookies.get("SESSDATA"))
    return {"logged_in": logged_in, "uid": client.bot_uid}


@router.post("/api/bot/logout")
async def bot_logout(room_id: int = Query(...), _=Depends(require_room_access)):
    # 解绑：清 cookie + buvid + 停止该房间监控（observe 重启需要主播先重新绑定）。
    # buvid 必须一并清掉，否则下次绑新账号会沿用旧 buvid，B 站会看到
    # "同一设备指纹换账号"的可疑信号。
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        "UPDATE rooms SET bot_cookie=NULL, bot_buvid3=NULL, bot_buvid4=NULL, relogin_alerted=0 WHERE room_id=?",
        (room_id,),
    )
    conn.commit()
    conn.close()
    client = manager.get(room_id)
    if client:
        client.cookies = {}
        client.bot_uid = 0
    if manager.has(room_id):
        manager.stop_room(room_id)
    return {"ok": True}


@router.get("/api/bot/qrcode")
async def bot_qrcode(room_id: int = Query(...), _=Depends(require_room_access)):
    _gc_qr_sessions()
    session = req.Session()
    resp = session.get(QR_GENERATE_API, headers=HEADERS)
    data = resp.json()
    if data.get("code") != 0:
        return {"error": "生成二维码失败"}
    qrcode_key = data["data"]["qrcode_key"]
    _qr_sessions[qrcode_key] = (session, room_id, time.time())
    return {"url": data["data"]["url"], "qrcode_key": qrcode_key}


@router.get("/api/bot/poll")
async def bot_poll(request: Request, qrcode_key: str):
    # Must be logged in, and the caller must have access to the room the
    # QR was originally requested for. Previously this was unauthenticated,
    # so anyone who learned a qrcode_key could complete someone else's
    # scan and steal the bot cookies.
    if not getattr(request.state, "user_id", None):
        raise HTTPException(status_code=401, detail="未登录")
    entry = _qr_sessions.get(qrcode_key)
    if not entry:
        return {"code": -1, "message": "请先获取二维码"}
    session, target_room_id, _ts = entry
    allowed = getattr(request.state, "allowed_rooms", None)
    if allowed is not None and target_room_id not in allowed:
        raise HTTPException(status_code=403, detail="无权限访问该房间")
    resp = session.get(QR_POLL_API, params={"qrcode_key": qrcode_key}, headers=HEADERS)
    poll_data = resp.json().get("data", {})
    code = poll_data.get("code", -1)

    if code == 0:
        cookies = {}
        for key in ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"):
            val = session.cookies.get(key) or resp.cookies.get(key)
            if val:
                cookies[key] = val
        # refresh_token 在 poll 响应 data 顶层，不在 redirect URL 里。
        # （历史代码错误地从 url 字符串里 split，永远命中不了。）
        rt = poll_data.get("refresh_token") or ""
        if rt:
            cookies["refresh_token"] = rt
        save_cookies(cookies, target_room_id)
        # 绑定新账号：把上一个账号持久化的 buvid 清掉，让下次 get_buvid
        # 用新 cookies 从 finger/spi 拿一个全新的，避免"同设备指纹换账号"
        # 的可疑信号。同时清掉 relogin_alerted 标志，让新账号下次真失效时
        # 能再次发提醒。
        save_bot_buvid3(target_room_id, "")
        save_bot_buvid4(target_room_id, "")
        set_relogin_alerted(target_room_id, False)
        uid = int(cookies.get("DedeUserID", 0))
        client = manager.get(target_room_id)
        if client:
            client.cookies = cookies
            client.bot_uid = uid
            # 清掉内存里 per-session 的派生状态（老 buvid / 老用户名 / 老熔断）
            client.reset_bot_session_state()
            client.request_reconnect()
            # request_reconnect 只在 WS loop 跑着的时候有用；active=0 的房间
            # WS 不跑，必须显式拉一次 NAV_API，否则 bot_name 永远是空串 → UI
            # 显示 "Unknown (UID: xxx)"。
            await client.refresh_bot_identity()
        _qr_sessions.pop(qrcode_key, None)
        log.info(f"房间 {target_room_id} 扫码绑定成功 (UID: {uid})")
        return {"code": 0, "message": "绑定成功", "uid": uid}
    elif code == 86101:
        return {"code": 86101, "message": "等待扫码"}
    elif code == 86090:
        return {"code": 86090, "message": "已扫码，请确认"}
    elif code == 86038:
        _qr_sessions.pop(qrcode_key, None)
        return {"code": 86038, "message": "二维码已过期"}
    else:
        return {"code": code, "message": "未知状态"}
