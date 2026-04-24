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

# ── 爱发电（ifdian）── plan_id → 续费月数。改定价时只改这张表。
AFDIAN_PLANS: dict[str, int] = {
    "6cf0cfe23b8a11f1af005254001e7c00": 1,   # 月卡
    "5953ff0a3b8e11f18c7252540025c377": 3,   # 季卡
    "8174f0ca3b8e11f1ac5d52540025c377": 6,   # 半年卡
    "8e50689c3b8e11f1840f52540025c377": 12,  # 年卡
    "c59457283b8e11f1afbc52540025c377": 1,   # 测试卡
}
AFDIAN_QUERY_ORDER_API = "https://afdian.com/api/open/query-order"

# 盲盒爆出查询门槛：单次爆出价值（电池）大于此才算"稀有爆出"。
# gift_catalog 和 handle_rare_blind_by_gift 共用这个阈值，保证入缓存的礼物
# 一定能被查到；不然会出现 "本月<低价礼物>" 命中缓存但查询结果永远是 0。
RARE_BLIND_MIN_PRICE = 10000

# ── 进场特效 ──
# 视频文件存 DATA_DIR/entry_effects/<room_id>/<filename>。
ENTRY_EFFECT_ROOT = DATA_DIR / "entry_effects"
ENTRY_EFFECT_ROOT.mkdir(parents=True, exist_ok=True)
ENTRY_EFFECT_MAX_BYTES = 100 * 1024 * 1024   # 100 MB
ENTRY_EFFECT_ALLOWED_EXT = {".mp4", ".webm"}
ENTRY_EFFECT_MAX_UIDS_PER_ROOM = 10          # 每房最多 10 个 UID 能绑进场特效

# 自动录屏保留窗口；定时任务到点既清盘文件，也把事件 extra.has_clip 翻回 false
CLIP_RETENTION_HOURS = 72
# 礼物特效覆盖：用户上传的视频替换 B站 自带 VAP，路径同结构。
GIFT_EFFECT_ROOT = DATA_DIR / "gift_effects"
GIFT_EFFECT_ROOT.mkdir(parents=True, exist_ok=True)
ENTRY_EFFECT_COOLDOWN_SEC = 5 * 60          # 同一个 uid 每 5 分钟最多触发一次


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

# 公用提醒账号：某房间 bot cookie 失效时，用下列 room_id 已绑定的 cookie
# 去失效房间发一条提醒弹幕。直接复用现有已扫码的 bot，跟随 QR 续期自然刷新，
# 不用手抄 env var。未配置或 0 则整个功能静默关闭。
try:
    FALLBACK_BOT_ROOM_ID = int(os.environ.get("FALLBACK_BOT_ROOM_ID", "0") or "0")
except ValueError:
    FALLBACK_BOT_ROOM_ID = 0

GUARD_LEVELS = {1: "总督", 2: "提督", 3: "舰长"}

PERIOD_LABELS = {"today": "今日", "yesterday": "昨日", "this_week": "本周", "this_month": "今月", "last_month": "上月"}
DANMU_PERIOD_MAP = {"今日盲盒": "today", "昨日盲盒": "yesterday", "本周盲盒": "this_week", "今月盲盒": "this_month", "本月盲盒": "this_month", "上月盲盒": "last_month", "我的盲盒": "this_month"}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Referer": "https://live.bilibili.com/",
    "Origin": "https://live.bilibili.com",
}

# 同一台机器下多账号的"设备簇"信号很强，给每个 bot 账号稳定分配一个 UA
# 可以让指纹松散一档。按 uid 取模映射，保证同一账号跨重启始终用同一 UA。
BOT_UA_POOL = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
]


def bot_ua_for_uid(uid: int) -> str:
    """按 uid 稳定映射到 BOT_UA_POOL。uid=0（未登录）返回默认 UA。"""
    if not uid:
        return HEADERS["User-Agent"]
    return BOT_UA_POOL[uid % len(BOT_UA_POOL)]

