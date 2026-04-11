"""全局配置、常量和路径"""

import logging
import os
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("bilibili-monitor")

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", str(BASE_DIR)))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "gifts.db"
COOKIE_FILE = DATA_DIR / "cookies.json"  # legacy fallback

# ── Protocol constants ──
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

# ── B站 API ──
DANMU_CONF_API = "https://api.live.bilibili.com/room/v1/Danmu/getConf"
DANMU_INFO_API = "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo"
ROOM_INFO_API = "https://api.live.bilibili.com/room/v1/Room/get_info"
GIFT_CONFIG_API = "https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/giftConfig"
SEND_GIFT_API = "https://api.live.bilibili.com/gift/v2/Live/send"
NAV_API = "https://api.bilibili.com/x/web-interface/nav"
QR_GENERATE_API = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
QR_POLL_API = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"

GUARD_LEVELS = {1: "总督", 2: "提督", 3: "舰长"}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Referer": "https://live.bilibili.com/",
    "Origin": "https://live.bilibili.com",
}

# ── 默认指令 ──
DEFAULT_COMMANDS = [
    {
        "id": "auto_gift",
        "name": "打个有效",
        "type": "streamer_danmaku",
        "description": '主播发送"打个有效"时自动送小花花 x10 (10电池)',
        "config": {
            "trigger": "打个有效",
            "gift_id": 31036,
            "gift_price": 100,
            "gift_num": 10,
        },
    },
]

# ── Wbi Signing ──
WBI_KEY_INDEX_TABLE = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
]
