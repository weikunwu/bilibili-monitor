"""认证中间件和 session 管理"""

import json
import re
import secrets
import sqlite3
import time
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import Request, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware

from .config import DB_PATH, log
from .crypto import hash_password, verify_password
from .email_send import send_verification_code


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
        if path in ("/api/auth", "/login", "/register") or path.startswith("/api/register/") \
                or path.startswith("/static/") or path.startswith("/assets/"):
            return await call_next(request)
        # /overlay/* 是公开的 OBS 叠加页 (SPA + 公开 API)，不需要登录
        if path.startswith("/overlay/") or path.startswith("/api/overlay/"):
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
        return RedirectResponse("/login", status_code=302)


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

# Per-user password-change limiter (independent from login attempts so a
# logged-in attacker with a stolen session can't spam UPDATEs).
_pwchange_attempts: dict[int, tuple[int, float]] = defaultdict(lambda: (0, 0.0))
_MAX_PWCHANGE_ATTEMPTS = 5
_PWCHANGE_WINDOW_SECONDS = 3600


def _client_ip(request: Request) -> str:
    """Prefer X-Forwarded-For first hop so Fly's LB doesn't collapse every
    request to one source IP. Falls back to direct socket peer."""
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def handle_login(request: Request):
    ip = _client_ip(request)

    body = await request.json()
    email = body.get("email", "").strip().lower()
    pw = body.get("password", "")

    # Check both IP- and email-keyed lockouts. Email keyed prevents an
    # IP-rotating attacker from brute-forcing a specific account; IP keyed
    # prevents one source from spraying many emails.
    for key in (ip, f"email:{email}"):
        fails, first_time = _login_attempts[key]
        if fails >= _MAX_LOGIN_ATTEMPTS and time.time() - first_time < _LOGIN_LOCKOUT_SECONDS:
            return HTMLResponse('{"ok":false,"error":"请求过于频繁，请5分钟后再试"}', status_code=429)
        if fails >= _MAX_LOGIN_ATTEMPTS:
            _login_attempts[key] = (0, 0.0)

    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute("SELECT id, password_hash, role FROM users WHERE email = ?", (email,)).fetchone()
    if not row or not verify_password(pw, row[1]):
        conn.close()
        for key in (ip, f"email:{email}"):
            fails, first_time = _login_attempts[key]
            _login_attempts[key] = (fails + 1, first_time or time.time())
        return HTMLResponse('{"ok":false,"error":"邮箱或密码错误"}', status_code=403)

    user_id, _, role = row
    token = secrets.token_urlsafe(32)
    expires = (datetime.now(timezone.utc) + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
    conn.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)", (token, user_id, expires))
    conn.commit()
    conn.close()

    _login_attempts.pop(ip, None)
    _login_attempts.pop(f"email:{email}", None)
    resp = HTMLResponse(json.dumps({"ok": True, "role": role}))
    # Secure=True blocks the cookie on http://localhost. Fall back to
    # non-secure only when the request itself is plain http (dev).
    is_https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    resp.set_cookie(
        "auth_token", token,
        httponly=True, max_age=86400 * 3,
        samesite="lax", secure=is_https,
    )
    return resp


async def handle_change_password(request: Request):
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return HTMLResponse('{"ok":false,"error":"未登录"}', status_code=401)
    fails, first_time = _pwchange_attempts[user_id]
    now = time.time()
    if fails >= _MAX_PWCHANGE_ATTEMPTS and now - first_time < _PWCHANGE_WINDOW_SECONDS:
        return HTMLResponse('{"ok":false,"error":"尝试次数过多，请稍后再试"}', status_code=429)
    if now - first_time >= _PWCHANGE_WINDOW_SECONDS:
        _pwchange_attempts[user_id] = (0, 0.0)

    body = await request.json()
    old_pw = body.get("old_password", "")
    new_pw = body.get("new_password", "")
    if len(new_pw) < 6:
        return HTMLResponse('{"ok":false,"error":"新密码至少6位"}', status_code=400)
    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute("SELECT password_hash FROM users WHERE id=?", (user_id,)).fetchone()
    if not row or not verify_password(old_pw, row[0]):
        conn.close()
        fails, first_time = _pwchange_attempts[user_id]
        _pwchange_attempts[user_id] = (fails + 1, first_time or now)
        return HTMLResponse('{"ok":false,"error":"原密码错误"}', status_code=403)
    _pwchange_attempts.pop(user_id, None)
    conn.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(new_pw), user_id))
    # Invalidate all other sessions; keep the current one so the user stays in.
    cur_token = request.cookies.get("auth_token")
    conn.execute("DELETE FROM sessions WHERE user_id=? AND token!=?", (user_id, cur_token or ""))
    conn.commit()
    conn.close()
    return HTMLResponse('{"ok":true}')


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


# ── Registration (email verification code) ──
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_CODE_RESEND_COOLDOWN_SEC = 60
_CODE_EXPIRY_SEC = 600  # 10 分钟
_MAX_VERIFY_ATTEMPTS = 5
# Per-IP send quota to prevent enumeration / spam. 10/hour is lenient for
# legitimate users but blocks scripted abuse.
_IP_SEND_WINDOW_SEC = 3600
_IP_SEND_MAX = 10
_ip_send_log: dict[str, list[float]] = defaultdict(list)


