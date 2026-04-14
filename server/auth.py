"""认证中间件和 session 管理"""

import json
import secrets
import sqlite3
import time
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import Request, HTTPException
from fastapi.responses import HTMLResponse
from starlette.middleware.base import BaseHTTPMiddleware

from .config import DB_PATH, log
from .crypto import hash_password, verify_password


LOGIN_HTML = """<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 - 大黄狗机器人</title>
<style>body{background:#0f0f1a;color:#e0e0e0;font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.box{background:#1a1a2e;padding:40px;border-radius:16px;border:1px solid #2a2a4a;text-align:center;min-width:300px}
h2{color:#fb7299;margin-bottom:20px}input{background:#0f0f1a;border:1px solid #2a2a4a;color:#ccc;padding:10px 16px;border-radius:8px;font-size:16px;width:100%;margin-bottom:16px;box-sizing:border-box}
input:focus{border-color:#fb7299;outline:none}button{background:#fb7299;color:#fff;border:none;padding:10px 24px;border-radius:8px;font-size:16px;cursor:pointer;width:100%}
button:hover{background:#e0607e}.err{color:#ef5350;font-size:13px;margin-bottom:12px}</style></head>
<body><div class="box"><h2>大黄狗机器人</h2><div class="err" id="err"></div>
<form onsubmit="return doLogin()"><input type="email" id="em" placeholder="邮箱" autofocus>
<input type="password" id="pw" placeholder="密码">
<button type="submit">登录</button></form></div>
<script>function doLogin(){const em=document.getElementById('em').value,pw=document.getElementById('pw').value;
fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:em,password:pw})})
.then(r=>r.json()).then(d=>{if(d.ok){location.reload()}else{document.getElementById('err').textContent=d.error||'登录失败'}});return false}</script></body></html>"""


def get_session_user(token: str) -> Optional[dict]:
    if not token:
        return None
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    row = conn.execute("""
        SELECT s.user_id, u.email, u.role
        FROM sessions s JOIN users u ON s.user_id = u.id
        WHERE s.token = ? AND s.expires_at > datetime('now')
    """, (token,)).fetchone()
    conn.close()
    if not row:
        return None
    return {"user_id": row["user_id"], "email": row["email"], "role": row["role"]}


def get_user_allowed_rooms(user_id: int, role: str) -> Optional[list[int]]:
    if role == "admin":
        return None
    conn = sqlite3.connect(str(DB_PATH))
    rooms = [r[0] for r in conn.execute(
        "SELECT room_id FROM user_rooms WHERE user_id = ?", (user_id,)
    ).fetchall()]
    conn.close()
    return rooms


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        if path in ("/api/auth",) or path.startswith("/static/") or path.startswith("/assets/"):
            return await call_next(request)

        token = request.cookies.get("auth_token")
        user = get_session_user(token)
        if user:
            request.state.user_id = user["user_id"]
            request.state.user_email = user["email"]
            request.state.user_role = user["role"]
            request.state.allowed_rooms = get_user_allowed_rooms(user["user_id"], user["role"])
            return await call_next(request)

        if path.startswith("/api/") or path == "/ws":
            return HTMLResponse('{"error":"unauthorized"}', status_code=401)
        return HTMLResponse(LOGIN_HTML)


def require_admin(request: Request):
    if getattr(request.state, "user_role", None) != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")


def require_room_access(request: Request, room_id: int = None):
    """FastAPI Depends: 检查当前用户是否有该房间的权限"""
    allowed = getattr(request.state, "allowed_rooms", None)
    if allowed is not None and room_id is not None and room_id not in allowed:
        raise HTTPException(status_code=403, detail="无权限访问该房间")


# ── Rate limiting ──
_login_attempts: dict[str, tuple[int, float]] = defaultdict(lambda: (0, 0.0))
_MAX_LOGIN_ATTEMPTS = 5
_LOGIN_LOCKOUT_SECONDS = 300


async def handle_login(request: Request):
    ip = request.client.host if request.client else "unknown"
    fails, first_time = _login_attempts[ip]
    if fails >= _MAX_LOGIN_ATTEMPTS and time.time() - first_time < _LOGIN_LOCKOUT_SECONDS:
        return HTMLResponse('{"ok":false,"error":"请求过于频繁，请5分钟后再试"}', status_code=429)
    if fails >= _MAX_LOGIN_ATTEMPTS:
        _login_attempts[ip] = (0, 0.0)

    body = await request.json()
    email = body.get("email", "").strip().lower()
    pw = body.get("password", "")

    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute("SELECT id, password_hash, role FROM users WHERE email = ?", (email,)).fetchone()
    if not row or not verify_password(pw, row[1]):
        conn.close()
        fails, first_time = _login_attempts[ip]
        _login_attempts[ip] = (fails + 1, first_time or time.time())
        return HTMLResponse('{"ok":false,"error":"邮箱或密码错误"}', status_code=403)

    user_id, _, role = row
    token = secrets.token_urlsafe(32)
    expires = (datetime.now(timezone.utc) + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
    conn.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)", (token, user_id, expires))
    conn.commit()
    conn.close()

    _login_attempts.pop(ip, None)
    resp = HTMLResponse(json.dumps({"ok": True, "role": role}))
    resp.set_cookie("auth_token", token, httponly=True, max_age=86400 * 3)
    return resp


async def handle_logout(request: Request):
    token = request.cookies.get("auth_token")
    if token:
        conn = sqlite3.connect(str(DB_PATH))
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
        conn.close()
    resp = HTMLResponse('{"ok":true}')
    resp.delete_cookie("auth_token")
    return resp
