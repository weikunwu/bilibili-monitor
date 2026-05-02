"""特效触发引擎：维护 OBS overlay 事件队列 + 进场冷却，给 bili_client 调。

和 routes/effects.py 拆开是为了断循环 import：bili_client 顶层依赖触发器，
routes/effects.py 顶层依赖 manager，manager 顶层依赖 bili_client → 三方
循环。把触发器抽到这里，bili_client / app 不再 import routes/effects。
overlay_queue 路由仍然在 effects.py，从这里读 _session_queues 等状态。"""

import time
from collections import defaultdict, deque

from . import effect_catalog
from .config import ENTRY_EFFECT_COOLDOWN_SEC, log
from .db import get_entry_effect_for_user, get_gift_effect_for_gift


# ── 触发队列 / 冷却 ──
# 队列容量限制，防止断开的 OBS 页面让队列无限涨。
_MAX_QUEUE = 20
# 兜底单队列：没带 sid 的老 overlay 还能用；新事件没活动 session 时也先压这里，
# 等下一个 session 第一次 poll 时一次性拉走。
_pending_queues: dict[int, deque[dict]] = defaultdict(deque)
# 每个 OBS 会话独立队列，按 (room_id, sid) 存。同一房间多开 OBS = 多个 sid，
# 触发时 fan-out 到每个 alive sid 的队列里，互不影响。
_session_queues: dict[tuple[int, str], deque[dict]] = {}
_session_last_seen: dict[tuple[int, str], float] = {}
# 多久没 poll 就视为离线，新事件不再 fan-out 到它。前端默认 3s 一次 poll。
_SESSION_ACTIVE_TTL = 15.0
_last_trigger: dict[tuple[int, int], float] = {}


def _enqueue_to_overlays(room_id: int, event: dict) -> int:
    """把一条事件 fan-out 到该房间所有 alive session 的队列；同时入 legacy
    单队列兜底（容量受 _MAX_QUEUE 限制，不会无限涨）。返回 fan-out 的会话数。"""
    now = time.monotonic()
    fan = 0
    for (rid, sid), ts in list(_session_last_seen.items()):
        if rid != room_id or now - ts >= _SESSION_ACTIVE_TTL:
            continue
        q = _session_queues.setdefault((rid, sid), deque())
        q.append(event)
        while len(q) > _MAX_QUEUE:
            q.popleft()
        fan += 1
    legacy = _pending_queues[room_id]
    legacy.append(event)
    while len(legacy) > _MAX_QUEUE:
        legacy.popleft()
    return fan


def try_trigger_entry_effect(room_id: int, uid: int) -> bool:
    """在 bili_client 收到进场时调。命中且过冷却 → 入队，返回 True。
    不抛异常；任何异常吞掉并返回 False，避免影响主流程。"""
    try:
        effect = get_entry_effect_for_user(room_id, uid)
        if not effect:
            return False
        key = (room_id, uid)
        now = time.monotonic()
        last = _last_trigger.get(key)
        # 必须用 None 检查，不能 default 0.0：time.monotonic() 在进程启动时
        # 从 0 开始，重启后前 300 秒所有 bound 用户都会被误判成"冷却中"。
        if last is not None and now - last < ENTRY_EFFECT_COOLDOWN_SEC:
            return False
        _last_trigger[key] = now
        kind_label = f"preset={effect.get('preset_key')}" if effect.get("preset_key") else f"video={effect.get('video_filename')}"
        fan = _enqueue_to_overlays(room_id, {
            "kind": "user",
            "id": effect["id"],
            "uid": uid,
            "user_name": effect["user_name"],
            "preset_key": effect.get("preset_key") or "",
            # OBS overlay 用 video_filename 拼 URL（路径里带 uuid → 缓存能 immutable）
            "video_filename": effect.get("video_filename") or "",
            "enqueued_at": now,
        })
        log.info(
            f"[entry-effect] room={room_id} uid={uid} user={effect.get('user_name')!r} "
            f"入队 id={effect['id']} {kind_label}（fan-out {fan} 会话）"
        )
        return True
    except Exception as e:
        log.warning(f"[entry-effect] trigger failed room={room_id} uid={uid}: {e}")
        return False


def trigger_gift_vap(room_id: int, gift_id: int) -> bool:
    """触发礼物特效。优先级：
      1. 房主上传的覆盖视频（gift_effects 表命中）→ 播自定义视频
      2. B站 自带 VAP（effect_catalog 命中）→ 播 VAP
      3. 都无 → 不入队
    无冷却。"""
    try:
        override = get_gift_effect_for_gift(room_id, gift_id)
        if override:
            fan = _enqueue_to_overlays(room_id, {
                "kind": "gift_custom",
                "id": override["id"],
                "gift_id": gift_id,
                "gift_name": override.get("gift_name") or "",
                "video_filename": override.get("video_filename") or "",
                "enqueued_at": time.monotonic(),
            })
            log.info(f"[gift-vap] room={room_id} gift_id={gift_id} 自定义覆盖入队 id={override['id']}（fan-out {fan}）")
            return True
        hit = effect_catalog.get_by_gift(gift_id)
        if not hit:
            return False
        mp4_url, json_url = hit
        fan = _enqueue_to_overlays(room_id, {
            "kind": "gift_vap",
            "id": gift_id,
            "mp4_url": mp4_url,
            "json_url": json_url,
            "enqueued_at": time.monotonic(),
        })
        log.info(f"[gift-vap] room={room_id} gift_id={gift_id} VAP 入队（fan-out {fan}）")
        return True
    except Exception as e:
        log.warning(f"[gift-vap] trigger failed room={room_id} gift_id={gift_id}: {e}")
        return False


def purge_stale_cooldowns() -> None:
    """定时调用清过期冷却 key + 离线已久的 overlay 会话。"""
    now = time.monotonic()
    stale_cd = [k for k, ts in _last_trigger.items() if now - ts > ENTRY_EFFECT_COOLDOWN_SEC * 2]
    for k in stale_cd:
        _last_trigger.pop(k, None)
    stale_sess = [k for k, ts in _session_last_seen.items() if now - ts > _SESSION_ACTIVE_TTL * 4]
    for k in stale_sess:
        _session_last_seen.pop(k, None)
        _session_queues.pop(k, None)
