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
    # Migration: add active column if missing
    cols = [r[1] for r in conn.execute("PRAGMA table_info(rooms)").fetchall()]
    if "active" not in cols:
        conn.execute("ALTER TABLE rooms ADD COLUMN active INTEGER NOT NULL DEFAULT 0")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS commands (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'streamer_danmaku',
            description TEXT NOT NULL DEFAULT '',
            config_json TEXT NOT NULL DEFAULT '{}'
        )
    """)
    existing = conn.execute("SELECT COUNT(*) FROM commands").fetchone()[0]
    if existing == 0:
        for cmd in DEFAULT_COMMANDS:
            conn.execute(
                "INSERT OR IGNORE INTO commands (id, name, type, description, config_json) VALUES (?,?,?,?,?)",
                (cmd["id"], cmd["name"], cmd["type"], cmd["description"], json.dumps(cmd["config"], ensure_ascii=False)),
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

    conn.commit()
    conn.close()


def seed_rooms(room_ids: list[int]):
    """将命令行传入的房间号写入 DB 并标记为 active（仅插入不存在的）"""
    conn = sqlite3.connect(str(DB_PATH))
    for rid in room_ids:
        conn.execute(
            "INSERT OR IGNORE INTO rooms (room_id, active) VALUES (?, 1)",
            (rid,),
        )
        conn.execute("UPDATE rooms SET active=1 WHERE room_id=?", (rid,))
    conn.commit()
    conn.close()


def get_active_rooms() -> list[int]:
    conn = sqlite3.connect(str(DB_PATH))
    rows = conn.execute("SELECT room_id FROM rooms WHERE active=1").fetchall()
    conn.close()
    return [r[0] for r in rows]


def set_room_active(room_id: int, active: bool):
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("INSERT OR IGNORE INTO rooms (room_id, active) VALUES (?, ?)", (room_id, int(active)))
    conn.execute("UPDATE rooms SET active=? WHERE room_id=?", (int(active), room_id))
    conn.commit()
    conn.close()


def cleanup_old_events():
    conn = sqlite3.connect(str(DB_PATH))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).strftime("%Y-%m-%d %H:%M:%S")
    deleted = conn.execute("DELETE FROM events WHERE timestamp < ?", (cutoff,)).rowcount
    # Remove enter/like events and silver gifts — no longer persisted
    deleted_el = conn.execute("DELETE FROM events WHERE event_type IN ('enter', 'like')").rowcount
    deleted_combo = conn.execute("DELETE FROM events WHERE event_type='gift' AND extra_json LIKE '%\"combo\": true%'").rowcount
    # Migrate "face" → "avatar" in extra_json
    migrated = conn.execute(
        "UPDATE events SET extra_json = REPLACE(extra_json, '\"face\":', '\"avatar\":') WHERE extra_json LIKE '%\"face\":%'"
    ).rowcount
    conn.commit()
    conn.close()
    if deleted:
        log.info(f"清理过期事件: 删除 {deleted} 条 (早于 {cutoff})")
    if deleted_el:
        log.info(f"清理进场/点赞事件: 删除 {deleted_el} 条")
    if deleted_combo:
        log.info(f"清理连击重复事件: 删除 {deleted_combo} 条")
    if migrated:
        log.info(f"迁移 face→avatar: 更新 {migrated} 条")


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
        "INSERT OR REPLACE INTO rooms (room_id, settings_json) VALUES (?,?)",
        (room_id, json.dumps(settings, ensure_ascii=False)),
    )
    conn.commit()
    conn.close()


def get_room_commands(room_id: int) -> list[dict]:
    cmds = get_all_commands()
    settings = get_room_settings(room_id)
    cmd_states = settings.get("commands", {})
    for c in cmds:
        c["enabled"] = cmd_states.get(c["id"], False)
    return cmds


def save_command_state(room_id: int, cmd_id: str, enabled: bool):
    settings = get_room_settings(room_id)
    commands = settings.setdefault("commands", {})
    commands[cmd_id] = enabled
    save_room_settings(room_id, settings)


def get_command(room_id: int, cmd_id: str) -> Optional[dict]:
    return next((c for c in get_room_commands(room_id) if c["id"] == cmd_id), None)