# ── 默认指令 ──
DEFAULT_COMMANDS = [
    {
        "id": "ai_reply",
        "name": "AI 机器人",
        "type": "user_danmu",
        "description": "观众发弹幕时，机器人按概率自动回复；若弹幕中带了机器人名称，则忽略概率必定回复（仍受同房间冷却限制）。",
        "default_enabled": True,
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
        "description": "感谢弹幕总开关；关闭后礼物/大航海/盲盒/关注/点赞感谢都不发",
        "default_enabled": True,
        "config": {},
    },
    {
        "id": "broadcast_follow",
        "name": "关注感谢",
        "type": "auto_broadcast",
        "description": "观众关注主播后，机器人按模版感谢；全局 30 秒内最多感谢一次关注，防刷屏",
        "default_enabled": True,
        "config": {
            "templates": [
                "感谢{name}的关注~",
                "{name}来啦，感谢关注！",
                "谢谢{name}点了关注，比心",
                "欢迎{name}常来哦，感谢关注",
                "{name}关注啦，爱你哟",
            ],
        },
    },
    {
        "id": "broadcast_like",
        "name": "点赞感谢",
        "type": "auto_broadcast",
        "description": "观众点赞后，机器人按模版感谢；全局 30 秒内最多感谢一次点赞，防连击刷屏",
        "default_enabled": True,
        "config": {
            "templates": [
                "感谢{name}的点赞~",
                "{name}点了赞，谢谢支持",
                "谢谢{name}的小心心",
                "{name}点赞超甜的，爱你",
                "收到{name}的点赞啦，比心",
            ],
        },
    },
    {
        "id": "broadcast_share",
        "name": "分享感谢",
        "type": "auto_broadcast",
        "description": "观众分享直播间后，机器人按模版感谢；全局 30 秒内最多感谢一次分享",
        "default_enabled": True,
        "config": {
            "templates": [
                "感谢{name}的分享~",
                "{name}帮忙分享啦，比心",
                "谢谢{name}分享直播间",
                "{name}把直播间分享出去啦，感谢",
                "谢谢{name}拉人进来，爱你",
            ],
        },
    },
    {
        "id": "broadcast_gift",
        "name": "礼物感谢",
        "type": "auto_broadcast",
        "description": "用户送出付费礼物（盲盒除外）后，机器人按模版自动发弹幕感谢",
        "default_enabled": True,
        "config": {
            "templates": [
                "感谢{name}的 {gift_count}",
                "{name}送出 {gift_count}，谢谢老板",
                "谢谢{name}的 {gift_count}，爱心一个",
                "收到{name}的 {gift_count}，么么哒",
                "{name}太豪气啦，{gift_count} 收到",
            ],
        },
    },
    {
        "id": "broadcast_guard",
        "name": "大航海感谢",
        "type": "auto_broadcast",
        "description": "用户开通/续费舰长/提督/总督后，机器人按模版自动发弹幕感谢",
        "default_enabled": True,
        "config": {
            "templates": [
                "感谢{name}{content}了{num}个月{guard}",
                "{name}{content}{guard}{num}个月，感谢大佬",
                "欢迎{name}加入舰队，{content}{num}月{guard}",
                "感谢{name}大佬{content}{num}个月{guard}，比心",
                "{guard}{name}威武，感谢{content}{num}个月",
            ],
        },
    },
    {
        "id": "broadcast_superchat",
        "name": "醒目留言感谢",
        "type": "auto_broadcast",
        "description": "用户发送醒目留言后，机器人按模版自动发弹幕感谢",
        "default_enabled": True,
        "config": {
            "templates": [
                "感谢{name}的醒目留言",
                "{name}的醒目留言收到啦",
                "谢谢{name}的 SC~",
                "主播已读{name}的醒目留言",
                "{name}的 SC 超暖的，感谢",
            ],
        },
    },
    {
        "id": "broadcast_blind",
        "name": "盲盒播报",
        "type": "auto_broadcast",
        "description": "用户开盲盒后，机器人按模版自动发弹幕播报盈亏",
        "default_enabled": True,
        "config": {
            "templates": [
                "感谢{name}的{count}个盲盒，{verdict}",
                "{name}开了{count}个盲盒，{verdict}",
                "{name}的{count}盲盒，{verdict}",
                "{name}盲盒×{count}，{verdict}~",
            ],
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
            "normal_templates": [
                "欢迎{name}进入直播间",
                "欢迎{name}来了~",
                "{name}来啦，欢迎欢迎",
            ],
            "medal_enabled": True,
            "medal_templates": [
                "欢迎{name}回家~",
                "{name}回家咯，欢迎",
                "家人{name}上线",
                "欢迎{name}，终于等到你",
            ],
            "guard_enabled": True,
            "guard_templates": [
                "{guard}{name}驾到！",
                "欢迎{guard}{name}~",
                "{guard}{name}来了，鞠躬",
                "恭迎{guard}{name}！",
                "{guard}{name}进场，比心",
            ],
        },
    },
    {
        "id": "scheduled_danmu",
        "name": "定时弹幕",
        "type": "scheduled",
        "description": "开播期间，机器人按设定间隔从下列弹幕中随机挑一条发送",
        "default_enabled": True,
        "config": {
            "interval_sec": 300,
            "messages": [
                "动动手指给{streamer}点点关注",
                "新来的朋友记得点个关注哦~",
                "喜欢{streamer}的话，加个关注不迷路",
                "路过的朋友点个关注再走呗",
                "关注{streamer}，下次直播不错过",
            ],
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
        "id": "broadcast_pk_start",
        "name": "PK 播报",
        "type": "auto_broadcast",
        "description": "连线 PK 开始时自动播报对面主播信息。模版里用 \\n 换行会分成多条弹幕发。占位符：{name} 对面主播名；{followers} 粉丝数（带万/亿缩写）；{online} 当前在线戴牌互动人数；{guard_brief} 舰队摘要（暂无 / N舰长 / N(督x提y长z)）；{gold} 本场高能贡献（元）；也支持 {guard_total}/{governor}/{admiral}/{captain} 单独字段。数字缺失用 ? 占位。",
        "default_enabled": True,
        "config": {
            "templates": [
                "PK对手 {name}！\n粉丝{followers} 舰队{guard_brief}\n当前在线人数{online}，本场高能贡献{gold}元",
            ],
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
    {
        "id": "blind_box_query",
        "name": "盲盒查询",
        "type": "user_danmu",
        "description": '主播或观众发"我的盲盒 / 本月盲盒 / 今月盲盒 / 今日盲盒 / 昨日盲盒 / 本周盲盒 / 上月盲盒 / N月盲盒"，机器人回复对应时段的盲盒开启数和盈亏。主播查全员汇总，观众查自己。',
        "default_enabled": True,
        "config": {},
    },
    {
        "id": "rare_blind_query",
        "name": "高价礼物查询",
        "type": "user_danmu",
        "description": '观众发"本月<礼物名>"或"今月<礼物名>"（如"本月浪漫城堡"），机器人回复本月该礼物的收到数量（不分盲盒/直接投喂，仅统计单次价值 > 10000 电池的）',
        "default_enabled": True,
        "config": {},
    },
]

# ── Wbi Signing ──
WBI_KEY_INDEX_TABLE = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
]
