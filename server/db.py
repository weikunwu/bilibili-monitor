"""数据库初始化和操作"""

import json
import os
import secrets
import sqlite3
from datetime import datetime, timezone, timedelta
from typing import Optional

from .config import DB_PATH, DEFAULT_COMMANDS, RARE_BLIND_MIN_PRICE, log
from .crypto import hash_password
from . import gift_catalog


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
    "scroll_enabled": 1,  # 是否开启溢出循环滚动
    "scroll_speed": 40,   # 百分比 0–100，scroll_enabled=1 时生效
    "cleared_at": "",
}


def get_overlay_settings(room_id: int) -> dict:
    """Load overlay settings for a room; return defaults if not configured."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT max_events, min_price, max_price, price_mode, "
        "show_gift, show_blind, show_guard, show_superchat, time_range, "
        "scroll_enabled, scroll_speed, cleared_at "
        "FROM overlay_settings WHERE room_id=?",
        (room_id,),
    ).fetchone()
    conn.close()
    if not row:
        d = dict(OVERLAY_DEFAULTS)
    else:
        d = dict(row)
    # DB 和 OVERLAY_DEFAULTS 都用 1/0 存，对外 JSON 统一转 bool，避免
    # rsuite Toggle 严格比较 `checked === true` 时把 1 当成关。
    for k in ("show_gift", "show_blind", "show_guard", "show_superchat", "scroll_enabled"):
        d[k] = bool(d[k])
    if d.get("time_range") not in ("today", "week", "live"):
        d["time_range"] = "today"
    return d


def update_overlay_settings(room_id: int, patch: dict) -> dict:
    """Upsert overlay settings for a room. Only whitelisted keys are applied."""
    allowed = {
        "max_events", "min_price", "max_price", "price_mode",
        "show_gift", "show_blind", "show_guard", "show_superchat",
        "time_range", "scroll_enabled", "scroll_speed",
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
    # scroll_speed 是百分比 0–100
    try:
        speed = int(current.get("scroll_speed") or 40)
    except (TypeError, ValueError):
        speed = 40
    speed = max(0, min(100, speed))
    scroll_enabled = int(bool(current.get("scroll_enabled", True)))
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        "INSERT INTO overlay_settings "
        "(room_id, max_events, min_price, max_price, price_mode, "
        "show_gift, show_blind, show_guard, show_superchat, time_range, "
        "scroll_enabled, scroll_speed, cleared_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(room_id) DO UPDATE SET "
        "max_events=excluded.max_events, min_price=excluded.min_price, "
        "max_price=excluded.max_price, price_mode=excluded.price_mode, "
        "show_gift=excluded.show_gift, show_blind=excluded.show_blind, "
        "show_guard=excluded.show_guard, show_superchat=excluded.show_superchat, "
        "time_range=excluded.time_range, "
        "scroll_enabled=excluded.scroll_enabled, scroll_speed=excluded.scroll_speed",
        (
            room_id, int(current["max_events"]), int(current["min_price"]),
            int(current["max_price"]), str(current["price_mode"]),
            show_gift, show_blind, show_guard, show_superchat, tr,
            scroll_enabled, speed, current.get("cleared_at") or "",
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

    conn.execute("""
        CREATE TABLE IF NOT EXISTS rooms (
            room_id INTEGER PRIMARY KEY,
            settings_json TEXT NOT NULL DEFAULT '{}',
            bot_cookie TEXT DEFAULT NULL,
            active INTEGER NOT NULL DEFAULT 0,
            live_started_at TEXT,
            expires_at TEXT,
            expired_reminder_count INTEGER NOT NULL DEFAULT 0
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

    # 一次性 migration：早期 broadcast_pk_start 模版迭代过几版（"PK对面"、人气
    # 字段进出），把所有房间 commands_config 里这条 override 删掉，让它们
    # fall back 到 DEFAULT_COMMANDS 里的最新模版；同时把 enabled 状态也清掉，
    # 让所有房间回到 default_enabled=False，避免老用户在 UI 不可见时不小心
    # 留着开启状态。
    for room_id, settings_json in conn.execute("SELECT room_id, settings_json FROM rooms").fetchall():
        try:
            settings = json.loads(settings_json or "{}")
        except json.JSONDecodeError:
            continue
        changed = False
        cfgs = settings.get("commands_config") or {}
        if "broadcast_pk_start" in cfgs:
            cfgs.pop("broadcast_pk_start", None)
            changed = True
        states = settings.get("commands") or {}
        if "broadcast_pk_start" in states:
            states.pop("broadcast_pk_start", None)
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
            role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','staff','user')),
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
            scroll_enabled INTEGER NOT NULL DEFAULT 1,
            scroll_speed INTEGER NOT NULL DEFAULT 40,
            cleared_at TEXT NOT NULL DEFAULT ''
        )
    """)
    # Migration: overlay_settings 加 scroll_speed / scroll_enabled 列（老库没有）
    overlay_cols = {row[1] for row in conn.execute("PRAGMA table_info(overlay_settings)").fetchall()}
    if "scroll_speed" not in overlay_cols:
        conn.execute("ALTER TABLE overlay_settings ADD COLUMN scroll_speed INTEGER NOT NULL DEFAULT 40")
    if "scroll_enabled" not in overlay_cols:
        conn.execute("ALTER TABLE overlay_settings ADD COLUMN scroll_enabled INTEGER NOT NULL DEFAULT 1")
    # 管理员手动生成的续费码。每条一码一用，成功兑换后写入 used_* 字段。
    conn.execute("""
        CREATE TABLE IF NOT EXISTS renewal_tokens (
            token TEXT PRIMARY KEY,
            months INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            used_at TEXT,
            used_by_user_id INTEGER,
            used_for_room_id INTEGER
        )
    """)
    # 爱发电订单：以 out_trade_no 为主键幂等防重放。爱发电重试同一订单时直接返回 200。
    conn.execute("""
        CREATE TABLE IF NOT EXISTS afdian_orders (
            out_trade_no TEXT PRIMARY KEY,
            room_id INTEGER,
            months INTEGER NOT NULL,
            total_amount TEXT,
            raw_json TEXT,
            processed_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    # 进场特效：每个 (room_id, uid) 一条记录。
    # 两种来源二选一：
    #   • 上传视频：video_filename 非空，落磁盘到 ENTRY_EFFECT_ROOT
    #   • 预设动画：preset_key 非空，OBS 叠加页拿 key 渲染对应动画，无文件
    conn.execute("""
        CREATE TABLE IF NOT EXISTS entry_effects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER NOT NULL,
            uid INTEGER NOT NULL,
            user_name TEXT NOT NULL DEFAULT '',
            video_filename TEXT NOT NULL DEFAULT '',
            preset_key TEXT NOT NULL DEFAULT '',
            size_bytes INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(room_id, uid)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_entry_effects_room ON entry_effects(room_id)")
    # Migration: 老库 entry_effects 没有 preset_key，补一下；video_filename
    # 也放宽默认值，方便预设记录写空字符串。
    existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(entry_effects)").fetchall()}
    if "preset_key" not in existing_cols:
        conn.execute("ALTER TABLE entry_effects ADD COLUMN preset_key TEXT NOT NULL DEFAULT ''")

    # 礼物特效覆盖：每个 (room_id, gift_id) 一条；命中时 OBS 叠加页播这个视频
    # 而不是 B站 自带 VAP；原本没 VAP 的礼物也能借这条加上特效。
    conn.execute("""
        CREATE TABLE IF NOT EXISTS gift_effects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER NOT NULL,
            gift_id INTEGER NOT NULL,
            gift_name TEXT NOT NULL DEFAULT '',
            video_filename TEXT NOT NULL,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(room_id, gift_id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_gift_effects_room ON gift_effects(room_id)")

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

    conn.commit()
    conn.close()




def get_all_rooms() -> list[tuple[int, int]]:
    conn = sqlite3.connect(str(DB_PATH))
    rows = conn.execute("SELECT room_id, active FROM rooms").fetchall()
    conn.close()
    return [(r[0], r[1]) for r in rows]


def add_room(room_id: int):
    """新增房间：默认送 7 天试用期。如果 room 已存在，INSERT OR IGNORE 保留原值。"""
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


def is_room_expired(room_id: int) -> bool:
    """expires_at 是 UTC 字符串，字典序 = 时间序，直接和 now 字符串比即可。"""
    exp = get_room_expires_at(room_id)
    if not exp:
        return False
    return exp <= datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


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


def create_renewal_token(months: int = 1) -> str:
    """生成一条续费码，返回字符串。"""
    token = secrets.token_urlsafe(16)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        "INSERT INTO renewal_tokens (token, months) VALUES (?, ?)",
        (token, months),
    )
    conn.commit()
    conn.close()
    return token


def list_renewal_tokens(limit: int = 100) -> list[dict]:
    conn = sqlite3.connect(str(DB_PATH))
    rows = conn.execute(
        "SELECT token, months, created_at, used_at, used_by_user_id, used_for_room_id "
        "FROM renewal_tokens ORDER BY created_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [{
        "token": r[0], "months": r[1], "created_at": r[2],
        "used_at": r[3], "used_by_user_id": r[4], "used_for_room_id": r[5],
    } for r in rows]


def redeem_renewal_token(token: str, user_id: int, room_id: int) -> tuple[bool, str]:
    """成功返回 (True, new_expires_at_utc)；失败返回 (False, reason)。
    原子性：token 必须是 unused 才能扣；同时更新 room 的到期时间。"""
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT months, used_at FROM renewal_tokens WHERE token=?", (token,)
        ).fetchone()
        if not row:
            conn.execute("ROLLBACK")
            return False, "续费码不存在"
        months, used_at = int(row[0]), row[1]
        if used_at:
            conn.execute("ROLLBACK")
            return False, "续费码已被使用"
        # 续期基准 = max(当前 expires_at, now)，避免已过期房间续费 N 天后还是过去
        exp_row = conn.execute(
            "SELECT expires_at FROM rooms WHERE room_id=?", (room_id,)
        ).fetchone()
        if not exp_row:
            conn.execute("ROLLBACK")
            return False, "房间不存在"
        now_utc = datetime.now(timezone.utc)
        base = now_utc
        if exp_row[0]:
            try:
                cur = datetime.strptime(exp_row[0], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                if cur > base:
                    base = cur
            except ValueError:
                pass
        new_exp = base + timedelta(days=30 * months)
        new_exp_str = new_exp.strftime("%Y-%m-%d %H:%M:%S")
        conn.execute(
            "UPDATE rooms SET expires_at=?, expired_reminder_count=0 WHERE room_id=?",
            (new_exp_str, room_id),
        )
        conn.execute(
            "UPDATE renewal_tokens SET used_at=?, used_by_user_id=?, used_for_room_id=? WHERE token=?",
            (now_utc.strftime("%Y-%m-%d %H:%M:%S"), user_id, room_id, token),
        )
        conn.execute("COMMIT")
        return True, new_exp_str
    except Exception as e:
        conn.execute("ROLLBACK")
        return False, f"兑换失败: {e}"
    finally:
        conn.close()


# ── 进场特效 ──

def list_entry_effects(room_id: int) -> list[dict]:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, room_id, uid, user_name, video_filename, preset_key, size_bytes, created_at "
        "FROM entry_effects WHERE room_id=? ORDER BY created_at DESC",
        (room_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_entry_effect_for_user(room_id: int, uid: int) -> Optional[dict]:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT id, room_id, uid, user_name, video_filename, preset_key, size_bytes, created_at "
        "FROM entry_effects WHERE room_id=? AND uid=?",
        (room_id, uid),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def upsert_entry_effect(
    room_id: int, uid: int, user_name: str,
    video_filename: str = "", preset_key: str = "", size_bytes: int = 0,
) -> dict:
    """Upsert：同一 (room, uid) 再次写入直接替换记录。video_filename 与
    preset_key 二选一非空；调用方负责清旧文件（如果之前是上传类型）。"""
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        "INSERT INTO entry_effects (room_id, uid, user_name, video_filename, preset_key, size_bytes) "
        "VALUES (?,?,?,?,?,?) "
        "ON CONFLICT(room_id, uid) DO UPDATE SET "
        "user_name=excluded.user_name, video_filename=excluded.video_filename, "
        "preset_key=excluded.preset_key, size_bytes=excluded.size_bytes, "
        "created_at=datetime('now')",
        (room_id, uid, user_name, video_filename, preset_key, size_bytes),
    )
    conn.commit()
    conn.close()
    row = get_entry_effect_for_user(room_id, uid)
    assert row is not None
    return row


def delete_entry_effect(room_id: int, effect_id: int) -> Optional[str]:
    """删除记录，返回旧 video_filename 供调用方清磁盘（预设类型返回空字符串）；不存在返回 None。"""
    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute(
        "SELECT video_filename FROM entry_effects WHERE id=? AND room_id=?",
        (effect_id, room_id),
    ).fetchone()
    if not row:
        conn.close()
        return None
    conn.execute("DELETE FROM entry_effects WHERE id=? AND room_id=?", (effect_id, room_id))
    conn.commit()
    conn.close()
    return row[0]


# ── 礼物特效覆盖 ──

def list_gift_effects(room_id: int) -> list[dict]:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, room_id, gift_id, gift_name, video_filename, size_bytes, created_at "
        "FROM gift_effects WHERE room_id=? ORDER BY created_at DESC",
        (room_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_gift_effect_for_gift(room_id: int, gift_id: int) -> Optional[dict]:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT id, room_id, gift_id, gift_name, video_filename, size_bytes, created_at "
        "FROM gift_effects WHERE room_id=? AND gift_id=?",
        (room_id, gift_id),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def upsert_gift_effect(
    room_id: int, gift_id: int, gift_name: str, video_filename: str, size_bytes: int,
) -> dict:
    """同一 (room, gift) 再次上传直接替换；调用方负责清旧文件。"""
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        "INSERT INTO gift_effects (room_id, gift_id, gift_name, video_filename, size_bytes) "
        "VALUES (?,?,?,?,?) "
        "ON CONFLICT(room_id, gift_id) DO UPDATE SET "
        "gift_name=excluded.gift_name, video_filename=excluded.video_filename, "
        "size_bytes=excluded.size_bytes, created_at=datetime('now')",
        (room_id, gift_id, gift_name, video_filename, size_bytes),
    )
    conn.commit()
    conn.close()
    row = get_gift_effect_for_gift(room_id, gift_id)
    assert row is not None
    return row


def delete_gift_effect(room_id: int, effect_id: int) -> Optional[str]:
    """删除记录，返回旧 video_filename 供调用方清磁盘；不存在返回 None。"""
    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute(
        "SELECT video_filename FROM gift_effects WHERE id=? AND room_id=?",
        (effect_id, room_id),
    ).fetchone()
    if not row:
        conn.close()
        return None
    conn.execute("DELETE FROM gift_effects WHERE id=? AND room_id=?", (effect_id, room_id))
    conn.commit()
    conn.close()
    return row[0]


def get_entry_effect_sound_on(room_id: int) -> bool:
    """进场特效是否开声，房间级设置，存在 rooms.settings_json.entry_effect_sound_on。
    默认静音 — 浏览器源大多禁用音频自动播放，开声反而坏体验。"""
    return bool(get_room_settings(room_id).get("entry_effect_sound_on", False))


def set_entry_effect_sound_on(room_id: int, on: bool) -> None:
    s = get_room_settings(room_id)
    s["entry_effect_sound_on"] = bool(on)
    save_room_settings(room_id, s)


def get_gift_effect_test_enabled(room_id: int) -> bool:
    """弹幕「礼物特效测试<gift_id>」是否允许触发 VAP 播放，房间级设置。"""
    return bool(get_room_settings(room_id).get("gift_effect_test_enabled", True))


def set_gift_effect_test_enabled(room_id: int, on: bool) -> None:
    s = get_room_settings(room_id)
    s["gift_effect_test_enabled"] = bool(on)
    save_room_settings(room_id, s)


def apply_afdian_order(
    out_trade_no: str, room_id: int, months: int,
    total_amount: str = "", raw_json: str = "",
) -> tuple[bool, str]:
    """幂等地把一个爱发电订单应用到房间：已处理的订单直接返回 (False, "duplicate")，
    房间不存在返回 (False, "room_not_found")，成功返回 (True, new_expires_at_utc)。
    基准和 redeem_renewal_token 一致：max(now, expires_at) + months*30d。"""
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("BEGIN IMMEDIATE")
    try:
        dup = conn.execute(
            "SELECT 1 FROM afdian_orders WHERE out_trade_no=?", (out_trade_no,)
        ).fetchone()
        if dup:
            conn.execute("ROLLBACK")
            return False, "duplicate"
        exp_row = conn.execute(
            "SELECT expires_at FROM rooms WHERE room_id=?", (room_id,)
        ).fetchone()
        if not exp_row:
            conn.execute("ROLLBACK")
            return False, "room_not_found"
        now_utc = datetime.now(timezone.utc)
        base = now_utc
        if exp_row[0]:
            try:
                cur = datetime.strptime(exp_row[0], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                if cur > base:
                    base = cur
            except ValueError:
                pass
        new_exp = base + timedelta(days=30 * months)
        new_exp_str = new_exp.strftime("%Y-%m-%d %H:%M:%S")
        conn.execute(
            "UPDATE rooms SET expires_at=?, expired_reminder_count=0 WHERE room_id=?",
            (new_exp_str, room_id),
        )
        conn.execute(
            "INSERT INTO afdian_orders (out_trade_no, room_id, months, total_amount, raw_json) "
            "VALUES (?,?,?,?,?)",
            (out_trade_no, room_id, months, total_amount, raw_json),
        )
        conn.execute("COMMIT")
        return True, new_exp_str
    except Exception as e:
        conn.execute("ROLLBACK")
        return False, f"error:{e}"
    finally:
        conn.close()


def list_users() -> list[dict]:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT u.id, u.email, u.role, u.created_at, "
        "       GROUP_CONCAT(ur.room_id) AS room_ids "
        "FROM users u LEFT JOIN user_rooms ur ON ur.user_id = u.id "
        "GROUP BY u.id ORDER BY u.id"
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        ids = r["room_ids"]
        rooms = [int(x) for x in ids.split(",")] if ids else []
        result.append({
            "id": r["id"], "email": r["email"], "role": r["role"],
            "created_at": r["created_at"], "rooms": rooms,
        })
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


def update_user_role(user_id: int, role: str) -> None:
    if role not in ("admin", "staff", "user"):
        raise ValueError("invalid role")
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("UPDATE users SET role=? WHERE id=?", (role, user_id))
    conn.commit()
    conn.close()


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
    # 增量补进高价礼物名缓存：任何单次价值 > RARE_BLIND_MIN_PRICE 的礼物都收，
    # 和查询 SQL 的门槛一致，避免假命中。
    extra = event.get("extra") or {}
    if (event.get("event_type") == "gift"
            and int(extra.get("price") or 0) > RARE_BLIND_MIN_PRICE):
        gift_catalog.add(extra.get("gift_name") or "")


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
    return settings.get("auto_clip", True)


def set_room_auto_clip(room_id: int, enabled: bool):
    settings = get_room_settings(room_id)
    settings["auto_clip"] = enabled
    save_room_settings(room_id, settings)
