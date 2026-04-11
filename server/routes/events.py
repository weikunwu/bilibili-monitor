"""事件查询、统计、礼物汇总 API"""

import io
import json
import sqlite3
import time
from datetime import datetime, timezone, timedelta
from typing import Optional

import aiohttp
from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response, StreamingResponse

from ..config import DB_PATH, BASE_DIR, HEADERS, log
from ..bili_api import gift_gif_cache
from ..auth import require_room_access
from ..manager import manager

router = APIRouter()


@router.get("/api/proxy-image")
async def proxy_image(url: str = Query(...)):
    """代理 B站 CDN 图片，解决前端 CORS 问题"""
    if not url.startswith("https://") and not url.startswith("http://"):
        return Response(status_code=400)
    try:
        async with aiohttp.ClientSession(headers=HEADERS) as session:
            async with session.get(url) as resp:
                content_type = resp.headers.get("Content-Type", "image/png")
                data = await resp.read()
                return Response(content=data, media_type=content_type, headers={
                    "Cache-Control": "public, max-age=86400",
                    "Access-Control-Allow-Origin": "*",
                })
    except Exception:
        return Response(status_code=502)


def _today_utc_range(tz_offset: Optional[int] = None) -> tuple[str, str]:
    if tz_offset is not None:
        user_tz = timezone(timedelta(minutes=-tz_offset))
    else:
        user_tz = timezone.utc
    user_now = datetime.now(user_tz)
    user_today_start = user_now.replace(hour=0, minute=0, second=0, microsecond=0)
    user_today_end = user_today_start + timedelta(days=1)
    utc_start = user_today_start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    utc_end = user_today_end.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return utc_start, utc_end


