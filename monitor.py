"""B站直播间全事件监控系统"""

import argparse
import asyncio
import brotli
import io
import json
import logging
import sqlite3
import struct
import time
import zlib
from datetime import datetime
from pathlib import Path
from typing import Optional

import base64
import hashlib
import re
from collections import defaultdict
from urllib.parse import urlencode
from cryptography.fernet import Fernet

import aiohttp
import qrcode
import requests
import os
import secrets

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, Request, HTTPException, Depends
from fastapi.responses import FileResponse, StreamingResponse, RedirectResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("bilibili-monitor")

BASE_DIR = Path(__file__).parent
DATA_DIR = Path(os.environ.get("DATA_DIR", str(BASE_DIR)))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "gifts.db"

# ── Protocol constants ──────────────────────────────────────────────

HEADER_SIZE = 16
WS_OP_HEARTBEAT = 2
WS_OP_HEARTBEAT_REPLY = 3
WS_OP_MESSAGE = 5
WS_OP_AUTH = 7
WS_OP_AUTH_REPLY = 8

PROTO_RAW_JSON = 0
PROTO_HEARTBEAT = 1
PROTO_ZLIB = 2
PROTO_BROTLI = 3

DANMU_CONF_API = "https://api.live.bilibili.com/room/v1/Danmu/getConf"
DANMU_INFO_API = "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo"
ROOM_INFO_API = "https://api.live.bilibili.com/room/v1/Room/get_info"

COOKIE_FILE = DATA_DIR / "cookies.json"
GIFT_CONFIG_API = "https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/giftConfig"

# gift_id -> img_url cache, gift_id -> price cache, gift_id -> gif_url cache
gift_img_cache: dict[int, str] = {}
gift_price_cache: dict[int, int] = {}  # gift_id -> price in gold coins
gift_gif_cache: dict[int, str] = {}  # gift_id -> gif url (for expensive gifts)

# ── Wbi Signing ─────────────────────────────────────────────────────

WBI_KEY_INDEX_TABLE = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
]
NAV_API = "https://api.bilibili.com/x/web-interface/nav"

_wbi_key_cache = ""


async def get_wbi_key(headers: dict) -> str:
    global _wbi_key_cache
    if _wbi_key_cache:
        return _wbi_key_cache
    async with aiohttp.ClientSession(headers=headers) as session:
        async with session.get(NAV_API) as resp:
            data = await resp.json(content_type=None)
            if data.get("code") != 0:
                return ""
            wbi_img = data["data"]["wbi_img"]
            img_key = wbi_img["img_url"].rsplit("/", 1)[-1].split(".")[0]
            sub_key = wbi_img["sub_url"].rsplit("/", 1)[-1].split(".")[0]
            raw = img_key + sub_key
            _wbi_key_cache = "".join(raw[i] for i in WBI_KEY_INDEX_TABLE if i < len(raw))
            return _wbi_key_cache


def wbi_sign(params: dict, wbi_key: str) -> dict:
    params["wts"] = int(time.time())
    sorted_params = sorted(params.items())
    filtered = [(k, re.sub(r"[!'()*]", "", str(v))) for k, v in sorted_params]
    query = urlencode(filtered)
    w_rid = hashlib.md5((query + wbi_key).encode()).hexdigest()
    params["w_rid"] = w_rid
    return params

QR_GENERATE_API = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
QR_POLL_API = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"

GUARD_LEVELS = {1: "总督", 2: "提督", 3: "舰长"}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Referer": "https://live.bilibili.com/",
    "Origin": "https://live.bilibili.com",
}

# ── QR Code Login ───────────────────────────────────────────────────


def _get_fernet() -> Fernet:
    key_src = os.environ.get("COOKIE_SECRET", os.environ.get("AUTH_PASSWORD_ALL", os.environ.get("AUTH_PASSWORD", "bilibili-monitor-default")))
    key = base64.urlsafe_b64encode(hashlib.sha256(key_src.encode()).digest())
    return Fernet(key)


def save_cookies(cookies: dict):
    data = json.dumps(cookies, ensure_ascii=False).encode()
    encrypted = _get_fernet().encrypt(data)
    with open(COOKIE_FILE, "wb") as f:
        f.write(encrypted)
    log.info("Cookie 已加密保存到 cookies.json")


def load_cookies() -> dict:
    if COOKIE_FILE.exists():
        try:
            with open(COOKIE_FILE, "rb") as f:
                encrypted = f.read()
            cookies = json.loads(_get_fernet().decrypt(encrypted))
            if cookies.get("SESSDATA"):
                log.info(f"从 cookies.json 加载登录信息 (UID: {cookies.get('DedeUserID', '?')})")
                return cookies
        except Exception:
            # 兼容旧的明文格式，读取后重新加密保存
            try:
                with open(COOKIE_FILE, "r") as f:
                    cookies = json.load(f)
                if cookies.get("SESSDATA"):
                    log.info("迁移明文 cookies.json 为加密格式")
                    save_cookies(cookies)
                    return cookies
            except Exception:
                log.warning("无法读取 cookies.json，将重新登录")
    return {}


