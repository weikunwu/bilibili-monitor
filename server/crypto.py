"""密码哈希和 Cookie 加密"""

import base64
import hashlib
import json
import os
import secrets
import sqlite3

from cryptography.fernet import Fernet

from .config import DB_PATH, log


def _get_fernet() -> Fernet:
    key_src = os.environ.get("COOKIE_SECRET", os.environ.get("ADMIN_PASSWORD", "bilibili-monitor-default"))
    key = base64.urlsafe_b64encode(hashlib.sha256(key_src.encode()).digest())
    return Fernet(key)


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100_000)
    return f"{salt}${h.hex()}"


def verify_password(password: str, stored: str) -> bool:
    salt, h = stored.split('$', 1)
    return hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100_000).hex() == h


def save_cookies(cookies: dict, room_id: int = 0):
    encrypted = _get_fernet().encrypt(json.dumps(cookies, ensure_ascii=False).encode()).decode()
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("INSERT OR IGNORE INTO rooms (room_id, settings_json) VALUES (?, '{}')", (room_id,))
    conn.execute("UPDATE rooms SET bot_cookie=? WHERE room_id=?", (encrypted, room_id))
    conn.commit()
    conn.close()
    log.info(f"Cookie 已加密保存到数据库 (房间 {room_id})")


def load_cookies(room_id: int = 0) -> dict:
    try:
        conn = sqlite3.connect(str(DB_PATH))
        row = conn.execute("SELECT bot_cookie FROM rooms WHERE room_id=?", (room_id,)).fetchone()
        conn.close()
        if row and row[0]:
            cookies = json.loads(_get_fernet().decrypt(row[0].encode()))
            if cookies.get("SESSDATA"):
                log.info(f"从数据库加载登录信息 (房间 {room_id}, UID: {cookies.get('DedeUserID', '?')})")
                return cookies
    except Exception:
        log.warning(f"无法读取 cookies (房间 {room_id})")
    return {}
