"""房间和指令 API"""

import asyncio
import time
from collections import OrderedDict, defaultdict, deque
from datetime import datetime, timezone

import aiohttp
from fastapi import APIRouter, Depends, Query, Request, HTTPException
from fastapi.responses import HTMLResponse

from .. import recorder
from ..db import (
    get_room_commands, save_command_state, save_command_config, get_command, get_all_rooms,
    get_room_save_danmu, set_room_save_danmu, get_room_auto_clip, set_room_auto_clip,
    list_nicknames, upsert_nickname, delete_nickname, list_room_users,
    list_banned_nickname_words, add_banned_nickname_word, delete_banned_nickname_word,
    nickname_is_banned,
    get_or_create_overlay_token, rotate_overlay_token,
    add_room as db_add_room, add_user_room, remove_user_room, is_room_claimed,
    count_user_rooms,
    get_overlay_settings, update_overlay_settings, clear_overlay_history,
    get_room_expires_at, redeem_renewal_token,
)
from ..auth import require_room_access
from ..config import ROOM_INFO_API, H5_ROOM_INFO_API, MASTER_INFO_API, HEADERS
from ..manager import manager

router = APIRouter()


async def _fetch_room_info(room_id: int) -> dict:
    """Fetch room info from Bilibili API for rooms without a client."""
    base = {
        "room_id": room_id, "real_room_id": room_id,
        "streamer_name": "", "streamer_avatar": "", "room_title": "",
        "live_status": 0, "ruid": 0, "followers": 0,
        "area_name": "", "parent_area_name": "", "announcement": "",
        "bot_uid": 0, "bot_name": "", "active": False,
        "expires_at": None,
    }
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                ROOM_INFO_API,
                params={"room_id": room_id},
            ) as resp:
                data = await resp.json(content_type=None)
                if data.get("code") == 0:
                    info = data["data"]
                    base["real_room_id"] = info.get("room_id", room_id)
                    base["room_title"] = info.get("title", "")
                    base["live_status"] = info.get("live_status", 0)
                    base["area_name"] = info.get("area_name", "")
                    base["parent_area_name"] = info.get("parent_area_name", "")
                    ruid = info.get("uid", 0)
                    base["ruid"] = ruid
                    if ruid:
                        async with session.get(
                            MASTER_INFO_API,
                            params={"uid": ruid},
                        ) as resp2:
                            d2 = await resp2.json(content_type=None)
                            if d2.get("code") == 0:
                                base["streamer_name"] = d2["data"]["info"].get("uname", "")
                                base["streamer_avatar"] = d2["data"]["info"].get("face", "")
                                base["followers"] = d2["data"].get("follower_num", 0)
    except Exception:
        pass
    return base


# B站 info 冷启动并发上限：多房间同时 ensure_info 容易打到 B站 速率限制，
# 用 semaphore 压成最多 5 个在飞。gather 仍会等全部完成，信息不丢。
_INFO_FETCH_SEM = asyncio.Semaphore(5)


async def _ensure_info_limited(client):
    async with _INFO_FETCH_SEM:
        return await client.ensure_info()


async def _refresh_bot_identity_limited(client):
    async with _INFO_FETCH_SEM:
        return await client.refresh_bot_identity()


