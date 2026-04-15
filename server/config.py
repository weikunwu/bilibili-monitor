"""全局配置、常量和路径"""

import logging
import os
from pathlib import Path

LOG_FORMAT = "%(asctime)s UTC [%(levelname)s] %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
log = logging.getLogger("bilibili-monitor")

# Unify uvicorn loggers to same format
for _name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
    _logger = logging.getLogger(_name)
    _logger.handlers.clear()
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter(LOG_FORMAT))
    _logger.addHandler(_handler)

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", str(BASE_DIR)))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "gifts.db"

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
H5_ROOM_INFO_API = "https://api.live.bilibili.com/xlive/web-room/v1/index/getH5InfoByRoom"
SEND_GIFT_API = "https://api.live.bilibili.com/gift/v2/Live/send"
SEND_MSG_API = "https://api.live.bilibili.com/msg/send"
MASTER_INFO_API = "https://api.live.bilibili.com/live_user/v1/Master/info"
FINGER_SPI_API = "https://api.bilibili.com/x/frontend/finger/spi"
NAV_API = "https://api.bilibili.com/x/web-interface/nav"
QR_GENERATE_API = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
QR_POLL_API = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"

GUARD_LEVELS = {1: "总督", 2: "提督", 3: "舰长"}

PERIOD_LABELS = {"today": "今日", "yesterday": "昨日", "this_week": "本周", "this_month": "今月", "last_month": "上月"}
DANMU_PERIOD_MAP = {"今日盲盒": "today", "昨日盲盒": "yesterday", "本周盲盒": "this_week", "今月盲盒": "this_month", "本月盲盒": "this_month", "上月盲盒": "last_month", "我的盲盒": "this_month"}

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
        "type": "streamer_danmu",
        "description": '主播发送"打个有效"时自动送10电池',
        "config": {
            "trigger": "打个有效",
            "gift_id": 31036,
            "gift_price": 100,
            "gift_num": 10,
        },
    },
    {
        "id": "broadcast_blind",
        "name": "盲盒战绩播报",
        "type": "auto_broadcast",
        "description": "用户开盲盒后，机器人自动发弹幕播报盈亏",
        "default_enabled": True,
        "config": {},
    },
    {
        "id": "broadcast_gift",
        "name": "礼物感谢",
        "type": "auto_broadcast",
        "description": "用户送出付费礼物（盲盒除外）后，机器人自动发弹幕感谢",
        "default_enabled": True,
        "config": {},
    },
]

# ── Wbi Signing ──
WBI_KEY_INDEX_TABLE = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
]
