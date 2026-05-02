"""进场特效：主播给指定 UID 绑定一个视频，观众进房时 OBS 叠加页播放。

架构：
  上传 (multipart POST) → 存到 DATA_DIR/entry_effects/<room_id>/<uuid>.<ext>，DB 写一条 (room_id, uid)。
  bili_client 收到 INTERACT_WORD msg_type=1 → 查 entry_effects → 命中且过 5 分钟冷却 → push 到
  _pending_queues[room_id]。
  OBS 叠加页 (/overlay/<room_id>/effects?token=...) 每 1.5s poll 一次
  /api/overlay/<room_id>/effects/queue，拿到就播。

视频文件对外两条路（URL 里带 video_filename = <uuid>.<ext>，upsert 替换内容
时 uuid 变 → URL 变 → CDN/浏览器自动失效旧缓存，所以可以放心 immutable 一年）：
  • 已登录房主 /api/rooms/<rid>/effects/entries/<eid>/v/<filename>
  • OBS 公开 /api/overlay/<rid>/effects/entries/<eid>/v/<filename>?token=...
"""

import time
import uuid
from collections import defaultdict, deque
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File, Form, Query
from fastapi.responses import FileResponse

from ..auth import require_room_access
from ..config import (
    ENTRY_EFFECT_ROOT, ENTRY_EFFECT_MAX_BYTES, ENTRY_EFFECT_ALLOWED_EXT,
    ENTRY_EFFECT_MAX_UIDS_PER_ROOM, ENTRY_EFFECT_COOLDOWN_SEC, GIFT_EFFECT_ROOT, log,
)
from .. import effect_catalog
from ..db import (
    list_entry_effects, get_entry_effect_for_user, upsert_entry_effect, delete_entry_effect,
    count_entry_effects,
    get_entry_effect_sound_on, set_entry_effect_sound_on,
    get_gift_effect_test_enabled, set_gift_effect_test_enabled,
    list_gift_effects, get_gift_effect_for_gift, upsert_gift_effect, delete_gift_effect,
    verify_overlay_token, is_room_expired,
)
from ..manager import manager

router = APIRouter()


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


def _effect_video_path(room_id: int, filename: str) -> Path:
    return ENTRY_EFFECT_ROOT / str(room_id) / filename


def _ext_of(name: str) -> str:
    i = name.rfind(".")
    return name[i:].lower() if i >= 0 else ""


_PRESET_KEYS = {"plane_banner", "heart_float", "firework", "sparkle"}


def _ensure_uid_not_streamer(room_id: int, uid: int) -> None:
    """主播自己进场被触发侧 _maybe_trigger_entry_effect 直接过滤掉，绑了等于
    白占 ENTRY_EFFECT_MAX_UIDS_PER_ROOM 名额还误导主播以为坏了。在绑定入口
    拦掉。client 没起 / streamer_uid 还没拉到（值为 0）时放行，避免误伤。"""
    client = manager.get(room_id)
    if client and client.streamer_uid and uid == client.streamer_uid:
        raise HTTPException(400, "无法给主播自己绑定进场特效（主播进场不会触发）")


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


def _purge_orphans_in(root: Path, list_records) -> int:
    """通用：对每个 room 子目录，删 DB 没记录的文件。list_records(room_id)
    返回 dict 列表，每条要有 video_filename 字段。"""
    if not root.exists():
        return 0
    deleted = 0
    for room_dir in root.iterdir():
        if not room_dir.is_dir():
            continue
        try:
            room_id = int(room_dir.name)
        except ValueError:
            continue
        try:
            valid = {
                r["video_filename"] for r in list_records(room_id)
                if r.get("video_filename")
            }
        except Exception as e:
            log.warning(f"[effect-orphan] 扫孤儿时读 DB 失败 room={room_id}: {e}")
            continue
        for f in room_dir.iterdir():
            if not f.is_file() or f.name in valid:
                continue
            try:
                f.unlink()
                deleted += 1
            except Exception as e:
                log.warning(f"[effect-orphan] 清理失败 {f}: {e}")
    return deleted


def purge_orphan_effect_files() -> int:
    """扫 ENTRY_EFFECT_ROOT 和 GIFT_EFFECT_ROOT，删 DB 没记录的孤儿。返回总删除数。"""
    return (
        _purge_orphans_in(ENTRY_EFFECT_ROOT, list_entry_effects)
        + _purge_orphans_in(GIFT_EFFECT_ROOT, list_gift_effects)
    )


# ── 已登录房主 API ──

