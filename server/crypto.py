"""密码哈希和 Cookie 加密"""

import base64
import hashlib
import json
import os
import secrets
import sqlite3

from cryptography.fernet import Fernet

from .config import DB_PATH, log


_SECRET_FILE = DB_PATH.parent / ".cookie_secret"


def _get_fernet() -> Fernet:
    """Resolve the Fernet key in this order:
      1. COOKIE_SECRET env var (preferred for deployments — set once, keep stable).
      2. A local persisted random secret (`.cookie_secret` next to the DB).
      3. Auto-generate + persist on first run.
    Previously we fell back to a hardcoded default when no env was set —
    that meant anyone who got a copy of the SQLite file could decrypt all
    bot SESSDATA/bili_jct with a public, published string. Refuse that
    path entirely by generating a random secret and persisting it."""
    key_src = os.environ.get("COOKIE_SECRET", "")
    if not key_src:
        try:
            key_src = _SECRET_FILE.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            key_src = secrets.token_urlsafe(48)
            _SECRET_FILE.write_text(key_src, encoding="utf-8")
            try:
                os.chmod(_SECRET_FILE, 0o600)
            except OSError:
                pass
            log.warning(f"COOKIE_SECRET 未设置，已自动生成并保存到 {_SECRET_FILE}")
    key = base64.urlsafe_b64encode(hashlib.sha256(key_src.encode()).digest())
    return Fernet(key)


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100_000)
    return f"{salt}${h.hex()}"


def verify_password(password: str, stored: str) -> bool:
    salt, h = stored.split('$', 1)
    return hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100_000).hex() == h


def encrypt_cookies(cookies: dict) -> str:
    """JSON + Fernet 加密 cookies，返回 base64 字符串。"""
    return _get_fernet().encrypt(json.dumps(cookies, ensure_ascii=False).encode()).decode()


def decrypt_cookies(blob: str) -> dict:
    return json.loads(_get_fernet().decrypt(blob.encode()))


def save_cookies(cookies: dict, room_id: int = 0):
    encrypted = encrypt_cookies(cookies)
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
            cookies = decrypt_cookies(row[0])
            if cookies.get("SESSDATA"):
                log.info(f"从数据库加载登录信息 (房间 {room_id}, UID: {cookies.get('DedeUserID', '?')})")
                return cookies
    except Exception:
        log.warning(f"无法读取 cookies (房间 {room_id})")
    return {}