@router.get("/api/rooms")
async def get_rooms(request: Request):
    allowed = getattr(request.state, "allowed_rooms", None)
    db_rooms = get_all_rooms()

    # Lazy fetch: ensure room info and bot_name are loaded for clients that
    # haven't fetched yet. bot_name is populated by WS connect flow; rooms
    # with cookie but active=0 never hit that path, so backfill here.
    clients_to_fetch = []
    for room_id, _ in db_rooms:
        if allowed is not None and room_id not in allowed:
            continue
        c = manager.get(room_id)
        if not c:
            continue
        if not c._info_fetched:
            clients_to_fetch.append(_ensure_info_limited(c))
        if c.cookies.get("SESSDATA") and not c.bot_name:
            clients_to_fetch.append(_refresh_bot_identity_limited(c))
    if clients_to_fetch:
        await asyncio.gather(*clients_to_fetch, return_exceptions=True)

    result = []
    for room_id, active in db_rooms:
        if allowed is not None and room_id not in allowed:
            continue
        c = manager.get(room_id)
        if c:
            result.append({
                "room_id": c.room_id,
                "real_room_id": c.real_room_id,
                "streamer_name": c.streamer_name,
                "streamer_avatar": c.streamer_avatar,
                "room_title": c.room_title,
                "live_status": c.live_status if c._running else 0,
                "streamer_uid": c.streamer_uid,
                "followers": c.followers,

                "area_name": c.area_name,
                "parent_area_name": c.parent_area_name,
                "announcement": c.announcement,
                "bot_uid": c.bot_uid if c.cookies.get("SESSDATA") else 0,
                "bot_name": c.bot_name if c.cookies.get("SESSDATA") else "",
                "needs_relogin": bool(c._needs_relogin and c.cookies.get("SESSDATA")),
                "active": c._running,
                "save_danmu": get_room_save_danmu(room_id),
                "expires_at": get_room_expires_at(room_id),
            })
        else:
            # No client in memory — fetch basic info from Bilibili API
            info = await _fetch_room_info(room_id)
            info["active"] = bool(active)
            info["save_danmu"] = get_room_save_danmu(room_id)
            info["expires_at"] = get_room_expires_at(room_id)
            result.append(info)
    return result


# ── 绑定/解绑接口防滥用 ──
# 每个用户在 window 秒内最多 limit 次操作；超过返回 429。
# 绑定操作会调 B站 API + 可能触发 WS 客户端创建，阀值严一些；
# 解绑是本地 DB 操作，阀值稍宽。
_ROOM_MUTATION_LIMIT = {
    "bind": (10, 60.0),
    "unbind": (30, 60.0),
}
_MAX_ROOMS_PER_USER = 20
_user_mutation_buckets: dict[str, dict[int, deque[float]]] = defaultdict(lambda: defaultdict(deque))


def _check_user_mutation_rate(user_id: int, bucket: str):
    limit, window = _ROOM_MUTATION_LIMIT[bucket]
    q = _user_mutation_buckets[bucket][user_id]
    now = time.time()
    cutoff = now - window
    while q and q[0] < cutoff:
        q.popleft()
    if len(q) >= limit:
        raise HTTPException(status_code=429, detail="操作过于频繁，请稍后再试")
    q.append(now)


def purge_stale_rate_limits() -> None:
    """清理已失效的限流记录：deque 内会自动 trim 旧时间戳，但 user_id 级别
    的 key 永远不会被删；长跑后 key 越积越多。按 bucket 的窗口扫一遍。"""
    now = time.time()
    for bucket, (_, window) in _ROOM_MUTATION_LIMIT.items():
        cutoff = now - window
        m = _user_mutation_buckets.get(bucket) or {}
        for uid in list(m.keys()):
            q = m[uid]
            while q and q[0] < cutoff:
                q.popleft()
            if not q:
                m.pop(uid, None)
    # 兑换码尝试：超过窗口即可清
    stale = [uid for uid, (_, ts) in _redeem_attempts.items() if now - ts > _REDEEM_WINDOW_SECONDS]
    for uid in stale:
        _redeem_attempts.pop(uid, None)


async def _room_exists_on_bili(room_id: int) -> bool:
    """向 B站 校验房间号是否有效。网络异常视为 False（宁缺毋滥）。"""
    try:
        async with aiohttp.ClientSession(headers=HEADERS) as session:
            async with session.get(
                ROOM_INFO_API, params={"room_id": room_id},
                timeout=aiohttp.ClientTimeout(total=8),
            ) as resp:
                data = await resp.json(content_type=None)
                # code 0 且 uid 非 0 才算真实存在（空房间/错误房号 B站 会给不同错误码或空 uid）
                return data.get("code") == 0 and int((data.get("data") or {}).get("uid") or 0) > 0
    except Exception:
        return False


