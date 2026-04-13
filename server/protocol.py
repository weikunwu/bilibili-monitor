"""B站 WebSocket 协议：打包、解包、消息解析"""

import brotli
import json
import struct
import zlib
from datetime import datetime, timezone
from typing import Optional

from .config import (
    HEADER_SIZE, WS_OP_MESSAGE, WS_OP_HEARTBEAT_REPLY, WS_OP_AUTH_REPLY,
    PROTO_RAW_JSON, PROTO_ZLIB, PROTO_BROTLI, GUARD_LEVELS, log,
)

# level (1=总督 2=提督 3=舰长) → (gift_img, gift_gif) for 舰长/提督/总督一号
# from live giftPanel/giftConfig. These URLs are stable across rooms.
GUARD_ASSETS: dict[int, tuple[str, str]] = {
    1: (
        "https://s1.hdslb.com/bfs/live/52e00ca134a8a41f08b203eb5886875507e4b44e.png",
        "https://i0.hdslb.com/bfs/live/fdd8c37dc08b4a640db4895675552bc8f1550f17.gif",
    ),
    2: (
        "https://s1.hdslb.com/bfs/live/af5b620387a20a8b65b9bd6fc47cf9058a8bbd85.png",
        "https://i0.hdslb.com/bfs/live/9661cb7dee9a6cb09d6041745242974c01cde5df.gif",
    ),
    3: (
        "https://s1.hdslb.com/bfs/live/a97726f370a5aa6d5e6100b042bee848efc560f6.png",
        "https://i0.hdslb.com/bfs/live/59e40fab772acd69a273b764cd5d5b1dbab9839c.gif",
    ),
}


def make_packet(body: bytes, operation: int) -> bytes:
    header = struct.pack(
        ">IHHII", HEADER_SIZE + len(body), HEADER_SIZE, PROTO_RAW_JSON, operation, 1
    )
    return header + body


def parse_packets(data: bytes) -> list[dict]:
    results = []
    offset = 0
    while offset < len(data):
        if offset + HEADER_SIZE > len(data):
            break
        pkt_len, hdr_len, proto, op, _ = struct.unpack_from(">IHHII", data, offset)
        body = data[offset + hdr_len : offset + pkt_len]
        if op == WS_OP_MESSAGE:
            if proto == PROTO_ZLIB:
                results.extend(parse_packets(zlib.decompress(body)))
            elif proto == PROTO_BROTLI:
                results.extend(parse_packets(brotli.decompress(body)))
            elif proto == PROTO_RAW_JSON and body:
                try:
                    results.append(json.loads(body))
                except json.JSONDecodeError:
                    pass
        elif op == WS_OP_HEARTBEAT_REPLY and len(body) >= 4:
            popularity = struct.unpack(">I", body[:4])[0]
            results.append({"cmd": "_HEARTBEAT_REPLY", "popularity": popularity})
        elif op == WS_OP_AUTH_REPLY:
            results.append({"cmd": "_AUTH_REPLY"})
        offset += pkt_len
    return results


