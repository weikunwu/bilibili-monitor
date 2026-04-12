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
                "guard_level": data.get("guard_level", 0), "blind_price": blind_price / 100,
            },
        }
        log.info(f"[礼物] {data.get('uname')} {action} {gift_name} x{num}")
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
        level = data.get("guard_level", 3)
        guard_name = GUARD_LEVELS.get(level, "舰长")
        event = {
            "timestamp": now, "event_type": "guard",
            "user_name": data.get("username", ""), "user_id": data.get("uid", 0),
            "content": f"开通 {guard_name}",
            "extra": {"guard_level": level, "guard_name": guard_name, "num": data.get("num", 1), "price": data.get("price", 0) / 100, "avatar": data.get("face", "")},
        }
        log.info(f"[上舰] {data.get('username', '')} 开通 {guard_name}")
        log.info(f"[上舰原始数据] {json.dumps(data, ensure_ascii=False)}")
        return event

    elif base_cmd == "USER_TOAST_MSG":
        # Paired with GUARD_BUY; carries the actual paid price in gold seeds.
        # We don't emit an event yet — just log the payload for inspection.
        data = msg.get("data", {})
        log.info(f"[USER_TOAST_MSG] {json.dumps(data, ensure_ascii=False)}")
        return None

    return None