@router.post("/api/rooms/{room_id}/bind")
async def bind_room_self(room_id: int, request: Request):
    """登录用户自助绑定房间（不存在则先创建再绑定）。

    规则：
      - 房间号 ≤ 0 → 拒绝
      - 房间不存在于 B站 → 拒绝
      - 房间已被任何用户绑定 → 拒绝（已绑定账号）
      - 房间存在但未绑定 → 分配给当前用户（非管理员）
      - 房间不存在 → 校验后创建并分配（非管理员）
    管理员在此接口下不做自动分配，本身已能看到所有房间。"""
    if room_id <= 0:
        raise HTTPException(400, "房间号无效")

    user_id = getattr(request.state, "user_id", None)
    is_admin = getattr(request.state, "user_role", "") == "admin"
    if user_id is None:
        raise HTTPException(401, "未登录")

    # 限流先行：就算房号非法也要消耗配额，否则可以无限探测 B站。
    if not is_admin:
        _check_user_mutation_rate(user_id, "bind")
        if count_user_rooms(user_id) >= _MAX_ROOMS_PER_USER:
            if _MAX_ROOMS_PER_USER == 1:
                raise HTTPException(400, "一个账号只能绑定一个房间，请先解绑当前房间")
            raise HTTPException(400, f"单账号最多绑定 {_MAX_ROOMS_PER_USER} 个房间")

    existing = {r[0] for r in get_all_rooms()}
    already = room_id in existing

    if already and is_room_claimed(room_id):
        raise HTTPException(400, "该房间已绑定其他账号")

    if not already:
        if not await _room_exists_on_bili(room_id):
            raise HTTPException(400, "房间号不存在或无法访问")
        db_add_room(room_id)
        client = manager.add_room(room_id)
        await client.ensure_info()

    if not is_admin:
        add_user_room(user_id, room_id)

    return {"ok": True, "room_id": room_id}


@router.post("/api/rooms/{room_id}/unbind")
async def unbind_room_self(room_id: int, request: Request, _=Depends(require_room_access)):
    """解绑当前账号与房间的绑定：只删 user_rooms 映射，房间本身保留。
    普通用户无权删除房间，房间删除统一走 /api/admin/rooms。"""
    is_admin = getattr(request.state, "user_role", "") == "admin"
    if is_admin:
        raise HTTPException(400, "管理员账号无需解绑")
    user_id = getattr(request.state, "user_id", None)
    if user_id is None:
        raise HTTPException(401, "未登录")
    _check_user_mutation_rate(user_id, "unbind")
    ok = remove_user_room(user_id, room_id)
    if not ok:
        raise HTTPException(404, "房间未绑定到当前账号")
    # 房间绑定唯一（bind 时会拒绝已被其他账号占用的房间），解绑后没有非管理员
    # 用户再用它，直接停止监听；管理员若需要可在管理后台重新启动。
    if manager.has(room_id):
        manager.stop_room(room_id)
    return {"ok": True, "room_id": room_id}


@router.get("/api/commands")
async def list_commands(room_id: int = Query(...), _=Depends(require_room_access)):
    return get_room_commands(room_id)


@router.post("/api/rooms/{room_id}/stop")
async def stop_room(room_id: int, _=Depends(require_room_access)):
    if not manager.has(room_id):
        raise HTTPException(404, "房间不存在")
    manager.stop_room(room_id)
    return {"ok": True, "room_id": room_id}


@router.post("/api/rooms/{room_id}/start")
async def start_room(room_id: int, request: Request, _=Depends(require_room_access)):
    client = manager.get(room_id)
    if client and client._running:
        raise HTTPException(400, "房间已在运行中")
    is_admin = getattr(request.state, "user_role", "") == "admin"
    if not is_admin and client and not client.cookies.get("SESSDATA"):
        raise HTTPException(400, "请先绑定机器人后再启动监控")
    exp = get_room_expires_at(room_id)
    if not is_admin and exp:
        from datetime import datetime, timezone
        now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        if exp <= now_utc:
            raise HTTPException(400, "房间已到期，请续费后再启动")
    await manager.start_room(room_id)
    return {"ok": True, "room_id": room_id}