def handle_message(msg: dict) -> Optional[dict]:
    cmd = msg.get("cmd", "")
    base_cmd = cmd.split(":")[0]
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    if base_cmd == "DANMU_MSG":
        info = msg.get("info", [])
        if len(info) < 3:
            return None
        text = info[1]
        user_name = info[2][1] if len(info[2]) > 1 else "unknown"
        user_id = info[2][0] if len(info[2]) > 0 else 0
        medal = ""
        if len(info) > 3 and info[3]:
            medal_info = info[3]
            medal = f"[{medal_info[1]}|{medal_info[0]}]" if len(medal_info) > 1 else ""
        emoticon = {}
        if len(info[0]) > 13 and isinstance(info[0][13], dict):
            emo = info[0][13]
            emoticon = {
                "url": emo.get("url", ""),
                "emoticon_unique": emo.get("emoticon_unique", ""),
                "width": emo.get("width", 0),
                "height": emo.get("height", 0),
            }
        emots = {}
        if len(info[0]) > 15:
            extra_field = info[0][15]
            if isinstance(extra_field, dict):
                extra_data = extra_field
            elif isinstance(extra_field, str):
                try:
                    extra_data = json.loads(extra_field)
                except (json.JSONDecodeError, TypeError):
                    extra_data = {}
            else:
                extra_data = {}
            raw_emots = None
            if isinstance(extra_data, dict):
                raw_emots = extra_data.get("emots")
                if not raw_emots:
                    inner = extra_data.get("extra")
                    if isinstance(inner, str):
                        try:
                            inner = json.loads(inner)
                        except (json.JSONDecodeError, TypeError):
                            inner = {}
                    if isinstance(inner, dict):
                        raw_emots = inner.get("emots")
            if raw_emots and isinstance(raw_emots, dict):
                for key, val in raw_emots.items():
                    emots[key] = {
                        "url": val.get("url", ""),
                        "emoticon_id": val.get("emoticon_id", 0),
                        "width": val.get("width", 0),
                        "height": val.get("height", 0),
                    }
        event = {
            "timestamp": now,
            "event_type": "danmu",
            "user_name": user_name,
            "user_id": user_id,
            "content": text,
            "extra": {"medal": medal, "emoticon": emoticon, "emots": emots},
        }
        log.info(f"[弹幕] {medal}{user_name}: {text}")
        return event

    elif base_cmd == "SEND_GIFT":
        data = msg.get("data", {})
        gift_id = data.get("giftId", 0)
        gift_info = data.get("gift_info", {})
        gift_img = gift_info.get("img_basic", "")
        gift_gif = gift_info.get("gif", "")
        effect_id = gift_info.get("effect_id", 0)
        blind = data.get("blind_gift") or {}
        blind_name = ""
        blind_price = 0
        if blind and isinstance(blind, dict):
            blind_name = blind.get("gift_name") or blind.get("original_gift_name") or ""
            blind_price = blind.get("original_gift_price", 0)
        action = data.get("action", "投喂")
        gift_name = data.get("giftName", "")
        if blind_name:
            action = f"{blind_name} 爆出"
        num = data.get("num", 1)
        price = data.get("price", 0)
        event = {
            "timestamp": now,
            "event_type": "gift",
            "user_name": data.get("uname", ""),
            "user_id": data.get("uid", 0),
            "content": f"{gift_name} x{num}",
            "extra": {
                "gift_name": gift_name, "gift_id": gift_id, "num": num,
                "total_coin": price * num / 100,
                "price": price / 100, "action": action, "blind_name": blind_name,
                "avatar": data.get("face", ""), "gift_img": gift_img, "gift_gif": gift_gif,
                "effect_id": effect_id,
                "guard_level": data.get("guard_level", 0), "blind_price": blind_price / 100,
            },
        }
        log.info(f"[礼物] {data.get('uname')} {action} {gift_name} x{num}")
        if price >= 100000:  # ≥ ¥1000: log raw payload so we can spot SVGA/effect fields
            log.info(f"[礼物原始数据] {json.dumps(data, ensure_ascii=False)}")
        return event

    elif base_cmd == "SUPER_CHAT_MESSAGE":
        data = msg.get("data", {})
        user_info = data.get("user_info", {})
        event = {
            "timestamp": now, "event_type": "superchat",
            "user_name": user_info.get("uname", ""), "user_id": data.get("uid", 0),
            "content": data.get("message", ""),
            "extra": {
                "price": data.get("price", 0) * 10, "duration": data.get("time", 0),
                "background_color": data.get("background_color", ""),
                "avatar": user_info.get("face", ""),
            },
        }
        log.info(f"[SC|¥{data.get('price', 0)}] {user_info.get('uname', '')}: {data.get('message', '')}")
        log.info(f"[SC原始数据] {json.dumps(data, ensure_ascii=False)}")
        return event

    elif base_cmd == "GUARD_BUY":
        data = msg.get("data", {})
        log.info(f"[上舰] {data.get('username', '')} 开通 {GUARD_LEVELS.get(data.get('guard_level', 3), '舰长')}")
        log.info(f"[上舰原始数据] {json.dumps(data, ensure_ascii=False)}")
        # Partial: caller merges with paired USER_TOAST_MSG via GuardPairer.
        return {"_partial": "guard_buy", "data": data}

    elif base_cmd == "USER_TOAST_MSG":
        data = msg.get("data", {})
        log.info(f"[USER_TOAST_MSG] {json.dumps(data, ensure_ascii=False)}")
        return {"_partial": "user_toast", "data": data}

    # Unknown cmd: log raw payload to discover fields (e.g. gift animation mp4/svga URLs).
    # Skip noisy cmds we've already confirmed uninteresting.
    if base_cmd and base_cmd not in _UNKNOWN_CMD_SKIP:
        try:
            raw = json.dumps(msg, ensure_ascii=False)
        except Exception:
            raw = str(msg)
        if len(raw) > 4000:
            raw = raw[:4000] + "...[truncated]"
        log.info(f"[未知cmd|{base_cmd}] {raw}")
    return None


