"""进场特效：主播给指定 UID 绑定一个视频，观众进房时 OBS 叠加页播放。

架构：
  上传 (multipart POST) → 存到 DATA_DIR/entry_effects/<room_id>/<uuid>.<ext>，DB 写一条 (room_id, uid)。
  bili_client 收到 INTERACT_WORD msg_type=1 → 查 entry_effects → 命中且过 5 分钟冷却 → push 到
  _pending_queues[room_id]。
  OBS 叠加页 (/overlay/<room_id>/effects?token=...) 每 1.5s poll 一次
  /api/overlay/<room_id>/effects/queue，拿到就播。

视频文件对外两条路：
  • 已登录房主 /api/rooms/<id>/effects/entries/<eid>/video
  • OBS 公开 /api/overlay/<room_id>/effects/entries/<eid>/video?token=...
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
    ENTRY_EFFECT_COOLDOWN_SEC, log,
)
from .. import effect_catalog
from ..db import (
    list_entry_effects, get_entry_effect_for_user, upsert_entry_effect, delete_entry_effect,
    get_entry_effect_sound_on, set_entry_effect_sound_on,
    get_gift_effect_test_enabled, set_gift_effect_test_enabled,
    verify_overlay_token,
)

router = APIRouter()


# ── 触发队列 / 冷却 ──
# 队列容量限制，防止断开的 OBS 页面让队列无限涨。
_MAX_QUEUE = 20
_pending_queues: dict[int, deque[dict]] = defaultdict(deque)
_last_trigger: dict[tuple[int, int], float] = {}


def _effect_video_path(room_id: int, filename: str) -> Path:
    return ENTRY_EFFECT_ROOT / str(room_id) / filename


def _ext_of(name: str) -> str:
    i = name.rfind(".")
    return name[i:].lower() if i >= 0 else ""


def try_trigger_entry_effect(room_id: int, uid: int) -> bool:
    """在 bili_client 收到进场时调。命中且过冷却 → 入队，返回 True。
    不抛异常；任何异常吞掉并返回 False，避免影响主流程。"""
    try:
        effect = get_entry_effect_for_user(room_id, uid)
        if not effect:
            return False
        key = (room_id, uid)
        now = time.monotonic()
        last = _last_trigger.get(key, 0.0)
        if now - last < ENTRY_EFFECT_COOLDOWN_SEC:
            return False
        _last_trigger[key] = now
        q = _pending_queues[room_id]
        q.append({
            "kind": "user",
            "id": effect["id"],
            "uid": uid,
            "user_name": effect["user_name"],
            "enqueued_at": now,
        })
        while len(q) > _MAX_QUEUE:
            q.popleft()
        log.info(f"[entry-effect] room={room_id} uid={uid} 入队 effect id={effect['id']}")
        return True
    except Exception as e:
        log.warning(f"[entry-effect] trigger failed room={room_id} uid={uid}: {e}")
        return False


def trigger_gift_vap_test(room_id: int, gift_id: int) -> bool:
    """弹幕测试命令触发：从 effect_catalog 查 gift_id 的 VAP mp4，入同一条 OBS 队列。
    命中返回 True；无对应特效或异常返回 False（不走冷却，测试场景允许多发）。"""
    try:
        hit = effect_catalog.get_by_gift(gift_id)
        if not hit:
            log.info(f"[gift-vap-test] room={room_id} gift_id={gift_id} 无全屏特效")
            return False
        mp4_url, json_url = hit
        q = _pending_queues[room_id]
        q.append({
            "kind": "gift_vap",
            "id": gift_id,
            "mp4_url": mp4_url,
            "json_url": json_url,
            "enqueued_at": time.monotonic(),
        })
        while len(q) > _MAX_QUEUE:
            q.popleft()
        log.info(f"[gift-vap-test] room={room_id} gift_id={gift_id} 入队")
        return True
    except Exception as e:
        log.warning(f"[gift-vap-test] failed room={room_id} gift_id={gift_id}: {e}")
        return False


def purge_stale_cooldowns() -> None:
    """定时调用清过期冷却 key，避免 _last_trigger 无限涨。"""
    now = time.monotonic()
    stale = [k for k, ts in _last_trigger.items() if now - ts > ENTRY_EFFECT_COOLDOWN_SEC * 2]
    for k in stale:
        _last_trigger.pop(k, None)


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
    ext = _ext_of(file.filename or "")
    if ext not in ENTRY_EFFECT_ALLOWED_EXT:
        raise HTTPException(400, f"只支持 {'/'.join(sorted(ENTRY_EFFECT_ALLOWED_EXT))}")

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

    # Upsert：旧文件要从磁盘删掉
    old = get_entry_effect_for_user(room_id, uid)
    row = upsert_entry_effect(room_id, uid, (user_name or "").strip(), new_filename, len(data))
    if old and old["video_filename"] != new_filename:
        try:
            (room_dir / old["video_filename"]).unlink(missing_ok=True)
        except Exception as e:
            log.warning(f"[entry-effect] 旧文件删除失败 {old['video_filename']}: {e}")
    return row


@router.delete("/api/rooms/{room_id}/effects/entries/{effect_id}")
async def remove_effect(room_id: int, effect_id: int, _=Depends(require_room_access)):
    filename = delete_entry_effect(room_id, effect_id)
    if filename is None:
        raise HTTPException(404, "记录不存在")
    try:
        _effect_video_path(room_id, filename).unlink(missing_ok=True)
    except Exception as e:
        log.warning(f"[entry-effect] 文件清理失败: {e}")
    return {"ok": True}


@router.get("/api/rooms/{room_id}/effects/entries/{effect_id}/video")
async def serve_effect_auth(room_id: int, effect_id: int, _=Depends(require_room_access)):
    return _serve_effect_file(room_id, effect_id)


# ── OBS 公开端点（token 鉴权） ──

@router.get("/api/overlay/{room_id}/effects/queue")
async def overlay_queue(room_id: int, token: str = Query(...)):
    if not verify_overlay_token(room_id, token):
        raise HTTPException(403, "token 无效")
    q = _pending_queues[room_id]
    pending: list[dict] = []
    while q:
        pending.append(q.popleft())
    return {"events": pending, "sound_on": get_entry_effect_sound_on(room_id)}


@router.get("/api/overlay/{room_id}/effects/entries/{effect_id}/video")
async def serve_effect_overlay(room_id: int, effect_id: int, token: str = Query(...)):
    if not verify_overlay_token(room_id, token):
        raise HTTPException(403, "token 无效")
    return _serve_effect_file(room_id, effect_id)


def _serve_effect_file(room_id: int, effect_id: int) -> FileResponse:
    # 从 DB 查 filename 而不是直接拼 id — 防路径遍历 + 确认记录存在
    conn_rows = list_entry_effects(room_id)
    match: Optional[dict] = next((r for r in conn_rows if r["id"] == effect_id), None)
    if not match:
        raise HTTPException(404, "视频不存在")
    path = _effect_video_path(room_id, match["video_filename"])
    if not path.exists():
        raise HTTPException(404, "文件缺失")
    return FileResponse(str(path))