# 续费码兑换限流：失败 5 次/小时锁定，成功清零。token 本身 128-bit 熵
# 不怕爆破，这里主要防 DoS / 误操作刷锁。
_redeem_attempts: dict[int, tuple[int, float]] = defaultdict(lambda: (0, 0.0))
_MAX_REDEEM_ATTEMPTS = 5
_REDEEM_WINDOW_SECONDS = 3600


@router.post("/api/rooms/{room_id}/redeem")
async def redeem_room_token(room_id: int, request: Request, _=Depends(require_room_access)):
    user_id = getattr(request.state, "user_id", 0) or 0
    now = time.time()
    fails, first_time = _redeem_attempts[user_id]
    if fails >= _MAX_REDEEM_ATTEMPTS and now - first_time < _REDEEM_WINDOW_SECONDS:
        raise HTTPException(429, "尝试次数过多，请 1 小时后再试")
    if now - first_time >= _REDEEM_WINDOW_SECONDS:
        _redeem_attempts[user_id] = (0, 0.0)

    body = await request.json()
    token = str(body.get("token", "")).strip()
    if not token:
        raise HTTPException(400, "请输入续费码")
    ok, info = redeem_renewal_token(token, user_id, room_id)
    if not ok:
        fails, first_time = _redeem_attempts[user_id]
        _redeem_attempts[user_id] = (fails + 1, first_time or now)
        raise HTTPException(400, info)
    _redeem_attempts.pop(user_id, None)
    return {"ok": True, "expires_at": info}


@router.post("/api/rooms/{room_id}/save-danmu")
async def toggle_save_danmu(room_id: int, request: Request, _=Depends(require_room_access)):
    body = await request.json()
    enabled = bool(body.get("enabled", True))
    set_room_save_danmu(room_id, enabled)
    return {"ok": True, "room_id": room_id, "save_danmu": enabled}


@router.get("/api/rooms/{room_id}/background")
async def get_room_background(room_id: int, _=Depends(require_room_access)):
    """Return the H5-mobile portrait background URL set by the anchor.
    Empty string when unset — the client compose falls back to a solid
    dark fill in that case. Fetched on demand (not cached) so the clip
    download path is always against the current value."""
    url = ""
    try:
        async with aiohttp.ClientSession(headers=HEADERS) as s:
            async with s.get(H5_ROOM_INFO_API, params={"room_id": room_id}) as r:
                d = await r.json(content_type=None)
                if d.get("code") == 0:
                    ri = (d.get("data") or {}).get("room_info") or {}
                    url = ri.get("app_background") or ""
    except Exception:
        pass
    return {"url": url}


async def _fetch_streamer_info_one(room_id: int) -> dict:
    """Fetch latest streamer display info (name/avatar/followers) from B站.
    Updates the in-memory client cache so WS broadcasts carry the fresh values."""
    client = manager.get(room_id)
    uid = client.streamer_uid if client else 0
    if not uid:
        try:
            async with _INFO_FETCH_SEM, aiohttp.ClientSession(headers=HEADERS) as session:
                async with session.get(ROOM_INFO_API, params={"room_id": room_id}) as resp:
                    d = await resp.json(content_type=None)
                    if d.get("code") == 0:
                        uid = (d.get("data") or {}).get("uid") or 0
        except Exception:
            pass
    if not uid:
        return {"streamer_uid": 0, "streamer_name": "", "streamer_avatar": "", "followers": 0}
    try:
        async with _INFO_FETCH_SEM, aiohttp.ClientSession(headers=HEADERS) as session:
            async with session.get(MASTER_INFO_API, params={"uid": uid}) as resp:
                d = await resp.json(content_type=None)
        info = (d.get("data") or {}).get("info") or {}
        name = info.get("uname", "") or ""
        face = info.get("face", "") or ""
        followers = (d.get("data") or {}).get("follower_num", 0) or 0
        if client:
            client.streamer_name = name or client.streamer_name
            client.streamer_avatar = face or client.streamer_avatar
            client.followers = followers or client.followers
        return {"streamer_uid": uid, "streamer_name": name, "streamer_avatar": face, "followers": followers}
    except Exception:
        return {"streamer_uid": uid, "streamer_name": "", "streamer_avatar": "", "followers": 0}


