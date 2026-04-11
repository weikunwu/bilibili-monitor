"""B站机器人绑定 API（QR 扫码）"""

import sqlite3
from typing import Optional

import requests as req
from fastapi import APIRouter, Query

from ..config import DB_PATH, QR_GENERATE_API, QR_POLL_API, HEADERS, log
from ..crypto import save_cookies
from ..manager import manager

router = APIRouter()

qr_session: Optional[req.Session] = None


@router.get("/api/bot/status")
async def bot_status(room_id: int = Query(...)):
    client = manager.get(room_id)
    if not client:
        return {"logged_in": False, "uid": 0}
    logged_in = bool(client.cookies.get("SESSDATA"))
    return {"logged_in": logged_in, "uid": client.uid}


@router.post("/api/bot/logout")
async def bot_logout(room_id: int = Query(...)):
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("UPDATE rooms SET bot_cookie=NULL WHERE room_id=?", (room_id,))
    conn.commit()
    conn.close()
    client = manager.get(room_id)
    if client:
        client.cookies = {}
        client.uid = 0
        client.request_reconnect()
    return {"ok": True}


@router.get("/api/bot/qrcode")
async def bot_qrcode(room_id: int = Query(...)):
    global qr_session
    qr_session = req.Session()
    qr_session._target_room_id = room_id  # type: ignore
    resp = qr_session.get(QR_GENERATE_API, headers=HEADERS)
    data = resp.json()
    if data.get("code") != 0:
        return {"error": "生成二维码失败"}
    return {"url": data["data"]["url"], "qrcode_key": data["data"]["qrcode_key"]}


@router.get("/api/bot/poll")
async def bot_poll(qrcode_key: str):
    global qr_session
    if not qr_session:
        return {"code": -1, "message": "请先获取二维码"}
    target_room_id = getattr(qr_session, "_target_room_id", 0)
    resp = qr_session.get(QR_POLL_API, params={"qrcode_key": qrcode_key}, headers=HEADERS)
    poll_data = resp.json().get("data", {})
    code = poll_data.get("code", -1)

    if code == 0:
        cookies = {}
        for key in ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"):
            val = qr_session.cookies.get(key) or resp.cookies.get(key)
            if val:
                cookies[key] = val
        url_str = poll_data.get("url", "")
        if "refresh_token=" in url_str:
            cookies["refresh_token"] = url_str.split("refresh_token=")[-1].split("&")[0]
        save_cookies(cookies, target_room_id)
        uid = int(cookies.get("DedeUserID", 0))
        client = manager.get(target_room_id)
        if client:
            client.cookies = cookies
            client.uid = uid
            client.request_reconnect()
        log.info(f"房间 {target_room_id} 扫码绑定成功 (UID: {uid})")
        return {"code": 0, "message": "绑定成功", "uid": uid}
    elif code == 86101:
        return {"code": 86101, "message": "等待扫码"}
    elif code == 86090:
        return {"code": 86090, "message": "已扫码，请确认"}
    elif code == 86038:
        return {"code": 86038, "message": "二维码已过期"}
    else:
        return {"code": code, "message": "未知状态"}