def qr_login() -> dict:
    """交互式扫码登录，返回 cookies dict"""
    log.info("开始扫码登录...")

    # 1. 生成二维码
    resp = requests.get(QR_GENERATE_API, headers=HEADERS)
    data = resp.json()
    if data.get("code") != 0:
        log.error(f"生成二维码失败: {data}")
        return {}

    qr_url = data["data"]["url"]
    qrcode_key = data["data"]["qrcode_key"]

    # 2. 在终端显示二维码
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_L, box_size=1, border=1)
    qr.add_data(qr_url)
    qr.make(fit=True)

    f = io.StringIO()
    qr.print_ascii(out=f, invert=True)
    print("\n请使用哔哩哔哩 APP 扫描下方二维码登录:\n")
    print(f.getvalue())
    print("等待扫码...")

    # 3. 轮询登录状态
    session = requests.Session()
    while True:
        time.sleep(2)
        resp = session.get(QR_POLL_API, params={"qrcode_key": qrcode_key}, headers=HEADERS)
        poll_data = resp.json().get("data", {})
        code = poll_data.get("code", -1)

        if code == 0:
            print("登录成功!")
            # 从 Set-Cookie 获取 cookies
            cookies = {}
            for key in ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"):
                val = session.cookies.get(key) or resp.cookies.get(key)
                if val:
                    cookies[key] = val
            # 也从 response url 中解析 refresh_token
            url_str = poll_data.get("url", "")
            if "refresh_token=" in url_str:
                cookies["refresh_token"] = url_str.split("refresh_token=")[-1].split("&")[0]
            save_cookies(cookies)
            return cookies
        elif code == 86101:
            pass  # 未扫码，继续等待
        elif code == 86090:
            print("已扫码，请在手机上确认...")
        elif code == 86038:
            log.error("二维码已过期，请重新运行")
            return {}
        else:
            log.error(f"未知状态: {code}")
            return {}


# room_id -> { uid -> guard_level } cache
guard_cache: dict[int, dict[int, int]] = {}


async def load_guard_list(room_id: int, headers: dict):
    """加载直播间大航海列表"""
    try:
        async with aiohttp.ClientSession(headers=headers) as session:
            # Get ruid first
            async with session.get(ROOM_INFO_API, params={"room_id": room_id}) as resp:
                data = await resp.json(content_type=None)
                if data.get("code") != 0:
                    return
                ruid = data["data"]["uid"]

            guards = {}
            for page in range(1, 10):
                async with session.get(
                    "https://api.live.bilibili.com/xlive/app-room/v2/guardTab/topList",
                    params={"roomid": room_id, "ruid": ruid, "page": page, "page_size": 50},
                ) as resp:
                    data = await resp.json(content_type=None)
                    if data.get("code") != 0:
                        break
                    d = data["data"]
                    for g in d.get("top3", []) + d.get("list", []):
                        guards[g["uid"]] = g["guard_level"]
                    if not d.get("list"):
                        break

            guard_cache[room_id] = guards
            log.info(f"加载大航海列表 (房间 {room_id}): {len(guards)} 人")
    except Exception as e:
        log.error(f"加载大航海列表失败 (房间 {room_id}): {e}")


async def load_gift_config(headers: dict):
    """加载礼物配置，缓存 gift_id -> img_url"""
    try:
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get(GIFT_CONFIG_API, params={"platform": "pc"}) as resp:
                data = await resp.json(content_type=None)
                if data.get("code") == 0:
                    for g in data["data"].get("list", []):
                        gift_img_cache[g["id"]] = g.get("img_basic", "")
                        gift_price_cache[g["id"]] = g.get("price", 0)
                        gif_url = g.get("gif", "")
                        if gif_url and g.get("price", 0) >= 2000000:
                            gift_gif_cache[g["id"]] = gif_url
                    log.info(f"加载礼物配置: {len(gift_img_cache)} 种礼物")
    except Exception as e:
        log.error(f"加载礼物配置失败: {e}")


# ── Database ────────────────────────────────────────────────────────


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
    # Add room_id column if upgrading from old schema
    try:
        conn.execute("ALTER TABLE events ADD COLUMN room_id INTEGER DEFAULT 0")
    except Exception:
        pass
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id)")
    conn.commit()
    conn.close()


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


# ── Packet encoding / decoding ──────────────────────────────────────


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


# ── Message handlers ────────────────────────────────────────────────