@router.get("/api/rooms/{room_id}/effects/entries")
async def list_effects(room_id: int, _=Depends(require_room_access)):
    return list_entry_effects(room_id)


@router.get("/api/rooms/{room_id}/effects/settings")
async def get_settings(room_id: int, _=Depends(require_room_access)):
    return {
        "sound_on": get_entry_effect_sound_on(room_id),
        "gift_effect_test_enabled": get_gift_effect_test_enabled(room_id),
    }


@router.patch("/api/rooms/{room_id}/effects/settings")
async def update_settings(room_id: int, request: Request, _=Depends(require_room_access)):
    body = await request.json()
    if "sound_on" in body:
        set_entry_effect_sound_on(room_id, bool(body.get("sound_on")))
    if "gift_effect_test_enabled" in body:
        set_gift_effect_test_enabled(room_id, bool(body.get("gift_effect_test_enabled")))
    return {
        "sound_on": get_entry_effect_sound_on(room_id),
        "gift_effect_test_enabled": get_gift_effect_test_enabled(room_id),
    }


@router.post("/api/rooms/{room_id}/effects/entries")
async def upload_effect(
    room_id: int,
    uid: int = Form(...),
    user_name: str = Form(""),
    file: UploadFile = File(...),
    _=Depends(require_room_access),
):
    if uid <= 0:
        raise HTTPException(400, "uid 无效")
    _ensure_uid_not_streamer(room_id, uid)
    ext = _ext_of(file.filename or "")
    if ext not in ENTRY_EFFECT_ALLOWED_EXT:
        raise HTTPException(400, f"只支持 {'/'.join(sorted(ENTRY_EFFECT_ALLOWED_EXT))}")

    # 新 uid 时做容量检查；老 uid 是覆盖上传不占新名额。先校验再读文件，
    # 避免到达上限的用户白白上传大文件。
    old = get_entry_effect_for_user(room_id, uid)
    if old is None and count_entry_effects(room_id) >= ENTRY_EFFECT_MAX_UIDS_PER_ROOM:
        raise HTTPException(400, f"每个房间最多为 {ENTRY_EFFECT_MAX_UIDS_PER_ROOM} 个 UID 绑定进场特效")

    # 读到内存做大小校验。10MB 可控；后续要升得更大再改成流式分片。
    data = await file.read()
    if len(data) > ENTRY_EFFECT_MAX_BYTES:
        raise HTTPException(400, f"文件超过 {ENTRY_EFFECT_MAX_BYTES // 1024 // 1024}MB")
    if not data:
        raise HTTPException(400, "空文件")

    room_dir = ENTRY_EFFECT_ROOT / str(room_id)
    room_dir.mkdir(parents=True, exist_ok=True)
    new_filename = f"{uuid.uuid4().hex}{ext}"
    new_path = room_dir / new_filename
    new_path.write_bytes(data)
    row = upsert_entry_effect(
        room_id, uid, (user_name or "").strip(),
        video_filename=new_filename, preset_key="", size_bytes=len(data),
    )
    log.info(f"[entry-effect] room={room_id} uid={uid} user={user_name!r} 上传视频 {new_filename}（{len(data) // 1024}KB）")
    if old and old.get("video_filename") and old["video_filename"] != new_filename:
        try:
            (room_dir / old["video_filename"]).unlink(missing_ok=True)
        except Exception as e:
            log.warning(f"[entry-effect] 旧文件删除失败 {old['video_filename']}: {e}")
    return row


@router.post("/api/rooms/{room_id}/effects/entries/preset")
async def upload_preset_effect(
    room_id: int,
    request: Request,
    _=Depends(require_room_access),
):
    """绑定一个预设动画给 UID。和上传等价但不落文件，OBS 叠加页拿
    preset_key 自己渲染。"""
    body = await request.json()
    uid = int(body.get("uid") or 0)
    user_name = (body.get("user_name") or "").strip()
    preset_key = (body.get("preset_key") or "").strip()
    if uid <= 0:
        raise HTTPException(400, "uid 无效")
    _ensure_uid_not_streamer(room_id, uid)
    if preset_key not in _PRESET_KEYS:
        raise HTTPException(400, "预设不存在")

    # Upsert：如果旧记录是上传类型，把磁盘文件清掉
    old = get_entry_effect_for_user(room_id, uid)
    if old is None and count_entry_effects(room_id) >= ENTRY_EFFECT_MAX_UIDS_PER_ROOM:
        raise HTTPException(400, f"每个房间最多为 {ENTRY_EFFECT_MAX_UIDS_PER_ROOM} 个 UID 绑定进场特效")
    row = upsert_entry_effect(
        room_id, uid, user_name,
        video_filename="", preset_key=preset_key, size_bytes=0,
    )
    log.info(f"[entry-effect] room={room_id} uid={uid} user={user_name!r} 绑定预设 {preset_key}")
    if old and old.get("video_filename"):
        try:
            (ENTRY_EFFECT_ROOT / str(room_id) / old["video_filename"]).unlink(missing_ok=True)
        except Exception as e:
            log.warning(f"[entry-effect] 旧文件删除失败 {old['video_filename']}: {e}")
    return row