@router.get("/api/rooms/streamer-info")
async def get_streamer_info_batch(request: Request, ids: str = ""):
    """Batch endpoint: ?ids=1,2,3 → {1: {...}, 2: {...}, ...}.
    被前端 RoomList 用来一次拉全所有房间主播资料，避免 N+1 请求。"""
    room_ids: list[int] = []
    for x in ids.split(","):
        s = x.strip()
        if s.isdigit():
            room_ids.append(int(s))
    allowed = getattr(request.state, "allowed_rooms", None)
    if allowed is not None:
        room_ids = [r for r in room_ids if r in allowed]
    if not room_ids:
        return {}
    results = await asyncio.gather(
        *(_fetch_streamer_info_one(r) for r in room_ids), return_exceptions=True,
    )
    return {
        r: res for r, res in zip(room_ids, results)
        if not isinstance(res, BaseException)
    }


@router.get("/api/rooms/{room_id}/streamer-info")
async def get_streamer_info(room_id: int, _=Depends(require_room_access)):
    return await _fetch_streamer_info_one(room_id)


@router.get("/api/rooms/{room_id}/auto-clip")
async def get_auto_clip(room_id: int, _=Depends(require_room_access)):
    return {"enabled": get_room_auto_clip(room_id)}


@router.post("/api/rooms/{room_id}/auto-clip")
async def toggle_auto_clip(room_id: int, request: Request, _=Depends(require_room_access)):
    body = await request.json()
    enabled = bool(body.get("enabled", False))
    set_room_auto_clip(room_id, enabled)
    # Apply immediately to the running client: start/stop recorder now so the
    # user doesn't have to wait for the next reconnect.
    client = manager.get(room_id)
    if client:
        if enabled and client.live_status == 1:
            asyncio.create_task(recorder.start_for(client.real_room_id, client.cookies))
        elif not enabled:
            asyncio.create_task(recorder.stop_for(client.real_room_id))
    return {"ok": True, "room_id": room_id, "auto_clip": enabled}


@router.get("/api/rooms/{room_id}/overlay-token")
async def get_overlay_token(room_id: int, request: Request, _=Depends(require_room_access)):
    uid = getattr(request.state, "user_id", None)
    token = get_or_create_overlay_token(room_id, uid)
    return {"room_id": room_id, "token": token}


@router.post("/api/rooms/{room_id}/overlay-token/rotate")
async def rotate_overlay_token_route(room_id: int, request: Request, _=Depends(require_room_access)):
    uid = getattr(request.state, "user_id", None)
    token = rotate_overlay_token(room_id, uid)
    return {"room_id": room_id, "token": token}


@router.get("/api/rooms/{room_id}/overlay-settings")
async def get_overlay_settings_route(room_id: int, _=Depends(require_room_access)):
    return get_overlay_settings(room_id)


@router.put("/api/rooms/{room_id}/overlay-settings")
async def put_overlay_settings_route(room_id: int, request: Request, _=Depends(require_room_access)):
    body = await request.json()
    patch: dict = {}
    if "max_events" in body:
        v = int(body["max_events"])
        if v < 1 or v > 20:
            raise HTTPException(400, "max_events 必须在 1~20 之间")
        patch["max_events"] = v
    if "min_price" in body:
        patch["min_price"] = max(0, int(body["min_price"]))
    if "max_price" in body:
        patch["max_price"] = max(0, int(body["max_price"]))
    if "price_mode" in body:
        mode = str(body["price_mode"])
        if mode not in ("total", "unit"):
            raise HTTPException(400, "price_mode 必须是 total 或 unit")
        patch["price_mode"] = mode
    for k in ("show_gift", "show_blind", "show_guard", "show_superchat"):
        if k in body:
            patch[k] = bool(body[k])
    if "time_range" in body:
        tr = str(body["time_range"])
        if tr not in ("today", "week", "live"):
            raise HTTPException(400, "time_range 必须是 today / week / live")
        patch["time_range"] = tr
    if "scroll_enabled" in body:
        patch["scroll_enabled"] = bool(body["scroll_enabled"])
    if "scroll_speed" in body:
        patch["scroll_speed"] = max(0, min(100, int(body["scroll_speed"])))
    # 合理性：max_price > 0 时必须 >= min_price
    merged = {**get_overlay_settings(room_id), **patch}
    if merged["max_price"] and merged["max_price"] < merged["min_price"]:
        raise HTTPException(400, "最高价不能小于最低价")
    return update_overlay_settings(room_id, patch)


