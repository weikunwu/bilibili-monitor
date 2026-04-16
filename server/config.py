"""全局配置、常量和路径"""

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOG_FORMAT = "%(asctime)s UTC [%(levelname)s] %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
log = logging.getLogger("bilibili-monitor")

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", str(BASE_DIR)))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "gifts.db"

# 持久化日志到 data volume，fly logs 只保留几分钟，ssh 进去可回溯 3 天。
# 50MB × 3 backup + 当前 = 最多 ~200MB。
_LOG_PATH = DATA_DIR / "app.log"
_file_handler = RotatingFileHandler(
    str(_LOG_PATH), maxBytes=50 * 1024 * 1024, backupCount=3, encoding="utf-8"
)
_file_handler.setFormatter(logging.Formatter(LOG_FORMAT))
_file_handler.setLevel(logging.INFO)
logging.getLogger().addHandler(_file_handler)

# Unify uvicorn loggers to same format + 同样写文件
for _name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
    _logger = logging.getLogger(_name)
    _logger.handlers.clear()
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter(LOG_FORMAT))
    _logger.addHandler(_handler)
    _logger.addHandler(_file_handler)

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
        "id": "ai_reply",
        "name": "AI 机器人",
        "type": "user_danmu",
        "description": "观众发弹幕时，机器人按概率自动回复；若弹幕中带了机器人名称，则必定回复（忽略概率和冷却）。",
        "default_enabled": False,
        "config": {
            "probability": 10,  # 0–50
            "bot_name": "",
            "model": "glm-4-flash",
            "extra_prompt": "",  # 用户可选追加提示词，内置 base prompt 无法修改
        },
    },
    {
        "id": "auto_gift",
        "name": "打个有效",
        "type": "streamer_danmu",
        "description": '主播发送"打个有效"时自动送10电池',
        "default_enabled": True,
        "config": {
            "trigger": "打个有效",
            "gift_id": 31036,
            "gift_price": 100,
            "gift_num": 10,
        },
    },
    {
        "id": "broadcast_thanks",
        "name": "感谢弹幕",
        "type": "auto_broadcast",
        "description": "感谢弹幕总开关；关闭后礼物感谢/大航海感谢/盲盒播报都不发",
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
    {
        "id": "broadcast_guard",
        "name": "大航海感谢",
        "type": "auto_broadcast",
        "description": "用户开通/续费舰长/提督/总督后，机器人按模版自动发弹幕感谢",
        "default_enabled": True,
        "config": {
            "templates": ["感谢{name}{content}了{num}个月{guard}"],
        },
    },
    {
        "id": "broadcast_blind",
        "name": "盲盒播报",
        "type": "auto_broadcast",
        "description": "用户开盲盒后，机器人按模版自动发弹幕播报盈亏",
        "default_enabled": True,
        "config": {
            "templates": ["感谢{name}的{count}个盲盒，{verdict}"],
        },
    },
    {
        "id": "broadcast_welcome",
        "name": "欢迎弹幕",
        "type": "auto_broadcast",
        "description": "观众进入直播间时机器人按模版发欢迎（同人 5 分钟内不重复，全局 ≥10 秒）",
        "default_enabled": True,
        "config": {
            # 三类：普通 / 专属 (戴本房粉丝牌) / 大航海 (本房舰长以上)
            # 各自独立开关 + 模版；命中优先级: 大航海 > 专属 > 普通
            "normal_enabled": True,
            "normal_templates": ["欢迎{name}进入直播间"],
            "medal_enabled": True,
            "medal_templates": ["欢迎{name}回家~"],
            "guard_enabled": True,
            "guard_templates": ["{guard}{name}驾到！"],
        },
    },
    {
        "id": "scheduled_danmu",
        "name": "定时弹幕",
        "type": "scheduled",
        "description": "开播期间，机器人按设定间隔依次发送以下弹幕（轮播）",
        "default_enabled": True,
        "config": {
            "interval_sec": 300,
            "messages": ["动动手指给{streamer}点点关注"],
        },
    },
    {
        "id": "lurker_mention",
        "name": "挂粉提醒",
        "type": "auto_broadcast",
        "description": "用户进房后 N 秒内没发弹幕，@ 一下提醒互动（仅对本场在线贡献榜上的观众：戴本房粉丝牌并有过互动/送礼）",
        "default_enabled": True,
        "config": {
            "wait_sec": 900,  # 15 分钟
            "template": "说点什么呀~",
        },
    },
    {
        "id": "nickname_commands",
        "name": "昵称功能",
        "type": "user_danmu",
        "description": '观众发"叫我 xxx"设置昵称、"清除昵称"清除，机器人回弹幕确认；关闭后数据库保留昵称但所有播报/查询不再使用',
        "default_enabled": True,
        "config": {},
    },
]

# ── Wbi Signing ──
WBI_KEY_INDEX_TABLE = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
]
