"""数据库初始化和操作"""

import json
import os
import secrets
import sqlite3
from datetime import datetime, timezone, timedelta
from typing import Optional

from .config import DB_PATH, DEFAULT_COMMANDS, log
from .crypto import hash_password


def get_or_create_overlay_token(room_id: int, user_id: Optional[int] = None) -> str:
    """Return the stored overlay token for this room; create one if missing."""
    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute("SELECT token FROM overlay_tokens WHERE room_id=?", (room_id,)).fetchone()
    if row:
        conn.close()
        return row[0]
    token = secrets.token_urlsafe(24)
    conn.execute(
        "INSERT INTO overlay_tokens (token, room_id, created_by) VALUES (?,?,?)",
        (token, room_id, user_id),
    )
    conn.commit()
    conn.close()
    return token


def rotate_overlay_token(room_id: int, user_id: Optional[int] = None) -> str:
    """Replace the overlay token for this room with a fresh one. Old links stop working."""
    token = secrets.token_urlsafe(24)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        "INSERT OR REPLACE INTO overlay_tokens (token, room_id, created_by, created_at) "
        "VALUES (?,?,?,datetime('now'))",
        (token, room_id, user_id),
    )
    conn.commit()
    conn.close()
    return token


OVERLAY_DEFAULTS: dict = {
    "max_events": 10,
    "min_price": 0,
    "max_price": 0,
    "price_mode": "total",
    "show_gift": 1,
    "show_blind": 1,
    "show_guard": 1,
    "show_superchat": 1,
    "time_range": "today",  # today / week / live
    "cleared_at": "",
}


def get_overlay_settings(room_id: int) -> dict:
    """Load overlay settings for a room; return defaults if not configured."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT max_events, min_price, max_price, price_mode, "
        "show_gift, show_blind, show_guard, show_superchat, time_range, cleared_at "
        "FROM overlay_settings WHERE room_id=?",
        (room_id,),
    ).fetchone()
    conn.close()
    if not row:
        return dict(OVERLAY_DEFAULTS)
    d = dict(row)
    for k in ("show_gift", "show_blind", "show_guard", "show_superchat"):
        d[k] = bool(d[k])
    if d.get("time_range") not in ("today", "week", "live"):
        d["time_range"] = "today"
    return d


def update_overlay_settings(room_id: int, patch: dict) -> dict:
    """Upsert overlay settings for a room. Only whitelisted keys are applied."""
    allowed = {
        "max_events", "min_price", "max_price", "price_mode",
        "show_gift", "show_blind", "show_guard", "show_superchat",
        "time_range",
    }
    current = get_overlay_settings(room_id)
    for k in allowed:
        if k in patch:
            current[k] = patch[k]
    # Coerce booleans back to int for storage
    show_gift = int(bool(current["show_gift"]))
    show_blind = int(bool(current["show_blind"]))
    show_guard = int(bool(current["show_guard"]))
    show_superchat = int(bool(current["show_superchat"]))
    tr = current.get("time_range") or "today"
    if tr not in ("today", "week", "live"):
        tr = "today"
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        "INSERT INTO overlay_settings "
        "(room_id, max_events, min_price, max_price, price_mode, "
        "show_gift, show_blind, show_guard, show_superchat, time_range, cleared_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(room_id) DO UPDATE SET "
        "max_events=excluded.max_events, min_price=excluded.min_price, "
        "max_price=excluded.max_price, price_mode=excluded.price_mode, "
        "show_gift=excluded.show_gift, show_blind=excluded.show_blind, "
        "show_guard=excluded.show_guard, show_superchat=excluded.show_superchat, "
        "time_range=excluded.time_range",
        (
            room_id, int(current["max_events"]), int(current["min_price"]),
            int(current["max_price"]), str(current["price_mode"]),
            show_gift, show_blind, show_guard, show_superchat, tr, current.get("cleared_at") or "",
        ),
    )
    conn.commit()
    conn.close()
    return get_overlay_settings(room_id)


def clear_overlay_history(room_id: int, cleared_at_utc: str) -> dict:
    """Set cleared_at timestamp so overlay only shows events newer than this."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        "INSERT INTO overlay_settings (room_id, cleared_at) VALUES (?,?) "
        "ON CONFLICT(room_id) DO UPDATE SET cleared_at=excluded.cleared_at",
        (room_id, cleared_at_utc),
    )
    conn.commit()
    conn.close()
    return get_overlay_settings(room_id)