@router.post("/api/rooms/{room_id}/overlay-settings/clear")
async def clear_overlay_history_route(room_id: int, _=Depends(require_room_access)):
    """清空当前 overlay 展示：记录一个 cleared_at (UTC now)，overlay 查询时仅返回此时间之后的事件。"""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return clear_overlay_history(room_id, now)


@router.get("/api/rooms/{room_id}/nicknames")
async def get_nicknames(room_id: int, _=Depends(require_room_access)):
    return list_nicknames(room_id)


@router.put("/api/rooms/{room_id}/nicknames/{user_id}")
async def put_nickname(room_id: int, user_id: int, request: Request, _=Depends(require_room_access)):
    body = await request.json()
    nickname = (body.get("nickname") or "").strip()
    user_name = (body.get("user_name") or "").strip()
    if not nickname:
        raise HTTPException(400, "昵称不能为空")
    upsert_nickname(room_id, user_id, user_name, nickname)
    return {"ok": True}


@router.delete("/api/rooms/{room_id}/nicknames/{user_id}")
async def remove_nickname(room_id: int, user_id: int, _=Depends(require_room_access)):
    delete_nickname(room_id, user_id)
    return {"ok": True}


@router.get("/api/rooms/{room_id}/users")
async def get_room_users(room_id: int, search: str = Query(""), _=Depends(require_room_access)):
    return list_room_users(room_id, search)


@router.get("/api/rooms/{room_id}/banned-nickname-words")
async def get_banned_nickname_words(room_id: int, _=Depends(require_room_access)):
    return list_banned_nickname_words(room_id)


@router.post("/api/rooms/{room_id}/banned-nickname-words")
async def post_banned_nickname_word(room_id: int, request: Request, _=Depends(require_room_access)):
    body = await request.json()
    word = (body.get("word") or "").strip()
    if not word:
        raise HTTPException(400, "违禁词不能为空")
    if len(word) > 20:
        raise HTTPException(400, "违禁词过长（最多20字）")
    result = add_banned_nickname_word(room_id, word)
    if not result:
        raise HTTPException(400, "违禁词已存在")
    return result


@router.delete("/api/rooms/{room_id}/banned-nickname-words/{word_id}")
async def remove_banned_nickname_word(room_id: int, word_id: int, _=Depends(require_room_access)):
    if not delete_banned_nickname_word(room_id, word_id):
        raise HTTPException(404, "违禁词不存在")
    return {"ok": True}


@router.post("/api/commands/{cmd_id}/toggle")
async def toggle_command(cmd_id: str, room_id: int = Query(...), _=Depends(require_room_access)):
    cmd = get_command(room_id, cmd_id)
    if not cmd:
        return HTMLResponse('{"error":"not found"}', status_code=404)
    cmd["enabled"] = not cmd["enabled"]
    save_command_state(room_id, cmd_id, cmd["enabled"])
    return {"id": cmd_id, "room_id": room_id, "enabled": cmd["enabled"]}


@router.post("/api/commands/{cmd_id}/config")
async def set_command_config(cmd_id: str, request: Request, room_id: int = Query(...), _=Depends(require_room_access)):
    """Per-room override for a command's config dict (merged on top of base)."""
    cmd = get_command(room_id, cmd_id)
    if not cmd:
        raise HTTPException(404, "指令不存在")
    body = await request.json()
    cfg = body.get("config") or {}
    if not isinstance(cfg, dict):
        raise HTTPException(400, "config 必须是对象")
    save_command_config(room_id, cmd_id, cfg)
    return {"id": cmd_id, "room_id": room_id, "config": cfg}