def handle_message(msg: dict) -> Optional[dict]:
    cmd = msg.get("cmd", "")
    # Some cmds have version suffixes like DANMU_MSG:4:0:2:2:2:0
    base_cmd = cmd.split(":")[0]
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

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
        # Large sticker emoticon: info[0][13]
        emoticon = {}
        if len(info[0]) > 13 and isinstance(info[0][13], dict):
            emo = info[0][13]
            emoticon = {
                "url": emo.get("url", ""),
                "emoticon_unique": emo.get("emoticon_unique", ""),
                "width": emo.get("width", 0),
                "height": emo.get("height", 0),
            }
        # Inline small emojis: info[0][15] -> extra -> emots
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
            if not raw_emots and "[" in text:
                log.info(f"[DEBUG emots] info[0][15]={json.dumps(extra_data, ensure_ascii=False)[:300]}")
        event = {
            "timestamp": now,
            "event_type": "danmaku",
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
        gift_img = gift_img_cache.get(gift_id, "")
        # 盲盒检测：blind_gift 字段包含盲盒信息
        blind = data.get("blind_gift") or {}
        blind_name = ""
        if blind and isinstance(blind, dict):
            blind_name = blind.get("gift_name") or blind.get("original_gift_name") or ""
        action = data.get("action", "投喂")
        gift_name = data.get("giftName", "")
        if blind_name:
            action = f"{blind_name} 爆出"
        event = {
            "timestamp": now,
            "event_type": "gift",
            "user_name": data.get("uname", ""),
            "user_id": data.get("uid", 0),
            "content": f"{gift_name} x{data.get('num', 1)}",
            "extra": {
                "gift_name": gift_name,
                "gift_id": gift_id,
                "num": data.get("num", 1),
                "coin_type": data.get("coin_type", ""),
                "total_coin": data.get("total_coin", 0),
                "price": data.get("price", 0),
                "action": action,
                "blind_name": blind_name,
                "face": data.get("face", ""),
                "gift_img": gift_img,
                "guard_level": data.get("guard_level", 0),
            },
        }
        log.info(
            f"[礼物] {data.get('uname')} {action} {gift_name} x{data.get('num', 1)}"
        )
        return event

    elif base_cmd == "COMBO_SEND":
        data = msg.get("data", {})
        gift_img = gift_img_cache.get(data.get("gift_id", 0), "")
        event = {
            "timestamp": now,
            "event_type": "gift",
            "user_name": data.get("uname", ""),
            "user_id": data.get("uid", 0),
            "content": f"{data.get('gift_name', '')} x{data.get('combo_num', 1)} (连击)",
            "extra": {
                "gift_name": data.get("gift_name", ""),
                "gift_id": data.get("gift_id", 0),
                "num": data.get("combo_num", 1),
                "total_coin": data.get("combo_total_coin", 0),
                "combo": True,
                "face": data.get("uface", ""),
                "gift_img": gift_img,
                "guard_level": data.get("guard_level", 0),
            },
        }
        log.info(
            f"[连击] {data.get('uname')} {data.get('action', '送出')} {data.get('gift_name')} x{data.get('combo_num', 1)}"
        )
        return event

    elif base_cmd == "SUPER_CHAT_MESSAGE":
        data = msg.get("data", {})
        user_info = data.get("user_info", {})
        event = {
            "timestamp": now,
            "event_type": "superchat",
            "user_name": user_info.get("uname", ""),
            "user_id": data.get("uid", 0),
            "content": data.get("message", ""),
            "extra": {
                "price": data.get("price", 0),
                "duration": data.get("time", 0),
                "background_color": data.get("background_color", ""),
                "face": user_info.get("face", ""),
            },
        }
        log.info(
            f"[SC|¥{data.get('price', 0)}] {user_info.get('uname', '')}: {data.get('message', '')}"
        )
        return event

    elif base_cmd == "GUARD_BUY":
        data = msg.get("data", {})
        level = data.get("guard_level", 3)
        guard_name = GUARD_LEVELS.get(level, "舰长")
        event = {
            "timestamp": now,
            "event_type": "guard",
            "user_name": data.get("username", ""),
            "user_id": data.get("uid", 0),
            "content": f"开通 {guard_name}",
            "extra": {
                "guard_level": level,
                "guard_name": guard_name,
                "num": data.get("num", 1),
                "price": data.get("price", 0),
            },
        }
        log.info(f"[上舰] {data.get('username', '')} 开通 {guard_name}")
        return event

    elif base_cmd == "INTERACT_WORD":
        data = msg.get("data", {})
        msg_type = data.get("msg_type", 0)
        type_map = {1: "进入", 2: "关注", 3: "分享", 4: "特别关注", 5: "互相关注"}
        action = type_map.get(msg_type, "互动")
        event = {
            "timestamp": now,
            "event_type": "enter",
            "user_name": data.get("uname", ""),
            "user_id": data.get("uid", 0),
            "content": action,
            "extra": {"msg_type": msg_type, "action": action},
        }
        return event

    elif base_cmd in ("LIKE_INFO_V3_CLICK",):
        data = msg.get("data", {})
        event = {
            "timestamp": now,
            "event_type": "like",
            "user_name": data.get("uname", ""),
            "user_id": data.get("uid", 0),
            "content": "点赞",
            "extra": {},
        }
        return event

    return None


# ── Bilibili WebSocket client ──────────────────────────────────────


class BiliLiveClient:
    def __init__(self, room_id: int, on_event, cookies: dict = None):
        self.room_id = room_id
        self.real_room_id = room_id
        self.on_event = on_event
        self.cookies = cookies or {}
        self.uid = int(self.cookies.get("DedeUserID", 0))
        self.popularity = 0
        self.buvid = ""
        self._running = False
        self._ws = None
        self._reconnect = False

    def _make_cookie_header(self) -> dict:
        headers = dict(HEADERS)
        if self.cookies:
            cookie_str = "; ".join(f"{k}={v}" for k, v in self.cookies.items() if k != "refresh_token")
            headers["Cookie"] = cookie_str
        return headers

    async def get_buvid(self):
        headers = self._make_cookie_header()
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get("https://api.bilibili.com/x/frontend/finger/spi") as resp:
                data = await resp.json(content_type=None)
                if data.get("code") == 0:
                    self.buvid = data["data"].get("b_3", "")
                    log.info(f"获取 buvid: {self.buvid[:16]}...")
            # Get real uid if logged in
            if self.cookies.get("SESSDATA"):
                async with session.get(NAV_API) as resp:
                    data = await resp.json(content_type=None)
                    if data.get("code") == 0:
                        self.uid = data["data"].get("mid", 0)
                        log.info(f"已登录用户: {data['data'].get('uname', '?')} (UID: {self.uid})")

    async def get_room_info(self):
        async with aiohttp.ClientSession(headers=self._make_cookie_header()) as session:
            async with session.get(
                ROOM_INFO_API, params={"room_id": self.room_id}
            ) as resp:
                data = await resp.json(content_type=None)
                if data.get("code") == 0:
                    info = data["data"]
                    self.real_room_id = info.get("room_id", self.room_id)
                    log.info(
                        f"房间信息: {info.get('title', '')} (真实ID: {self.real_room_id})"
                    )
                    return info
        return {}

    async def get_danmu_info(self):
        headers = self._make_cookie_header()
        # Try getDanmuInfo with Wbi signing when logged in
        if self.cookies.get("SESSDATA"):
            wbi_key = await get_wbi_key(headers)
            if wbi_key:
                params = wbi_sign({"id": self.real_room_id, "type": 0}, wbi_key)
                async with aiohttp.ClientSession(headers=headers) as session:
                    async with session.get(DANMU_INFO_API, params=params) as resp:
                        data = await resp.json(content_type=None)
                        if data.get("code") == 0:
                            d = data["data"]
                            log.info("使用 getDanmuInfo (已登录)")
                            return {
                                "token": d["token"],
                                "host_list": d.get("host_list", []),
                            }
                        else:
                            log.warning(f"getDanmuInfo 失败 (code={data.get('code')}), 回退到 getConf")
        # Fallback to getConf (anonymous)
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get(
                DANMU_CONF_API,
                params={"room_id": self.real_room_id, "platform": "pc", "player": "web"},
            ) as resp:
                data = await resp.json(content_type=None)
                if data.get("code") == 0:
                    d = data["data"]
                    return {
                        "token": d["token"],
                        "host_list": d.get("host_server_list", []),
                    }
        return None

    def request_reconnect(self):
        """Request a reconnect (e.g. after login). Closes current ws gracefully."""
        self._reconnect = True
        if self._ws and not self._ws.closed:
            asyncio.create_task(self._ws.close())

    async def run(self):
        self._running = True
        while self._running:
            self._reconnect = False
            try:
                await self._connect_and_listen()
            except Exception as e:
                if not self._reconnect:
                    log.error(f"连接断开: {e}")
            if self._running:
                wait = 1 if self._reconnect else 5
                log.info(f"{wait} 秒后重连...")
                await asyncio.sleep(wait)

    async def _connect_and_listen(self):
        await self.get_buvid()
        await self.get_room_info()
        danmu_info = await self.get_danmu_info()
        if not danmu_info:
            raise Exception("获取弹幕服务器信息失败")

        token = danmu_info["token"]
        host_list = danmu_info.get("host_list", [])
        if host_list:
            host = host_list[0]["host"]
            port = host_list[0]["wss_port"]
            ws_url = f"wss://{host}:{port}/sub"
        else:
            ws_url = "wss://broadcastlv.chat.bilibili.com/sub"

        log.info(f"连接弹幕服务器: {ws_url}")

        async with aiohttp.ClientSession(headers=self._make_cookie_header()) as session:
            async with session.ws_connect(ws_url) as ws:
                self._ws = ws
                # Auth
                auth_body = json.dumps(
                    {
                        "uid": self.uid,
                        "roomid": self.real_room_id,
                        "protover": 3,
                        "buvid": self.buvid,
                        "platform": "web",
                        "type": 2,
                        "key": token,
                    }
                ).encode()
                await ws.send_bytes(make_packet(auth_body, WS_OP_AUTH))
                log.info("已发送认证包")

                # Heartbeat task
                async def heartbeat():
                    while self._running:
                        await asyncio.sleep(30)
                        try:
                            await ws.send_bytes(make_packet(b"", WS_OP_HEARTBEAT))
                        except Exception:
                            break

                hb_task = asyncio.create_task(heartbeat())

                try:
                    async for raw_msg in ws:
                        if raw_msg.type == aiohttp.WSMsgType.BINARY:
                            packets = parse_packets(raw_msg.data)
                            for pkt in packets:
                                cmd = pkt.get("cmd", "")
                                if cmd == "_AUTH_REPLY":
                                    log.info("认证成功，开始接收消息")
                                    continue
                                if cmd == "_HEARTBEAT_REPLY":
                                    self.popularity = pkt.get("popularity", 0)
                                    continue
                                event = handle_message(pkt)
                                if event:
                                    event["room_id"] = self.real_room_id
                                    save_event(event)
                                    await self.on_event(event)
                        elif raw_msg.type in (
                            aiohttp.WSMsgType.CLOSED,
                            aiohttp.WSMsgType.ERROR,
                        ):
                            break
                finally:
                    hb_task.cancel()

    def stop(self):
        self._running = False


# ── FastAPI web server ──────────────────────────────────────────────

app = FastAPI(title="B站直播监控")

# ── 简单密码认证（多密码，不同房间权限） ──
# AUTH_PASSWORD_ALL: 可以看所有房间
# AUTH_PASSWORD_LIMITED: 只能看 LIMITED_ROOMS 指定的房间
AUTH_PASSWORD_ALL = os.environ.get("AUTH_PASSWORD_ALL", os.environ.get("AUTH_PASSWORD", ""))
AUTH_PASSWORD_LIMITED = os.environ.get("AUTH_PASSWORD_LIMITED", "")
LIMITED_ROOMS = [int(r.strip()) for r in os.environ.get("LIMITED_ROOMS", "32365569").split(",") if r.strip()]
# token -> allowed_rooms (None = all rooms)
auth_tokens: dict[str, Optional[list[int]]] = {}

LOGIN_HTML = """<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 - B站直播监控</title>
<style>body{background:#0f0f1a;color:#e0e0e0;font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.box{background:#1a1a2e;padding:40px;border-radius:16px;border:1px solid #2a2a4a;text-align:center;min-width:300px}
h2{color:#fb7299;margin-bottom:20px}input{background:#0f0f1a;border:1px solid #2a2a4a;color:#ccc;padding:10px 16px;border-radius:8px;font-size:16px;width:100%;margin-bottom:16px;box-sizing:border-box}
input:focus{border-color:#fb7299;outline:none}button{background:#fb7299;color:#fff;border:none;padding:10px 24px;border-radius:8px;font-size:16px;cursor:pointer;width:100%}
button:hover{background:#e0607e}.err{color:#ef5350;font-size:13px;margin-bottom:12px}</style></head>
<body><div class="box"><h2>B站直播监控</h2><div class="err" id="err"></div>
<form onsubmit="return doLogin()"><input type="password" id="pw" placeholder="请输入密码" autofocus>
<button type="submit">登录</button></form></div>
<script>function doLogin(){const pw=document.getElementById('pw').value;
fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})})
.then(r=>r.json()).then(d=>{if(d.ok){location.reload()}else{document.getElementById('err').textContent='密码错误'}});return false}</script></body></html>"""


from starlette.middleware.base import BaseHTTPMiddleware

class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        # 不需要密码时跳过
        if not AUTH_PASSWORD_ALL and not AUTH_PASSWORD_LIMITED:
            return await call_next(request)
        # 放行登录相关路径
        path = request.url.path
        if path == "/api/auth" or path.startswith("/static/"):
            return await call_next(request)
        # 检查 cookie
        token = request.cookies.get("auth_token")
        if token in auth_tokens:
            request.state.allowed_rooms = auth_tokens[token]
            return await call_next(request)
        # 未认证：页面请求返回登录页，API 返回 401
        if path.startswith("/api/") or path == "/ws":
            return HTMLResponse('{"error":"unauthorized"}', status_code=401)
        return HTMLResponse(LOGIN_HTML)

app.add_middleware(AuthMiddleware)


# 登录失败次数限制：IP -> (fail_count, first_fail_time)
_login_attempts: dict[str, tuple[int, float]] = defaultdict(lambda: (0, 0.0))
_MAX_LOGIN_ATTEMPTS = 5
_LOGIN_LOCKOUT_SECONDS = 300  # 5分钟


@app.post("/api/auth")
async def auth_login(request: Request):
    ip = request.client.host if request.client else "unknown"
    fails, first_time = _login_attempts[ip]
    # 超过锁定时间则重置
    if fails >= _MAX_LOGIN_ATTEMPTS and time.time() - first_time < _LOGIN_LOCKOUT_SECONDS:
        return HTMLResponse('{"ok":false,"error":"too_many_attempts"}', status_code=429)
    if fails >= _MAX_LOGIN_ATTEMPTS:
        _login_attempts[ip] = (0, 0.0)

    body = await request.json()
    pw = body.get("password", "")
    allowed_rooms = None  # None = all rooms
    if AUTH_PASSWORD_ALL and pw == AUTH_PASSWORD_ALL:
        allowed_rooms = None  # all rooms
    elif AUTH_PASSWORD_LIMITED and pw == AUTH_PASSWORD_LIMITED:
        allowed_rooms = LIMITED_ROOMS
    else:
        fails, first_time = _login_attempts[ip]
        _login_attempts[ip] = (fails + 1, first_time or time.time())
        return HTMLResponse('{"ok":false}', status_code=403)

    _login_attempts.pop(ip, None)
    token = secrets.token_hex(32)
    auth_tokens[token] = allowed_rooms
    resp = HTMLResponse(json.dumps({"ok": True, "allowed_rooms": allowed_rooms}))
    resp.set_cookie("auth_token", token, httponly=True, max_age=86400 * 30)
    return resp


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
ws_clients: set[WebSocket] = set()
bili_client: Optional[BiliLiveClient] = None
bili_clients: dict[int, BiliLiveClient] = {}  # room_id -> client


async def broadcast_event(event: dict):
    dead = set()
    for client in ws_clients:
        try:
            await client.send_json(event)
        except Exception:
            dead.add(client)
    ws_clients.difference_update(dead)


@app.get("/")
async def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/api/events")
async def get_events(
    type: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    time_from: Optional[str] = Query(None),
    time_to: Optional[str] = Query(None),
    room_id: Optional[int] = Query(None),
):
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conditions = []
    params = []
    if room_id:
        conditions.append("room_id=?")
        params.append(room_id)
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


@app.get("/api/stats")
async def get_stats(room_id: Optional[int] = Query(None)):
    conn = sqlite3.connect(str(DB_PATH))
    rf = "AND room_id=?" if room_id else ""
    rp = [room_id] if room_id else []
    total = conn.execute(f"SELECT COUNT(*) FROM events WHERE 1=1 {rf}", rp).fetchone()[0]
    danmaku_count = conn.execute(f"SELECT COUNT(*) FROM events WHERE event_type='danmaku' {rf}", rp).fetchone()[0]
    gift_count = conn.execute(f"SELECT COUNT(*) FROM events WHERE event_type='gift' {rf}", rp).fetchone()[0]
    sc_count = conn.execute(f"SELECT COUNT(*) FROM events WHERE event_type='superchat' {rf}", rp).fetchone()[0]
    guard_count = conn.execute(f"SELECT COUNT(*) FROM events WHERE event_type='guard' {rf}", rp).fetchone()[0]
    sc_rows = conn.execute(f"SELECT extra_json FROM events WHERE event_type='superchat' {rf}", rp).fetchall()
    sc_total = 0
    for row in sc_rows:
        try:
            extra = json.loads(row[0])
            sc_total += extra.get("price", 0)
        except Exception:
            pass
    conn.close()
    pop = 0
    if room_id and room_id in bili_clients:
        pop = bili_clients[room_id].popularity
    elif bili_clients:
        pop = list(bili_clients.values())[0].popularity
    return {
        "total": total, "danmaku": danmaku_count, "gift": gift_count,
        "superchat": sc_count, "guard": guard_count, "sc_total_price": sc_total,
        "popularity": pop,
    }


@app.get("/api/gift-summary")
async def gift_summary(
    date: Optional[str] = Query(None),
    user_name: Optional[str] = Query(None),
):
    """汇总指定日期的礼物，按用户分组。可按 user_name 筛选单用户"""
    if not date:
        date = datetime.now().strftime("%Y-%m-%d")
    conn = sqlite3.connect(str(DB_PATH))
    if user_name:
        rows = conn.execute(
            "SELECT user_name, user_id, extra_json FROM events WHERE event_type='gift' AND timestamp LIKE ? AND user_name=?",
            (date + "%", user_name),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT user_name, user_id, extra_json FROM events WHERE event_type='gift' AND timestamp LIKE ?",
            (date + "%",),
        ).fetchall()
    conn.close()

    users = {}
    for user_name_r, user_id, extra_json in rows:
        extra = json.loads(extra_json)
        key = user_name_r or str(user_id)
        if key not in users:
            users[key] = {"user_name": user_name_r, "face": extra.get("face", ""), "gifts": {}, "gift_coins": {}, "gift_imgs": {}, "gift_actions": {}, "guard_level": 0, "total_coin": 0, "gift_ids": {}}
        gift_name = extra.get("gift_name", "?")
        num = extra.get("num", 1)
        users[key]["gifts"][gift_name] = users[key]["gifts"].get(gift_name, 0) + num
        tc = extra.get("total_coin", 0)
        users[key]["total_coin"] += tc
        users[key]["gift_coins"][gift_name] = users[key]["gift_coins"].get(gift_name, 0) + tc
        if not users[key]["face"] and extra.get("face"):
            users[key]["face"] = extra["face"]
        gift_img = extra.get("gift_img", "")
        if gift_img and gift_name not in users[key]["gift_imgs"]:
            users[key]["gift_imgs"][gift_name] = gift_img
        action = extra.get("action", "投喂")
        blind_name = extra.get("blind_name", "")
        if gift_name not in users[key]["gift_actions"]:
            users[key]["gift_actions"][gift_name] = action
            if blind_name:
                users[key]["gift_actions"][gift_name] = f"{blind_name} 爆出"
        gid = extra.get("gift_id", 0)
        if gid and gift_name not in users[key]["gift_ids"]:
            users[key]["gift_ids"][gift_name] = gid
            gif_url = gift_gif_cache.get(gid, "")
            if gif_url:
                users[key]["gift_gifs"] = users[key].get("gift_gifs", {})
                users[key]["gift_gifs"][gift_name] = gif_url
        gl = extra.get("guard_level", 0)
        if gl and (not users[key]["guard_level"] or gl < users[key]["guard_level"]):
            users[key]["guard_level"] = gl  # 1=总督 > 2=提督 > 3=舰长, keep highest

    # Recalculate gift_coins using real prices from gift config
    for u in users.values():
        for gift_name, num in u["gifts"].items():
            gid = u["gift_ids"].get(gift_name, 0)
            real_price = gift_price_cache.get(gid, 0)
            if real_price:
                u["gift_coins"][gift_name] = real_price * num

    # Fallback: look up guard_level from guard_cache if not in event data
    for u in users.values():
        if not u["guard_level"]:
            uid = None
            # find uid from rows
            for user_name_r, user_id, _ in rows:
                if user_name_r == u["user_name"]:
                    uid = user_id
                    break
            if uid:
                for room_guards in guard_cache.values():
                    gl = room_guards.get(uid, 0)
                    if gl:
                        u["guard_level"] = gl
                        break

    result = sorted(users.values(), key=lambda x: x["total_coin"], reverse=True)
    return {"date": date, "users": result}


@app.get("/api/gift-gif")
async def get_gift_gif(gift_id: int = Query(...)):
    """返回礼物的 GIF URL（仅单价>=2000元的礼物）"""
    gif_url = gift_gif_cache.get(gift_id, "")
    return {"gift_id": gift_id, "gif": gif_url}


@app.get("/api/gift-gif-card")
async def gift_gif_card(
    user_name: str = Query(...),
    gift_name: str = Query(...),
):
    """生成带动态礼物的 GIF 卡片"""
    from PIL import Image as PILImage, ImageDraw, ImageFont, ImageSequence

    # 1. 获取用户礼物数据 (直接调用内部逻辑而非endpoint)
    date = datetime.now().strftime("%Y-%m-%d")
    conn = sqlite3.connect(str(DB_PATH))
    rows = conn.execute(
        "SELECT user_name, user_id, extra_json FROM events WHERE event_type='gift' AND timestamp LIKE ? AND user_name=?",
        (date + "%", user_name),
    ).fetchall()
    conn.close()
    users = {}
    for un, uid, ej in rows:
        extra = json.loads(ej)
        key = un or str(uid)
        if key not in users:
            users[key] = {"user_name": un, "face": extra.get("face", ""), "gifts": {}, "gift_coins": {}, "gift_imgs": {}, "gift_actions": {}, "gift_ids": {}, "guard_level": 0, "total_coin": 0}
        gn = extra.get("gift_name", "?")
        num = extra.get("num", 1)
        tc = extra.get("total_coin", 0)
        users[key]["gifts"][gn] = users[key]["gifts"].get(gn, 0) + num
        users[key]["total_coin"] += tc
        users[key]["gift_coins"][gn] = users[key]["gift_coins"].get(gn, 0) + tc
        if not users[key]["face"] and extra.get("face"):
            users[key]["face"] = extra["face"]
        gi = extra.get("gift_img", "")
        if gi and gn not in users[key]["gift_imgs"]:
            users[key]["gift_imgs"][gn] = gi
        act = extra.get("action", "投喂")
        bn = extra.get("blind_name", "")
        if gn not in users[key]["gift_actions"]:
            users[key]["gift_actions"][gn] = f"{bn} 爆出" if bn else act
        gid = extra.get("gift_id", 0)
        if gid and gn not in users[key]["gift_ids"]:
            users[key]["gift_ids"][gn] = gid
        gl = extra.get("guard_level", 0)
        if gl and (not users[key]["guard_level"] or gl < users[key]["guard_level"]):
            users[key]["guard_level"] = gl
    # Recalculate with real prices
    for uu in users.values():
        for gn2, n2 in uu["gifts"].items():
            gid2 = uu["gift_ids"].get(gn2, 0)
            rp = gift_price_cache.get(gid2, 0)
            if rp:
                uu["gift_coins"][gn2] = rp * n2
    # Guard fallback
    for uu in users.values():
        if not uu["guard_level"]:
            for un2, uid2, _ in rows:
                if un2 == uu["user_name"]:
                    for gc in guard_cache.values():
                        g = gc.get(uid2, 0)
                        if g:
                            uu["guard_level"] = g
                            break
                    break
    u = list(users.values())[0] if users else None
    if not u:
        return {"error": "未找到用户礼物数据"}

    gift_ids = u.get("gift_ids", {})
    gid = gift_ids.get(gift_name, 0)
    gif_url = gift_gif_cache.get(gid, "")
    if not gif_url:
        return {"error": "该礼物没有动态图"}

    # 2. 确定卡片颜色
    gift_coins = u.get("gift_coins", {})
    yuan = gift_coins.get(gift_name, 0) / 1000
    tpl_name = "gold" if yuan >= 1000 else "pink" if yuan >= 500 else "purple" if yuan >= 100 else "blue"
    tpl_path = BASE_DIR / "static" / f"card_tpl_{tpl_name}.png"

    # 3. 加载资源 (2x 渲染，匹配前端 canvas @2x)
    S = 2  # scale factor
    card_tpl_raw = PILImage.open(tpl_path).convert("RGBA")
    cw, ch = card_tpl_raw.size[0] * S, card_tpl_raw.size[1] * S
    card_tpl = card_tpl_raw.resize((cw, ch), PILImage.LANCZOS)

    # 下载头像
    avatar_size = 56 * S
    avatar_img = None
    if u.get("face"):
        try:
            async with aiohttp.ClientSession(headers=HEADERS) as session:
                async with session.get(u["face"]) as resp:
                    avatar_img = PILImage.open(io.BytesIO(await resp.read())).convert("RGBA").resize((avatar_size, avatar_size))
        except Exception:
            pass

    # 下载头像框
    frame_size = 78 * S
    guard_frame_img = None
    gl = u.get("guard_level", 0)
    if gl in (1, 2, 3):
        try:
            frame_path = BASE_DIR / "static" / f"guard_frame_{gl}.png"
            guard_frame_img = PILImage.open(frame_path).convert("RGBA").resize((frame_size, frame_size), PILImage.LANCZOS)
        except Exception:
            pass

    # 下载 GIF
    try:
        async with aiohttp.ClientSession(headers=HEADERS) as session:
            async with session.get(gif_url) as resp:
                gif_data = await resp.read()
        gift_gif = PILImage.open(io.BytesIO(gif_data))
    except Exception:
        return {"error": "下载 GIF 失败"}

    # 4. 字体 (2x)
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

    # 5. 组装每一帧
    num = u["gifts"].get(gift_name, 0)
    action = u.get("gift_actions", {}).get(gift_name, "投喂")
    gif_size = 54 * S
    frames = []
    durations = []

    # 头像圆形 mask
    avatar_mask = PILImage.new("L", (avatar_size, avatar_size), 0)
    ImageDraw.Draw(avatar_mask).ellipse((0, 0, avatar_size - 1, avatar_size - 1), fill=255)

    # 头像中心位置
    acx, acy = 36 * S, ch // 2
    ar = avatar_size // 2

    for frame_idx, frame in enumerate(ImageSequence.Iterator(gift_gif)):
        card = card_tpl.copy()
        draw = ImageDraw.Draw(card)

        # 头像
        if avatar_img:
            card.paste(avatar_img, (acx - ar, acy - ar), avatar_mask)
        if guard_frame_img:
            card.paste(guard_frame_img, (acx - frame_size // 2, acy - frame_size // 2), guard_frame_img)

        # 用户名 (白色粗体)
        tx = (acx + 46 * S) if guard_frame_img else (acx + ar + 12 * S)
        draw.text((tx, ch // 2 - 24 * S), u["user_name"], fill=(255, 255, 255), font=font_bold)

        # action + gift name
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

        # 礼物 GIF 帧
        right_start = int(cw * 0.65)
        gif_frame = frame.convert("RGBA").resize((gif_size, gif_size), PILImage.LANCZOS)
        card.paste(gif_frame, (right_start, (ch - gif_size) // 2), gif_frame)

        # 数字: "x" 小 + 数字大，描边 #bc6e2d
        num_x = right_start + gif_size + 8 * S
        num_y = ch // 2 - 14 * S
        num_text = f"x {num}"
        # 粗描边
        for dx, dy in [(-2,-2),(-2,0),(-2,2),(0,-2),(0,2),(2,-2),(2,0),(2,2),(-3,0),(3,0),(0,-3),(0,3)]:
            draw.text((num_x + dx, num_y + dy), num_text, fill=(188, 110, 45), font=font_num)
        draw.text((num_x, num_y), num_text, fill=(255, 245, 5), font=font_num)

        # 转为 P 模式用于 GIF
        rgb_frame = card.convert("RGB")
        frames.append(rgb_frame)
        durations.append(gift_gif.info.get("duration", 100))

    # 6. 保存 GIF
    output = io.BytesIO()
    frames[0].save(
        output, format="GIF", save_all=True, append_images=frames[1:],
        duration=durations, loop=0, disposal=2,
    )
    output.seek(0)

    return StreamingResponse(
        output,
        media_type="image/gif",
        headers={"Content-Disposition": f"attachment; filename=gift_{int(time.time())}.gif"},
    )


@app.get("/api/rooms")
async def get_rooms(request: Request):
    allowed = getattr(request.state, "allowed_rooms", None)
    return [
        {
            "room_id": c.room_id,
            "real_room_id": c.real_room_id,
            "popularity": c.popularity,
        }
        for c in bili_clients.values()
        if allowed is None or c.room_id in allowed
    ]


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    ws_clients.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        ws_clients.discard(ws)


# ── Web QR Login API ────────────────────────────────────────────────

qr_session: Optional[requests.Session] = None


@app.get("/api/login/status")
async def login_status():
    first = next(iter(bili_clients.values()), None)
    logged_in = bool(first and first.cookies.get("SESSDATA"))
    uid = first.uid if first else 0
    return {"logged_in": logged_in, "uid": uid}


@app.get("/api/login/qrcode")
async def login_qrcode():
    global qr_session
    qr_session = requests.Session()
    resp = qr_session.get(QR_GENERATE_API, headers=HEADERS)
    data = resp.json()
    if data.get("code") != 0:
        return {"error": "生成二维码失败"}
    return {
        "url": data["data"]["url"],
        "qrcode_key": data["data"]["qrcode_key"],
    }


@app.get("/api/login/poll")
async def login_poll(qrcode_key: str):
    global qr_session, bili_clients
    if not qr_session:
        return {"code": -1, "message": "请先获取二维码"}
    resp = qr_session.get(QR_POLL_API, params={"qrcode_key": qrcode_key}, headers=HEADERS)
    poll_data = resp.json().get("data", {})
    code = poll_data.get("code", -1)

    if code == 0:
        cookies = {}
        for key in ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"):
            val = qr_session.cookies.get(key) or resp.cookies.get(key)
            if val:
                cookies[key] = val
        url_str = poll_data.get("url", "")
        if "refresh_token=" in url_str:
            cookies["refresh_token"] = url_str.split("refresh_token=")[-1].split("&")[0]
        save_cookies(cookies)
        # Update all running clients with new cookies and reconnect
        uid = int(cookies.get("DedeUserID", 0))
        for client in bili_clients.values():
            client.cookies = cookies
            client.uid = uid
            client.request_reconnect()
        log.info(f"网页扫码登录成功 (UID: {uid})，所有房间重连中...")
        return {"code": 0, "message": "登录成功", "uid": uid}
    elif code == 86101:
        return {"code": 86101, "message": "等待扫码"}
    elif code == 86090:
        return {"code": 86090, "message": "已扫码，请确认"}
    elif code == 86038:
        return {"code": 86038, "message": "二维码已过期"}
    else:
        return {"code": code, "message": "未知状态"}


# ── Main ────────────────────────────────────────────────────────────


async def main(room_ids: list[int], port: int, cookies: dict = None):
    global bili_clients
    init_db()

    # Load gift image config & guard lists
    await load_gift_config(HEADERS)
    for rid in room_ids:
        await load_guard_list(rid, HEADERS)

    for rid in room_ids:
        client = BiliLiveClient(rid, on_event=broadcast_event, cookies=cookies)
        bili_clients[rid] = client

    config = uvicorn.Config(app, host="0.0.0.0", port=port, log_level="info")
    server = uvicorn.Server(config)

    log.info(f"启动监控: 房间 {room_ids} | Web: http://localhost:{port}")

    await asyncio.gather(
        server.serve(),
        *(client.run() for client in bili_clients.values()),
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="B站直播间监控")
    parser.add_argument("--rooms", type=str, default="1920456329,32365569", help="直播间房间号，逗号分隔")
    parser.add_argument("--port", type=int, default=8080, help="Web 服务端口 (默认 8080)")
    args = parser.parse_args()

    room_ids = [int(r.strip()) for r in args.rooms.split(",") if r.strip()]
    cookies = load_cookies()
    asyncio.run(main(room_ids, args.port, cookies))