def verify_overlay_token(room_id: int, token: str) -> bool:
    if not token:
        return False
    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute(
        "SELECT 1 FROM overlay_tokens WHERE room_id=? AND token=?", (room_id, token),
    ).fetchone()
    conn.close()
    return row is not None


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
    # Index strategy: every hot query scopes by room_id. Two composite
    # indexes cover the two query shapes (with/without event_type filter);
    # a bare timestamp index exists only for the global retention DELETE.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_room_ts ON events(room_id, timestamp)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_room_type_ts ON events(room_id, event_type, timestamp)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp)")
    # 按房间 + 用户 + 时间的 GROUP BY 查询（list_room_users）会走这个索引。
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_room_user_ts ON events(room_id, user_id, timestamp)")
    # Drop superseded single-column indexes from earlier schemas.
    conn.execute("DROP INDEX IF EXISTS idx_events_type")
    conn.execute("DROP INDEX IF EXISTS idx_events_room")

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
    # Upsert name/description/config (not id) so editing DEFAULT_COMMANDS
    # actually updates the UI on existing installs; per-room enabled/config
    # overrides live in rooms.settings_json and aren't touched here.
    for cmd in DEFAULT_COMMANDS:
        conn.execute(
            "INSERT INTO commands (id, name, type, description, config_json) VALUES (?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, "
            "description=excluded.description, config_json=excluded.config_json",
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
    # 注册邮箱验证码：同一 email 覆盖旧验证码（重发 = 替换）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS email_verifications (
            email TEXT PRIMARY KEY,
            code TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            sent_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    # 忘记密码验证码：结构同 email_verifications，单独存避免和注册流互串
    conn.execute("""
        CREATE TABLE IF NOT EXISTS password_resets (
            email TEXT PRIMARY KEY,
            code TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            sent_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    # OBS 叠加页 token：每房间一条，生成需登录，使用无需登录（只能拿只读的礼物聚合）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS overlay_tokens (
            token TEXT PRIMARY KEY,
            room_id INTEGER NOT NULL UNIQUE,
            created_by INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    # OBS 叠加页展示设置 (每房间一条)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS overlay_settings (
            room_id INTEGER PRIMARY KEY,
            max_events INTEGER NOT NULL DEFAULT 10,
            min_price INTEGER NOT NULL DEFAULT 0,
            max_price INTEGER NOT NULL DEFAULT 0,
            price_mode TEXT NOT NULL DEFAULT 'total',
            show_gift INTEGER NOT NULL DEFAULT 1,
            show_blind INTEGER NOT NULL DEFAULT 1,
            show_guard INTEGER NOT NULL DEFAULT 1,
            show_superchat INTEGER NOT NULL DEFAULT 1,
            time_range TEXT NOT NULL DEFAULT 'today',
            cleared_at TEXT NOT NULL DEFAULT ''
        )
    """)
    # 老库补列
    ov_cols = {r[1] for r in conn.execute("PRAGMA table_info(overlay_settings)").fetchall()}
    if "show_superchat" not in ov_cols:
        conn.execute("ALTER TABLE overlay_settings ADD COLUMN show_superchat INTEGER NOT NULL DEFAULT 1")
    if "time_range" not in ov_cols:
        conn.execute("ALTER TABLE overlay_settings ADD COLUMN time_range TEXT NOT NULL DEFAULT 'today'")
    # rooms 表加 live_started_at（bili_client 收到 LIVE 时写 UTC ISO；供 overlay 查"本次直播"）
    room_cols = {r[1] for r in conn.execute("PRAGMA table_info(rooms)").fetchall()}
    if "live_started_at" not in room_cols:
        conn.execute("ALTER TABLE rooms ADD COLUMN live_started_at TEXT")
    # 房间到期时间（UTC ISO，'YYYY-MM-DD HH:MM:SS'）。NULL = 永不过期。
    # 首次加列时把所有已有房间统一设成北京 2026-05-31 23:59:59 = UTC 15:59:59。
    if "expires_at" not in room_cols:
        conn.execute("ALTER TABLE rooms ADD COLUMN expires_at TEXT")
        conn.execute(
            "UPDATE rooms SET expires_at=? WHERE expires_at IS NULL",
            ("2026-05-31 15:59:59",),
        )
    # 到期后提醒弹幕计数：马上发 1 条 + 之后每天 1 条，共 5 条。续费时重置为 0。
    if "expired_reminder_count" not in room_cols:
        conn.execute("ALTER TABLE rooms ADD COLUMN expired_reminder_count INTEGER NOT NULL DEFAULT 0")

    admin_email = os.environ.get("ADMIN_EMAIL", "")
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
    """新增房间：默认送 7 天试用期。如果 room 已存在，INSERT OR IGNORE 保留原值。"""
    from datetime import datetime, timezone, timedelta
    trial_expires = (datetime.now(timezone.utc) + timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        "INSERT OR IGNORE INTO rooms (room_id, active, expires_at) VALUES (?, 0, ?)",
        (room_id, trial_expires),
    )
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


def set_live_started_at(room_id: int, iso_utc: Optional[str]):
    """直播开播时由 bili_client 调用，overlay "本次直播" 时间窗拿这个作 floor。
    传 None 表示当前不在直播中（下播/房间空闲），overlay 会据此返空。"""
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("UPDATE rooms SET live_started_at=? WHERE room_id=?", (iso_utc, room_id))
    conn.commit()
    conn.close()


def get_live_started_at(room_id: int) -> Optional[str]:
    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute("SELECT live_started_at FROM rooms WHERE room_id=?", (room_id,)).fetchone()
    conn.close()
    return row[0] if row and row[0] else None


def get_room_expires_at(room_id: int) -> Optional[str]:
    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute("SELECT expires_at FROM rooms WHERE room_id=?", (room_id,)).fetchone()
    conn.close()
    return row[0] if row and row[0] else None


def set_room_expires_at(room_id: int, iso_utc: Optional[str]):
    """写入到期时间，同时把到期提醒计数重置为 0（续费场景）。"""
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        "UPDATE rooms SET expires_at=?, expired_reminder_count=0 WHERE room_id=?",
        (iso_utc, room_id),
    )
    conn.commit()
    conn.close()