@router.delete("/api/rooms/{room_id}/effects/entries/{effect_id}")
async def remove_effect(room_id: int, effect_id: int, _=Depends(require_room_access)):
    filename = delete_entry_effect(room_id, effect_id)
    if filename is None:
        raise HTTPException(404, "记录不存在")
    log.info(f"[entry-effect] room={room_id} 删除 id={effect_id} 文件={filename!r}")
    if filename:
        try:
            _effect_video_path(room_id, filename).unlink(missing_ok=True)
        except Exception as e:
            log.warning(f"[entry-effect] 文件清理失败: {e}")
    return {"ok": True}


@router.get("/api/rooms/{room_id}/effects/entries/{effect_id}/v/{filename}")
async def serve_effect_auth(room_id: int, effect_id: int, filename: str, _=Depends(require_room_access)):
    # URL 带 filename → upsert 替换时 URL 变 → 缓存自动失效，可以放心 1 年 immutable。
    # private 因为要登录鉴权，CDN 不能共享缓存；只让主播浏览器本地缓存。
    return _serve_effect_file(
        room_id, effect_id,
        expected_filename=filename,
        cache_control="private, max-age=31536000, immutable",
    )


# ── OBS 公开端点（token 鉴权） ──

@router.get("/api/overlay/{room_id}/effects/queue")
async def overlay_queue(room_id: int, token: str = Query(...), sid: str = Query("")):
    if not verify_overlay_token(room_id, token):
        log.warning(f"[overlay-queue] room={room_id} token 无效（前缀 {token[:6]!r}…），返回 403")
        raise HTTPException(403, "token 无效")
    if is_room_expired(room_id):
        raise HTTPException(410, "房间已到期")

    if sid:
        key = (room_id, sid)
        if key not in _session_queues:
            _session_queues[key] = deque()
            # 第一次注册：legacy 队列里如果有积累的事件搬一份过来，避免在 session
            # 注册前已被入到 legacy 的事件被漏掉。注意 legacy 不 popleft——可能还有
            # 别的没 sid 的老 overlay tab 在等。
            legacy = _pending_queues.get(room_id)
            if legacy:
                _session_queues[key].extend(legacy)
        _session_last_seen[key] = time.monotonic()
        q = _session_queues[key]
    else:
        q = _pending_queues[room_id]

    pending: list[dict] = []
    while q:
        pending.append(q.popleft())
    return {"events": pending, "sound_on": get_entry_effect_sound_on(room_id)}


@router.get("/api/overlay/{room_id}/effects/entries/{effect_id}/v/{filename}")
async def serve_effect_overlay(room_id: int, effect_id: int, filename: str, token: str = Query(...)):
    if not verify_overlay_token(room_id, token):
        raise HTTPException(403, "token 无效")
    # OBS 浏览器源 + token 鉴权 → public 让 CF 共享缓存；filename 在 URL 里
    # 保证 upsert 替换内容时 URL 变，CF 自动取新内容
    return _serve_effect_file(
        room_id, effect_id,
        expected_filename=filename,
        cache_control="public, max-age=31536000, immutable",
    )


def _serve_effect_file(
    room_id: int, effect_id: int, *,
    expected_filename: str,
    cache_control: str,
) -> FileResponse:
    # 从 DB 查记录而不是直接拼 URL filename — 防路径遍历 + 确认记录存在。
    # URL filename 必须等于 DB 里的 video_filename；不等说明客户端拿着 stale URL
    # （记录被 upsert 替换、UUID 变了），返 404 让前端 refetch list 拿新 URL。
    conn_rows = list_entry_effects(room_id)
    match: Optional[dict] = next((r for r in conn_rows if r["id"] == effect_id), None)
    if not match:
        raise HTTPException(404, "视频不存在")
    if match["video_filename"] != expected_filename:
        raise HTTPException(404, "filename 不匹配（视频已被替换，请刷新）")
    path = _effect_video_path(room_id, match["video_filename"])
    if not path.exists():
        raise HTTPException(404, "文件缺失")
    return FileResponse(str(path), headers={"Cache-Control": cache_control})


