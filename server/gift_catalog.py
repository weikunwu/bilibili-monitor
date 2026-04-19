"""稀有盲盒爆出礼物名缓存。

用于校验"本月<礼物名>" 弹幕查询里的 gift_name 是否真实——防止观众把
机器人自己的输出复制粘贴回来被正则当查询指令"鹦鹉学舌"。

准入门槛：必须是单次爆出价值 > RARE_BLIND_MIN_PRICE 电池的爆出才入缓存。
和查询 SQL 用同一个阈值，避免 "本月<低价礼物>" 命中缓存但查询恒 0 的假回复。
"""

import sqlite3

from .config import DB_PATH, RARE_BLIND_MIN_PRICE, log


_names: set[str] = set()


def load_from_db() -> int:
    """启动时从历史 events 全量构建缓存。"""
    try:
        conn = sqlite3.connect(str(DB_PATH))
        rows = conn.execute(
            "SELECT DISTINCT json_extract(extra_json, '$.gift_name') "
            "FROM events WHERE event_type='gift' "
            "AND COALESCE(json_extract(extra_json, '$.blind_name'), '') != '' "
            "AND COALESCE(json_extract(extra_json, '$.price'), 0) > ?",
            (RARE_BLIND_MIN_PRICE,),
        ).fetchall()
        conn.close()
    except Exception as e:
        log.warning(f"[gift_catalog] load failed: {e}")
        return 0
    _names.clear()
    for r in rows:
        n = (r[0] or "").strip()
        if n:
            _names.add(n)
    log.info(f"[gift_catalog] loaded {len(_names)} rare blind-box gift names from history")
    return len(_names)


def add(name: str) -> None:
    """新稀有盲盒爆出落库时调用（调用方已做价格过滤）。"""
    n = (name or "").strip()
    if n:
        _names.add(n)


def is_gift(name: str) -> bool:
    return name in _names