def get_expired_active_rooms(now_utc: str) -> list[int]:
    """返回所有 active=1 且到期时间 <= now_utc 的 room_id。"""
    conn = sqlite3.connect(str(DB_PATH))
    rows = conn.execute(
        "SELECT room_id FROM rooms WHERE active=1 AND expires_at IS NOT NULL AND expires_at <= ?",
        (now_utc,),
    ).fetchall()
    conn.close()
    return [r[0] for r in rows]


def get_expired_rooms_for_reminder(now_utc: str) -> list[tuple[int, str, int]]:
    """返回所有 expired_at <= now_utc 且 expired_reminder_count < 5 的房间。
    -> [(room_id, expires_at, reminder_count), ...]"""
    conn = sqlite3.connect(str(DB_PATH))
    rows = conn.execute(
        "SELECT room_id, expires_at, expired_reminder_count FROM rooms "
        "WHERE expires_at IS NOT NULL AND expires_at <= ? AND expired_reminder_count < 5",
        (now_utc,),
    ).fetchall()
    conn.close()
    return [(r[0], r[1], r[2]) for r in rows]


def incr_expired_reminder_count(room_id: int) -> int:
    """Reminder 发送后调用，+1 并返回新值。"""
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        "UPDATE rooms SET expired_reminder_count=expired_reminder_count+1 WHERE room_id=?",
        (room_id,),
    )
    row = conn.execute(
        "SELECT expired_reminder_count FROM rooms WHERE room_id=?", (room_id,)
    ).fetchone()
    conn.commit()
    conn.close()
    return int(row[0] if row else 0)


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


def add_user_room(user_id: int, room_id: int):
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("INSERT OR IGNORE INTO user_rooms (user_id, room_id) VALUES (?,?)", (user_id, room_id))
    conn.commit()
    conn.close()


def remove_user_room(user_id: int, room_id: int) -> bool:
    conn = sqlite3.connect(str(DB_PATH))
    cur = conn.execute("DELETE FROM user_rooms WHERE user_id=? AND room_id=?", (user_id, room_id))
    conn.commit()
    deleted = cur.rowcount > 0
    conn.close()
    return deleted


def count_user_rooms(user_id: int) -> int:
    conn = sqlite3.connect(str(DB_PATH))
    n = conn.execute("SELECT COUNT(*) FROM user_rooms WHERE user_id=?", (user_id,)).fetchone()[0]
    conn.close()
    return n


def is_room_claimed(room_id: int) -> bool:
    """Whether the room is already bound to any (non-admin) user."""
    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute("SELECT 1 FROM user_rooms WHERE room_id=? LIMIT 1", (room_id,)).fetchone()
    conn.close()
    return row is not None


def cleanup_old_events():
    conn = sqlite3.connect(str(DB_PATH))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=548)).strftime("%Y-%m-%d %H:%M:%S")
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
    # 保持与 DEFAULT_COMMANDS 中声明顺序一致；DB 原始顺序按插入时间，新增指令
    # 会排到末尾，重排序 DEFAULT_COMMANDS 不会自动生效。
    order = {c["id"]: i for i, c in enumerate(DEFAULT_COMMANDS)}
    cmds.sort(key=lambda c: order.get(c["id"], 10_000))
    settings = get_room_settings(room_id)
    cmd_states = settings.get("commands", {})
    cmd_configs = settings.get("commands_config", {})
    # Fall back to the DEFAULT_COMMANDS `default_enabled` flag when the
    # room hasn't explicitly opted in/out yet.
    defaults = {c["id"]: bool(c.get("default_enabled", False)) for c in DEFAULT_COMMANDS}
    for c in cmds:
        c["enabled"] = cmd_states.get(c["id"], defaults.get(c["id"], False))
        # Per-room config overrides merge on top of the base config so a
        # room can pick its own gift for "打个有效" without mutating defaults.
        override = cmd_configs.get(c["id"])
        if isinstance(override, dict):
            c["config"] = {**c["config"], **override}
    return cmds


def save_command_state(room_id: int, cmd_id: str, enabled: bool):
    settings = get_room_settings(room_id)
    commands = settings.setdefault("commands", {})
    commands[cmd_id] = enabled
    save_room_settings(room_id, settings)


def save_command_config(room_id: int, cmd_id: str, config: dict):
    settings = get_room_settings(room_id)
    cfgs = settings.setdefault("commands_config", {})
    cfgs[cmd_id] = config
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