# 房间级礼物面板（只返回在该房间真正可送的礼物；全局 giftConfig 会包含不能送的）
_ROOM_GIFT_API = "https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/roomGiftConfig"

# Per-room cache: room_id -> (expiry_epoch, payload). B站礼物表几乎不变，
# 24h 足够；LRU 淘汰避免房间多了内存无界增长（~20KB/房 × 200 房 ≈ 4MB）。
_CHEAP_GIFT_CACHE: "OrderedDict[int, tuple[float, list[dict]]]" = OrderedDict()
_CHEAP_GIFT_TTL = 24 * 3600
_CHEAP_GIFT_MAX_ROOMS = 200


async def _fetch_room_gifts(room_id: int) -> tuple[list[dict], int, int]:
    """拉房间礼物列表 + 主播 uid + real_room_id。统一去重 / sort，
    具体的 price/bag/bind 过滤由调用方按需做。"""
    client = manager.get(room_id)
    real_room = client.real_room_id if client and client.real_room_id else room_id
    try:
        async with aiohttp.ClientSession(headers=HEADERS) as session:
            # 先取房间所在分区，roomGiftConfig 需要 area_parent_id / area_id 过滤分区专属礼物
            async with session.get(ROOM_INFO_API, params={"room_id": real_room}, timeout=aiohttp.ClientTimeout(total=10)) as r:
                ri = (await r.json()).get("data") or {}
            params = {
                "platform": "pc", "room_id": real_room,
                "area_parent_id": ri.get("parent_area_id", 0),
                "area_id": ri.get("area_id", 0),
            }
            async with session.get(_ROOM_GIFT_API, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                data = await resp.json()
    except Exception as e:
        raise HTTPException(502, f"礼物列表获取失败: {e}")
    # roomGiftConfig 返回结构 (实测): data.list 是该房间分区可送礼物的扁平列表，
    # 每项直接就是一个 gift 对象 (含 id/name/price/coin_type/img_basic)；
    # data.global_gift.list 是全平台通用礼物。两个合并去重即可。
    d = data.get("data") or {}
    gifts = list(d.get("list") or []) + list((d.get("global_gift") or {}).get("list") or [])
    # B站 返回顺序不稳，同名同价的不同 id 之间谁被 "保留" 会随机漂移，
    # 导致用户前次选中的 gift_id 下次不在列表里 → SelectPicker 显示为未选。
    # 固定按 id 升序再去重，保证每次保留同一个 gid。
    gifts.sort(key=lambda g: int(g.get("id") or g.get("gift_id") or 0))
    streamer_uid = client.streamer_uid if client and getattr(client, "streamer_uid", 0) else 0
    return gifts, streamer_uid, real_room


@router.get("/api/rooms/{room_id}/cheap-gifts")
async def cheap_gifts(room_id: int, _=Depends(require_room_access)):
    """单价 ≤ ¥1 (≤1000 金瓜子) 的金瓜子礼物列表，按房间实际可送过滤。
    每房间缓存 24 小时，LRU 淘汰上限 200 房，减少对 B站 的拉取。"""
    hit = _CHEAP_GIFT_CACHE.get(room_id)
    if hit and hit[0] > time.time():
        _CHEAP_GIFT_CACHE.move_to_end(room_id)  # 标记最近使用
        return hit[1]
    if hit:  # 过期，清掉
        _CHEAP_GIFT_CACHE.pop(room_id, None)

    gifts, streamer_uid, real_room = await _fetch_room_gifts(room_id)
    cheap = []
    seen_ids: set[int] = set()
    seen_keys: set[tuple[str, int]] = set()
    for g in gifts:
        gid = int(g.get("id") or g.get("gift_id") or 0)
        if not gid or gid in seen_ids:
            continue
        price = int(g.get("price") or 0)
        if g.get("coin_type") != "gold" or price <= 0 or price > 1000:
            continue
        # 房间/主播绑定礼物：B站 返回 bind_roomid / bind_ruid 非 0 时表示仅限该房间/主播。
        # 我们的机器人对其他房间送会被拒 (code 200026)，直接过滤掉。
        bind_room = int(g.get("bind_roomid") or 0)
        bind_ruid = int(g.get("bind_ruid") or 0)
        if bind_room and bind_room != real_room:
            continue
        if bind_ruid and streamer_uid and bind_ruid != streamer_uid:
            continue
        # 包裹专属礼物只能从背包送 (code 200010)，bag_gift=1
        if int(g.get("bag_gift") or 0):
            continue
        # 同名同价的礼物 B站 会返回多份 (常规版 + 活动版等)，只留第一个
        name = g.get("name") or g.get("gift_name") or ""
        key = (name, price)
        if key in seen_keys:
            continue
        seen_ids.add(gid)
        seen_keys.add(key)
        cheap.append({
            "gift_id": gid,
            "name": name,
            "price": price,
            "img": g.get("img_basic") or g.get("gift_img") or g.get("img_dynamic") or "",
        })
    cheap.sort(key=lambda x: x["price"])
    _CHEAP_GIFT_CACHE[room_id] = (time.time() + _CHEAP_GIFT_TTL, cheap)
    _CHEAP_GIFT_CACHE.move_to_end(room_id)
    while len(_CHEAP_GIFT_CACHE) > _CHEAP_GIFT_MAX_ROOMS:
        _CHEAP_GIFT_CACHE.popitem(last=False)  # 淘汰最久未用
    return cheap


# 全礼物列表（含贵礼）独立缓存。礼物特效覆盖功能用，不限价。
_ALL_GIFT_CACHE: "OrderedDict[int, tuple[float, list[dict]]]" = OrderedDict()


@router.get("/api/rooms/{room_id}/all-gifts")
async def all_gifts(room_id: int, _=Depends(require_room_access)):
    """所有金瓜子礼物（含贵礼），用于「礼物特效覆盖」选择器。和 cheap-gifts
    共享底层拉取，但不做价格上限。bind 仍然过滤——绑别的房间的礼物在本房不会
    出现在事件流，留着也无意义。bag_gift 不过滤——背包送也会触发 gift 事件。"""
    hit = _ALL_GIFT_CACHE.get(room_id)
    if hit and hit[0] > time.time():
        _ALL_GIFT_CACHE.move_to_end(room_id)
        return hit[1]
    if hit:
        _ALL_GIFT_CACHE.pop(room_id, None)

    gifts, streamer_uid, real_room = await _fetch_room_gifts(room_id)
    out = []
    seen_ids: set[int] = set()
    seen_keys: set[tuple[str, int]] = set()
    for g in gifts:
        gid = int(g.get("id") or g.get("gift_id") or 0)
        if not gid or gid in seen_ids:
            continue
        price = int(g.get("price") or 0)
        if g.get("coin_type") != "gold" or price <= 0:
            continue
        bind_room = int(g.get("bind_roomid") or 0)
        bind_ruid = int(g.get("bind_ruid") or 0)
        if bind_room and bind_room != real_room:
            continue
        if bind_ruid and streamer_uid and bind_ruid != streamer_uid:
            continue
        name = g.get("name") or g.get("gift_name") or ""
        key = (name, price)
        if key in seen_keys:
            continue
        seen_ids.add(gid)
        seen_keys.add(key)
        out.append({
            "gift_id": gid,
            "name": name,
            "price": price,
            "img": g.get("img_basic") or g.get("gift_img") or g.get("img_dynamic") or "",
        })
    out.sort(key=lambda x: x["price"], reverse=True)  # 贵的排前面，常用的好找
    _ALL_GIFT_CACHE[room_id] = (time.time() + _CHEAP_GIFT_TTL, out)
    _ALL_GIFT_CACHE.move_to_end(room_id)
    while len(_ALL_GIFT_CACHE) > _CHEAP_GIFT_MAX_ROOMS:
        _ALL_GIFT_CACHE.popitem(last=False)
    return out
