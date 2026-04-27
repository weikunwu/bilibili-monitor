"""微信推送：服务监控告警。Server酱 Turbo (sctapi.ftqq.com/<KEY>.send)。

SERVERCHAN_KEY 未配置 → noop。send() 内部全部 try/except —— 推送失败
绝不能反向冲击调用方（最常见在异常路径里调用，再炸就不好玩了）。
"""

import os

import aiohttp

from .config import log


_SCT = (os.environ.get("SERVERCHAN_KEY") or "").strip()


async def send(title: str, content: str = "") -> None:
    if not _SCT:
        return
    url = f"https://sctapi.ftqq.com/{_SCT}.send"
    payload = {"title": title, "desp": content or title}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as s:
            async with s.post(url, json=payload) as r:
                if r.status != 200:
                    log.warning(f"[notify] HTTP {r.status}")
    except Exception as e:
        log.warning(f"[notify] {type(e).__name__}: {e}")