_UNKNOWN_CMD_SKIP = {
    "INTERACT_WORD", "INTERACT_WORD_V2", "ENTRY_EFFECT", "ONLINE_RANK_COUNT", "ONLINE_RANK_V2",
    "ONLINE_RANK_TOP3", "ONLINE_RANK_V3", "STOP_LIVE_ROOM_LIST", "WATCHED_CHANGE", "LIKE_INFO_V3_CLICK",
    "LIKE_INFO_V3_UPDATE", "POPULARITY_RED_POCKET_START", "POPULARITY_RED_POCKET_NEW",
    "POPULARITY_RED_POCKET_WINNER_LIST", "NOTICE_MSG", "ROOM_REAL_TIME_MESSAGE_UPDATE",
    "HOT_RANK_CHANGED", "HOT_RANK_CHANGED_V2", "HOT_RANK_SETTLEMENT", "HOT_RANK_SETTLEMENT_V2",
    "WIDGET_BANNER", "ROOM_CHANGE", "PREPARING", "LIVE", "ROOM_BLOCK_MSG",
    "DM_INTERACTION", "PK_BATTLE_PROCESS_NEW", "PK_BATTLE_PROCESS", "PK_BATTLE_SETTLE",
    "PK_BATTLE_SETTLE_USER", "PK_BATTLE_SETTLE_V2", "PK_BATTLE_END", "PK_BATTLE_START_NEW",
    "PK_BATTLE_PRE_NEW", "PK_BATTLE_PRE", "PK_BATTLE_START", "PK_BATTLE_MATCH_TIMEOUT", "PK_INFO",
    "RECOMMEND_CARD", "TRADING_SCORE", "GIFT_STAR_PROCESS", "WIDGET_GIFT_STAR_PROCESS_V2", "COMBO_SEND",
    "LIVE_INTERACTIVE_GAME", "LITTLE_MESSAGE_BOX", "POPULAR_RANK_CHANGED",
    "VOICE_JOIN_LIST", "VOICE_JOIN_ROOM_COUNT_INFO", "VOICE_JOIN_STATUS",
    "GUARD_HONOR_THOUSAND", "RANK_REM", "AREA_RANK_CHANGED", "POPULAR_RANK_GUIDE_CARD",
    "SUPER_CHAT_ENTRANCE", "DANMU_AGGREGATION", "LOG_IN_NOTICE", "UNIVERSAL_EVENT_GIFT", "UNIVERSAL_EVENT_GIFT_V2",
}


def build_guard_event(guard_buy: Optional[dict], toast: Optional[dict]) -> dict:
    """Merge GUARD_BUY (avatar, level, username) and USER_TOAST_MSG (paid
    price, op_type) into a single guard event. Either side may be None if
    the partner timed out."""
    src = toast or guard_buy or {}
    level = (guard_buy or {}).get("guard_level") or (toast or {}).get("guard_level") or 3
    guard_name = GUARD_LEVELS.get(level, "舰长")
    img, gif = GUARD_ASSETS.get(level, ("", ""))
    extra: dict = {
        "guard_level": level,
        "guard_name": guard_name,
        "num": src.get("num", 1),
        "avatar": (guard_buy or {}).get("face", ""),
        "gift_img": img,
        "gift_gif": gif,
    }
    if toast:
        extra["price"] = toast.get("price", 0) / 100  # gold seeds → 电池
        if "op_type" in toast:
            extra["op_type"] = toast["op_type"]
    # op_type: 2 = 续费, 3 = 新开 (USER_TOAST_MSG only)
    content = "续费" if (toast and toast.get("op_type") == 2) else "开通"
    return {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "event_type": "guard",
        "user_name": src.get("username", ""),
        "user_id": src.get("uid", 0),
        "content": content,
        "extra": extra,
    }