@router.get("/api/events")
async def get_events(
    room_id: int = Query(...),
    type: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    time_from: Optional[str] = Query(None),
    time_to: Optional[str] = Query(None),
    _=Depends(require_room_access),
):
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conditions = ["room_id=?"]
    params: list = [room_id]
    if type:
        conditions.append("event_type=?")
        params.append(type)
    if time_from:
        conditions.append("timestamp>=?")
        params.append(time_from)
    if time_to:
        conditions.append("timestamp<=?")
        params.append(time_to)
    where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
    rows = conn.execute(
        f"SELECT * FROM events{where} ORDER BY id DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@router.get("/api/stats")
async def get_stats(room_id: int = Query(...), _=Depends(require_room_access)):
    conn = sqlite3.connect(str(DB_PATH))
    rp = [room_id]
    total = conn.execute("SELECT COUNT(*) FROM events WHERE room_id=?", rp).fetchone()[0]
    danmaku_count = conn.execute("SELECT COUNT(*) FROM events WHERE event_type='danmaku' AND room_id=?", rp).fetchone()[0]
    gift_count = conn.execute("SELECT COUNT(*) FROM events WHERE event_type='gift' AND room_id=?", rp).fetchone()[0]
    sc_count = conn.execute("SELECT COUNT(*) FROM events WHERE event_type='superchat' AND room_id=?", rp).fetchone()[0]
    guard_count = conn.execute("SELECT COUNT(*) FROM events WHERE event_type='guard' AND room_id=?", rp).fetchone()[0]
    sc_rows = conn.execute("SELECT extra_json FROM events WHERE event_type='superchat' AND room_id=?", rp).fetchall()
    sc_total = 0
    for row in sc_rows:
        try:
            extra = json.loads(row[0])
            sc_total += extra.get("price", 0)
        except Exception:
            pass
    conn.close()
    client = manager.get(room_id)
    pop = client.popularity if client else 0
    return {
        "total": total, "danmaku": danmaku_count, "gift": gift_count,
        "superchat": sc_count, "guard": guard_count, "sc_total_price": sc_total,
        "popularity": pop,
    }


def _build_gift_users(rows) -> dict:
    users: dict = {}
    for user_name, user_id, extra_json in rows:
        extra = json.loads(extra_json)
        key = user_name or str(user_id)
        if key not in users:
            users[key] = {
                "user_name": user_name, "avatar": extra.get("avatar", ""),
                "gifts": {}, "gift_coins": {}, "gift_imgs": {}, "gift_actions": {},
                "guard_level": 0, "total_coin": 0, "gift_ids": {},
            }
        gift_name = extra.get("gift_name", "?")
        num = extra.get("num", 1)
        users[key]["gifts"][gift_name] = users[key]["gifts"].get(gift_name, 0) + num
        tc = extra.get("total_coin", 0)
        users[key]["total_coin"] += tc
        users[key]["gift_coins"][gift_name] = users[key]["gift_coins"].get(gift_name, 0) + tc
        if not users[key]["avatar"] and extra.get("avatar"):
            users[key]["avatar"] = extra["avatar"]
        gift_img = extra.get("gift_img", "")
        if gift_img and gift_name not in users[key]["gift_imgs"]:
            users[key]["gift_imgs"][gift_name] = gift_img
        action = extra.get("action", "投喂")
        blind_name = extra.get("blind_name", "")
        if gift_name not in users[key]["gift_actions"]:
            users[key]["gift_actions"][gift_name] = f"{blind_name} 爆出" if blind_name else action
        gid = extra.get("gift_id", 0)
        if gid and gift_name not in users[key]["gift_ids"]:
            users[key]["gift_ids"][gift_name] = gid
            gif_url = gift_gif_cache.get(gid, "")
            if gif_url:
                users[key].setdefault("gift_gifs", {})[gift_name] = gif_url
        gl = extra.get("guard_level", 0)
        if gl and (not users[key]["guard_level"] or gl < users[key]["guard_level"]):
            users[key]["guard_level"] = gl

    return users


@router.get("/api/gift-summary")
async def gift_summary(
    room_id: int = Query(...),
    date: Optional[str] = Query(None),
    user_name: Optional[str] = Query(None),
    _=Depends(require_room_access),
):
    beijing_tz = timezone(timedelta(hours=8))
    conn = sqlite3.connect(str(DB_PATH))
    if date:
        where = "event_type='gift' AND room_id=? AND timestamp LIKE ?"
        params: list = [room_id, date + "%"]
    else:
        now_bj = datetime.now(beijing_tz)
        bj_start = now_bj.replace(hour=0, minute=0, second=0, microsecond=0)
        bj_end = bj_start + timedelta(days=1)
        utc_start = bj_start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        utc_end = bj_end.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        where = "event_type='gift' AND room_id=? AND timestamp >= ? AND timestamp < ?"
        params = [room_id, utc_start, utc_end]
    if user_name:
        where += " AND user_name=?"
        params.append(user_name)
    rows = conn.execute(f"SELECT user_name, user_id, extra_json FROM events WHERE {where}", params).fetchall()
    conn.close()

    users = _build_gift_users(rows)
    result = sorted(users.values(), key=lambda x: x["total_coin"], reverse=True)
    display_date = date if date else datetime.now(beijing_tz).strftime("%Y-%m-%d")
    return {"date": display_date, "users": result}


@router.get("/api/gift-gif")
async def get_gift_gif(gift_id: int = Query(...)):
    gif_url = gift_gif_cache.get(gift_id, "")
    return {"gift_id": gift_id, "gif": gif_url}


@router.get("/api/gift-gif-card")
async def gift_gif_card(
    user_name: str = Query(...),
    gift_name: str = Query(...),
    tz_offset: Optional[int] = Query(None),
):
    from PIL import Image as PILImage, ImageDraw, ImageFont, ImageSequence

    utc_start, utc_end = _today_utc_range(tz_offset)
    conn = sqlite3.connect(str(DB_PATH))
    rows = conn.execute(
        "SELECT user_name, user_id, extra_json FROM events WHERE event_type='gift' AND timestamp >= ? AND timestamp < ? AND user_name=?",
        (utc_start, utc_end, user_name),
    ).fetchall()
    conn.close()

    users = _build_gift_users(rows)
    u = list(users.values())[0] if users else None
    if not u:
        return {"error": "未找到用户礼物数据"}

    gift_ids = u.get("gift_ids", {})
    gid = gift_ids.get(gift_name, 0)
    gif_url = gift_gif_cache.get(gid, "")
    if not gif_url:
        return {"error": "该礼物没有动态图"}

    gift_coins = u.get("gift_coins", {})
    yuan = gift_coins.get(gift_name, 0) / 1000
    tpl_name = "gold" if yuan >= 1000 else "pink" if yuan >= 500 else "purple" if yuan >= 100 else "blue"
    tpl_path = BASE_DIR / "static" / f"card_tpl_{tpl_name}.png"

    S = 2
    card_tpl_raw = PILImage.open(tpl_path).convert("RGBA")
    cw, ch = card_tpl_raw.size[0] * S, card_tpl_raw.size[1] * S
    card_tpl = card_tpl_raw.resize((cw, ch), PILImage.LANCZOS)

    avatar_size = 56 * S
    avatar_img = None
    if u.get("avatar"):
        try:
            async with aiohttp.ClientSession(headers=HEADERS) as session:
                async with session.get(u["avatar"]) as resp:
                    avatar_img = PILImage.open(io.BytesIO(await resp.read())).convert("RGBA").resize((avatar_size, avatar_size))
        except Exception:
            pass

    frame_size = 78 * S
    guard_frame_img = None
    gl = u.get("guard_level", 0)
    if gl in (1, 2, 3):
        try:
            frame_path = BASE_DIR / "static" / f"guard_frame_{gl}.png"
            guard_frame_img = PILImage.open(frame_path).convert("RGBA").resize((frame_size, frame_size), PILImage.LANCZOS)
        except Exception:
            pass

    try:
        async with aiohttp.ClientSession(headers=HEADERS) as session:
            async with session.get(gif_url) as resp:
                gif_data = await resp.read()
        gift_gif = PILImage.open(io.BytesIO(gif_data))
    except Exception:
        return {"error": "下载 GIF 失败"}

    try:
        font_bold = ImageFont.truetype("/System/Library/Fonts/STHeiti Medium.ttc", 20 * S)
        font_normal = ImageFont.truetype("/System/Library/Fonts/STHeiti Medium.ttc", 15 * S)
        font_action = ImageFont.truetype("/System/Library/Fonts/STHeiti Light.ttc", 15 * S)
        font_num = ImageFont.truetype("/Library/Fonts/Arial Unicode.ttf", 30 * S)
    except Exception:
        font_bold = ImageFont.load_default()
        font_normal = font_bold
        font_action = font_bold
        font_num = font_bold

    num = u["gifts"].get(gift_name, 0)
    action = u.get("gift_actions", {}).get(gift_name, "投喂")
    gif_size = 54 * S
    frames = []
    durations = []

    avatar_mask = PILImage.new("L", (avatar_size, avatar_size), 0)
    ImageDraw.Draw(avatar_mask).ellipse((0, 0, avatar_size - 1, avatar_size - 1), fill=255)
    acx, acy = 36 * S, ch // 2
    ar = avatar_size // 2

    for _, frame in enumerate(ImageSequence.Iterator(gift_gif)):
        card = card_tpl.copy()
        draw = ImageDraw.Draw(card)
        if avatar_img:
            card.paste(avatar_img, (acx - ar, acy - ar), avatar_mask)
        if guard_frame_img:
            card.paste(guard_frame_img, (acx - frame_size // 2, acy - frame_size // 2), guard_frame_img)
        tx = (acx + 46 * S) if guard_frame_img else (acx + ar + 12 * S)
        draw.text((tx, ch // 2 - 24 * S), u["user_name"], fill=(255, 255, 255), font=font_bold)
        text_y = ch // 2 + 2 * S
        if "爆出" in action:
            parts = action.split(" 爆出")
            draw.text((tx, text_y), parts[0], fill=(255, 224, 102), font=font_normal)
            aw = font_normal.getlength(parts[0])
            draw.text((tx + aw, text_y), " 爆出 ", fill=(255, 255, 255), font=font_action)
            aw2 = font_action.getlength(" 爆出 ")
            draw.text((tx + aw + aw2, text_y), gift_name, fill=(255, 224, 102), font=font_normal)
        else:
            draw.text((tx, text_y), f"{action} ", fill=(200, 200, 200), font=font_action)
            aw = font_action.getlength(f"{action} ")
            draw.text((tx + aw, text_y), gift_name, fill=(255, 224, 102), font=font_normal)
        right_start = int(cw * 0.65)
        gif_frame = frame.convert("RGBA").resize((gif_size, gif_size), PILImage.LANCZOS)
        card.paste(gif_frame, (right_start, (ch - gif_size) // 2), gif_frame)
        num_x = right_start + gif_size + 8 * S
        num_y = ch // 2 - 14 * S
        num_text = f"x {num}"
        for dx, dy in [(-2,-2),(-2,0),(-2,2),(0,-2),(0,2),(2,-2),(2,0),(2,2),(-3,0),(3,0),(0,-3),(0,3)]:
            draw.text((num_x + dx, num_y + dy), num_text, fill=(188, 110, 45), font=font_num)
        draw.text((num_x, num_y), num_text, fill=(255, 245, 5), font=font_num)
        rgb_frame = card.convert("RGB")
        frames.append(rgb_frame)
        durations.append(gift_gif.info.get("duration", 100))

    output = io.BytesIO()
    frames[0].save(output, format="GIF", save_all=True, append_images=frames[1:], duration=durations, loop=0, disposal=2)
    output.seek(0)
    return StreamingResponse(output, media_type="image/gif", headers={"Content-Disposition": f"attachment; filename=gift_{int(time.time())}.gif"})