# ── 礼物特效覆盖 ──

def _gift_effect_video_path(room_id: int, filename: str) -> Path:
    return GIFT_EFFECT_ROOT / str(room_id) / filename


def _serve_gift_effect_file(
    room_id: int, effect_id: int, *,
    expected_filename: str,
    cache_control: str,
) -> FileResponse:
    rows = list_gift_effects(room_id)
    match: Optional[dict] = next((r for r in rows if r["id"] == effect_id), None)
    if not match:
        raise HTTPException(404, "视频不存在")
    if match["video_filename"] != expected_filename:
        raise HTTPException(404, "filename 不匹配（视频已被替换，请刷新）")
    path = _gift_effect_video_path(room_id, match["video_filename"])
    if not path.exists():
        raise HTTPException(404, "文件缺失")
    return FileResponse(str(path), headers={"Cache-Control": cache_control})


@router.get("/api/rooms/{room_id}/effects/gifts")
async def list_gift_overrides(room_id: int, _=Depends(require_room_access)):
    return list_gift_effects(room_id)


@router.post("/api/rooms/{room_id}/effects/gifts")
async def upload_gift_override(
    room_id: int,
    gift_id: int = Form(...),
    gift_name: str = Form(""),
    file: UploadFile = File(...),
    _=Depends(require_room_access),
):
    if gift_id <= 0:
        raise HTTPException(400, "gift_id 无效")
    ext = _ext_of(file.filename or "")
    if ext not in ENTRY_EFFECT_ALLOWED_EXT:
        raise HTTPException(400, f"只支持 {'/'.join(sorted(ENTRY_EFFECT_ALLOWED_EXT))}")
    data = await file.read()
    if len(data) > ENTRY_EFFECT_MAX_BYTES:
        raise HTTPException(400, f"文件超过 {ENTRY_EFFECT_MAX_BYTES // 1024 // 1024}MB")
    if not data:
        raise HTTPException(400, "空文件")

    room_dir = GIFT_EFFECT_ROOT / str(room_id)
    room_dir.mkdir(parents=True, exist_ok=True)
    new_filename = f"{uuid.uuid4().hex}{ext}"
    (room_dir / new_filename).write_bytes(data)

    old = get_gift_effect_for_gift(room_id, gift_id)
    row = upsert_gift_effect(
        room_id, gift_id, (gift_name or "").strip(),
        video_filename=new_filename, size_bytes=len(data),
    )
    log.info(f"[gift-effect] room={room_id} gift_id={gift_id} name={gift_name!r} 上传视频 {new_filename}（{len(data) // 1024}KB）")
    if old and old.get("video_filename") and old["video_filename"] != new_filename:
        try:
            (room_dir / old["video_filename"]).unlink(missing_ok=True)
        except Exception as e:
            log.warning(f"[gift-effect] 旧文件删除失败 {old['video_filename']}: {e}")
    return row


@router.delete("/api/rooms/{room_id}/effects/gifts/{effect_id}")
async def remove_gift_override(room_id: int, effect_id: int, _=Depends(require_room_access)):
    filename = delete_gift_effect(room_id, effect_id)
    if filename is None:
        raise HTTPException(404, "记录不存在")
    log.info(f"[gift-effect] room={room_id} 删除 id={effect_id} 文件={filename!r}")
    if filename:
        try:
            _gift_effect_video_path(room_id, filename).unlink(missing_ok=True)
        except Exception as e:
            log.warning(f"[gift-effect] 文件清理失败: {e}")
    return {"ok": True}


@router.get("/api/rooms/{room_id}/effects/gifts/{effect_id}/v/{filename}")
async def serve_gift_effect_auth(
    room_id: int, effect_id: int, filename: str, _=Depends(require_room_access),
):
    return _serve_gift_effect_file(
        room_id, effect_id,
        expected_filename=filename,
        cache_control="private, max-age=31536000, immutable",
    )


@router.get("/api/overlay/{room_id}/effects/gifts/{effect_id}/v/{filename}")
async def serve_gift_effect_overlay(
    room_id: int, effect_id: int, filename: str, token: str = Query(...),
):
    if not verify_overlay_token(room_id, token):
        raise HTTPException(403, "token 无效")
    return _serve_gift_effect_file(
        room_id, effect_id,
        expected_filename=filename,
        cache_control="public, max-age=31536000, immutable",
    )
