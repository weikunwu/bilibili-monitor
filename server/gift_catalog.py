"""盲盒礼物名缓存。

用于校验"本月<礼物名>" 弹幕查询里的 gift_name 是否真实——防止观众把
机器人自己的输出复制粘贴回来被正则当查询指令"鹦鹉学舌"。

集合来源：本部署 events 表里所有 blind_name != '' 的礼物名 distinct。
启动时全量 load，之后每次落库一条新的盲盒爆出自动补进来。
"""

import sqlite3

from .config import DB_PATH, log


_names: set[str] = set()


def load_from_db() -> int:
    """启动时从历史 events 全量构建缓存。"""
    try:
        conn = sqlite3.connect(str(DB_PATH))
        rows = conn.execute(
            "SELECT DISTINCT json_extract(extra_json, '$.gift_name') "
            "FROM events WHERE event_type='gift' "
            "AND COALESCE(json_extract(extra_json, '$.blind_name'), '') != ''"
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
    log.info(f"[gift_catalog] loaded {len(_names)} blind-box gift names from history")
    return len(_names)


def add(name: str) -> None:
    """新盲盒爆出落库时调用。"""
    n = (name or "").strip()
    if n:
        _names.add(n)


def is_gift(name: str) -> bool:
    return name in _names
