"""数据库初始化和操作"""

import json
import os
import sqlite3
from datetime import datetime, timezone, timedelta
from typing import Optional

from .config import DB_PATH, DEFAULT_COMMANDS, log
from .crypto import hash_password


def init_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER DEFAULT 0,
            timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL,
            user_name TEXT,
            user_id INTEGER,
            content TEXT,
            extra_json TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id)")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS rooms (
            room_id INTEGER PRIMARY KEY,
            settings_json TEXT NOT NULL DEFAULT '{}',
            bot_cookie TEXT DEFAULT NULL,
            active INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS commands (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'streamer_danmu',
            description TEXT NOT NULL DEFAULT '',
            config_json TEXT NOT NULL DEFAULT '{}'
        )
    """)
    # Idempotent seed so new DEFAULT_COMMANDS show up on already-populated DBs.
    for cmd in DEFAULT_COMMANDS:
        conn.execute(
            "INSERT OR IGNORE INTO commands (id, name, type, description, config_json) VALUES (?,?,?,?,?)",
            (cmd["id"], cmd["name"], cmd["type"], cmd["description"], json.dumps(cmd["config"], ensure_ascii=False)),
        )
    # Drop stale commands that have been removed from DEFAULT_COMMANDS, and
    # strip their per-room enabled flags from rooms.settings_json so the UI
    # doesn't carry dangling toggle state.
    valid_ids = {c["id"] for c in DEFAULT_COMMANDS}
    stale = [row[0] for row in conn.execute("SELECT id FROM commands").fetchall() if row[0] not in valid_ids]
    if stale:
        conn.executemany("DELETE FROM commands WHERE id=?", [(s,) for s in stale])
        for room_id, settings_json in conn.execute("SELECT room_id, settings_json FROM rooms").fetchall():
            try:
                settings = json.loads(settings_json or "{}")
            except json.JSONDecodeError:
                continue
            cmds = settings.get("commands") or {}
            changed = False
            for sid in stale:
                if sid in cmds:
                    cmds.pop(sid)
                    changed = True
            if changed:
                conn.execute(
                    "UPDATE rooms SET settings_json=? WHERE room_id=?",
                    (json.dumps(settings, ensure_ascii=False), room_id),
                )

    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS user_rooms (
            user_id INTEGER NOT NULL,
            room_id INTEGER NOT NULL,
            PRIMARY KEY (user_id, room_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS nicknames (
            room_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            user_name TEXT NOT NULL DEFAULT '',
            nickname TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (room_id, user_id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)

    admin_email = os.environ.get("ADMIN_EMAIL", "admin@bilibili-monitor.local")
    admin_password = os.environ.get("ADMIN_PASSWORD", "")
    if admin_password:
        user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if user_count == 0:
            conn.execute(
                "INSERT INTO users (email, password_hash, role) VALUES (?,?,?)",
                (admin_email, hash_password(admin_password), "admin"),
            )
            log.info(f"创建管理员账号: {admin_email}")

    # Migrate: rename event_type 'danmaku' -> 'danmu'
    conn.execute("UPDATE events SET event_type='danmu' WHERE event_type='danmaku'")
    # Migrate: rename settings key 'save_danmaku' -> 'save_danmu'
    conn.execute("UPDATE rooms SET settings_json=REPLACE(settings_json, '\"save_danmaku\"', '\"save_danmu\"') WHERE settings_json LIKE '%save_danmaku%'")
    # Migrate: rename command type 'streamer_danmaku' -> 'streamer_danmu'
    conn.execute("UPDATE commands SET type='streamer_danmu' WHERE type='streamer_danmaku'")

    conn.commit()
    conn.close()




def get_all_rooms() -> list[tuple[int, int]]:
    conn = sqlite3.connect(str(DB_PATH))
    rows = conn.execute("SELECT room_id, active FROM rooms").fetchall()
    conn.close()
    return [(r[0], r[1]) for r in rows]


def add_room(room_id: int):
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("INSERT OR IGNORE INTO rooms (room_id, active) VALUES (?, 0)", (room_id,))
    conn.commit()
    conn.close()


def remove_room(room_id: int):
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("DELETE FROM rooms WHERE room_id = ?", (room_id,))
    conn.execute("DELETE FROM user_rooms WHERE room_id = ?", (room_id,))
    conn.commit()
    conn.close()


def set_room_active(room_id: int, active: bool):
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("UPDATE rooms SET active=? WHERE room_id=?", (int(active), room_id))
    conn.commit()
    conn.close()


def list_users() -> list[dict]:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT id, email, role, created_at FROM users").fetchall()
    result = []
    for r in rows:
        rooms = [x[0] for x in conn.execute(
            "SELECT room_id FROM user_rooms WHERE user_id = ?", (r["id"],)
        ).fetchall()]
        result.append({**dict(r), "rooms": rooms})
    conn.close()
    return result


def create_user(email: str, password: str, role: str = "user") -> dict:
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        "INSERT INTO users (email, password_hash, role) VALUES (?,?,?)",
        (email, hash_password(password), role),
    )
    conn.commit()
    user_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()
    return {"id": user_id, "email": email, "role": role}


def delete_user(user_id: int):
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM user_rooms WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()


def assign_user_rooms(user_id: int, room_ids: list[int]):
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("DELETE FROM user_rooms WHERE user_id = ?", (user_id,))
    for rid in room_ids:
        conn.execute("INSERT INTO user_rooms (user_id, room_id) VALUES (?,?)", (user_id, rid))
    conn.commit()
    conn.close()


def cleanup_old_events():
    conn = sqlite3.connect(str(DB_PATH))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).strftime("%Y-%m-%d %H:%M:%S")
    deleted = conn.execute("DELETE FROM events WHERE timestamp < ?", (cutoff,)).rowcount
    conn.commit()
    conn.close()
    if deleted:
        log.info(f"清理过期事件: 删除 {deleted} 条 (早于 {cutoff})")


def save_event(event: dict):
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        "INSERT INTO events (room_id, timestamp, event_type, user_name, user_id, content, extra_json) VALUES (?,?,?,?,?,?,?)",
        (
            event.get("room_id", 0),
            event["timestamp"],
            event["event_type"],
            event.get("user_name"),
            event.get("user_id"),
            event.get("content"),
            json.dumps(event.get("extra", {}), ensure_ascii=False),
        ),
    )
    conn.commit()
    conn.close()


# ── Room settings & commands ──

def get_all_commands() -> list[dict]:
    conn = sqlite3.connect(str(DB_PATH))
    rows = conn.execute("SELECT id, name, type, description, config_json FROM commands").fetchall()
    conn.close()
    return [
        {"id": r[0], "name": r[1], "type": r[2], "description": r[3], "config": json.loads(r[4])}
        for r in rows
    ]


def get_room_settings(room_id: int) -> dict:
    try:
        conn = sqlite3.connect(str(DB_PATH))
        row = conn.execute("SELECT settings_json FROM rooms WHERE room_id=?", (room_id,)).fetchone()
        conn.close()
        if row:
            return json.loads(row[0])
    except Exception:
        pass
    return {}


def save_room_settings(room_id: int, settings: dict):
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        "UPDATE rooms SET settings_json=? WHERE room_id=?",
        (json.dumps(settings, ensure_ascii=False), room_id),
    )
    conn.commit()
    conn.close()


def get_room_commands(room_id: int) -> list[dict]:
    cmds = get_all_commands()
    settings = get_room_settings(room_id)
    cmd_states = settings.get("commands", {})
    # Fall back to the DEFAULT_COMMANDS `default_enabled` flag when the
    # room hasn't explicitly opted in/out yet.
    defaults = {c["id"]: bool(c.get("default_enabled", False)) for c in DEFAULT_COMMANDS}
    for c in cmds:
        c["enabled"] = cmd_states.get(c["id"], defaults.get(c["id"], False))
    return cmds


def save_command_state(room_id: int, cmd_id: str, enabled: bool):
    settings = get_room_settings(room_id)
    commands = settings.setdefault("commands", {})
    commands[cmd_id] = enabled
    save_room_settings(room_id, settings)


def get_command(room_id: int, cmd_id: str) -> Optional[dict]:
    return next((c for c in get_room_commands(room_id) if c["id"] == cmd_id), None)


def get_room_save_danmu(room_id: int) -> bool:
    settings = get_room_settings(room_id)
    return settings.get("save_danmu", True)


def set_room_save_danmu(room_id: int, enabled: bool):
    settings = get_room_settings(room_id)
    settings["save_danmu"] = enabled
    save_room_settings(room_id, settings)


def list_nicknames(room_id: int) -> list[dict]:
    conn = sqlite3.connect(str(DB_PATH))
    rows = conn.execute(
        "SELECT user_id, user_name, nickname, updated_at FROM nicknames WHERE room_id=? ORDER BY updated_at DESC",
        (room_id,),
    ).fetchall()
    conn.close()
    return [{"user_id": r[0], "user_name": r[1], "nickname": r[2], "updated_at": r[3]} for r in rows]


def get_nickname(room_id: int, user_id: int) -> Optional[str]:
    if not user_id:
        return None
    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute(
        "SELECT nickname FROM nicknames WHERE room_id=? AND user_id=?",
        (room_id, user_id),
    ).fetchone()
    conn.close()
    return row[0] if row else None


def upsert_nickname(room_id: int, user_id: int, user_name: str, nickname: str):
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        """
        INSERT INTO nicknames (room_id, user_id, user_name, nickname, updated_at)
        VALUES (?,?,?,?, datetime('now'))
        ON CONFLICT(room_id, user_id) DO UPDATE SET
            user_name=excluded.user_name,
            nickname=excluded.nickname,
            updated_at=datetime('now')
        """,
        (room_id, user_id, user_name, nickname),
    )
    conn.commit()
    conn.close()


def delete_nickname(room_id: int, user_id: int):
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("DELETE FROM nicknames WHERE room_id=? AND user_id=?", (room_id, user_id))
    conn.commit()
    conn.close()


def list_room_users(room_id: int, search: str = "") -> list[dict]:
    """Distinct (user_id, most recent user_name) from events for a room."""
    conn = sqlite3.connect(str(DB_PATH))
    sql = """
        SELECT user_id, user_name FROM events
        WHERE room_id=? AND user_id > 0 AND user_name IS NOT NULL AND user_name != ''
    """
    params: list = [room_id]
    if search:
        sql += " AND user_name LIKE ?"
        params.append(f"%{search}%")
    sql += " GROUP BY user_id ORDER BY MAX(timestamp) DESC LIMIT 200"
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [{"user_id": r[0], "user_name": r[1]} for r in rows]


def get_room_auto_clip(room_id: int) -> bool:
    settings = get_room_settings(room_id)
    return settings.get("auto_clip", False)


def set_room_auto_clip(room_id: int, enabled: bool):
    settings = get_room_settings(room_id)
    settings["auto_clip"] = enabled
    save_room_settings(room_id, settings)