def _valid_email(email: str) -> bool:
    return bool(_EMAIL_RE.match(email)) and len(email) <= 254


async def handle_send_register_code(request: Request):
    ip = _client_ip(request)
    body = await request.json()
    email = body.get("email", "").strip().lower()
    if not _valid_email(email):
        return HTMLResponse('{"ok":false,"error":"邮箱格式不正确"}', status_code=400)

    now = time.time()
    hist = [t for t in _ip_send_log[ip] if now - t < _IP_SEND_WINDOW_SEC]
    if len(hist) >= _IP_SEND_MAX:
        return HTMLResponse('{"ok":false,"error":"请求过于频繁，请稍后再试"}', status_code=429)

    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone()
    if row:
        conn.close()
        return HTMLResponse('{"ok":false,"error":"该邮箱已被注册"}', status_code=400)

    # Cooldown: same email can only trigger a new send every 60s.
    prev = conn.execute(
        "SELECT sent_at FROM email_verifications WHERE email=?", (email,)
    ).fetchone()
    if prev:
        try:
            sent_at = datetime.strptime(prev[0], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            elapsed = (datetime.now(timezone.utc) - sent_at).total_seconds()
            if elapsed < _CODE_RESEND_COOLDOWN_SEC:
                conn.close()
                wait = int(_CODE_RESEND_COOLDOWN_SEC - elapsed)
                return HTMLResponse(
                    json.dumps({"ok": False, "error": f"请 {wait} 秒后再请求"}),
                    status_code=429,
                )
        except ValueError:
            pass

    code = f"{secrets.randbelow(1_000_000):06d}"
    expires = (datetime.now(timezone.utc) + timedelta(seconds=_CODE_EXPIRY_SEC)).strftime("%Y-%m-%d %H:%M:%S")
    conn.execute(
        "INSERT INTO email_verifications (email, code, expires_at, attempts, sent_at) "
        "VALUES (?,?,?,0,datetime('now')) "
        "ON CONFLICT(email) DO UPDATE SET code=excluded.code, expires_at=excluded.expires_at, "
        "attempts=0, sent_at=datetime('now')",
        (email, code, expires),
    )
    conn.commit()
    conn.close()

    ok, err = await send_verification_code(email, code)
    if not ok:
        return HTMLResponse(json.dumps({"ok": False, "error": err}), status_code=500)

    hist.append(now)
    _ip_send_log[ip] = hist
    return HTMLResponse('{"ok":true}')


async def handle_register(request: Request):
    body = await request.json()
    email = body.get("email", "").strip().lower()
    code = (body.get("code") or "").strip()
    pw = body.get("password", "")
    if not _valid_email(email):
        return HTMLResponse('{"ok":false,"error":"邮箱格式不正确"}', status_code=400)
    if len(pw) < 6:
        return HTMLResponse('{"ok":false,"error":"密码至少6位"}', status_code=400)
    if not code or len(code) != 6:
        return HTMLResponse('{"ok":false,"error":"验证码格式不正确"}', status_code=400)

    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone()
    if row:
        conn.close()
        return HTMLResponse('{"ok":false,"error":"该邮箱已被注册"}', status_code=400)

    ver = conn.execute(
        "SELECT code, expires_at, attempts FROM email_verifications WHERE email=?",
        (email,),
    ).fetchone()
    if not ver:
        conn.close()
        return HTMLResponse('{"ok":false,"error":"请先获取验证码"}', status_code=400)

    stored_code, expires_at, attempts = ver
    try:
        exp = datetime.strptime(expires_at, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        exp = datetime.now(timezone.utc) - timedelta(seconds=1)
    if datetime.now(timezone.utc) > exp:
        conn.execute("DELETE FROM email_verifications WHERE email=?", (email,))
        conn.commit()
        conn.close()
        return HTMLResponse('{"ok":false,"error":"验证码已过期，请重新获取"}', status_code=400)
    if attempts >= _MAX_VERIFY_ATTEMPTS:
        conn.execute("DELETE FROM email_verifications WHERE email=?", (email,))
        conn.commit()
        conn.close()
        return HTMLResponse('{"ok":false,"error":"尝试次数过多，请重新获取验证码"}', status_code=429)
    if code != stored_code:
        conn.execute("UPDATE email_verifications SET attempts=attempts+1 WHERE email=?", (email,))
        conn.commit()
        conn.close()
        return HTMLResponse('{"ok":false,"error":"验证码不正确"}', status_code=400)

    conn.execute(
        "INSERT INTO users (email, password_hash, role) VALUES (?,?,?)",
        (email, hash_password(pw), "user"),
    )
    user_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute("DELETE FROM email_verifications WHERE email=?", (email,))

    token = secrets.token_urlsafe(32)
    expires = (datetime.now(timezone.utc) + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
    conn.execute(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)",
        (token, user_id, expires),
    )
    conn.commit()
    conn.close()

    log.info(f"新用户注册: {email}")
    resp = HTMLResponse(json.dumps({"ok": True, "role": "user"}))
    is_https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    resp.set_cookie(
        "auth_token", token,
        httponly=True, max_age=86400 * 3,
        samesite="lax", secure=is_https,
    )
    return resp
