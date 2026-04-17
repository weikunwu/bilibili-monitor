"""Cloudflare Turnstile (人机校验) 验证

如果 TURNSTILE_SECRET 未配置 → verify 直接放行（本地开发不用挂 CAPTCHA）
如果 TURNSTILE_SECRET 已配置 → token 必须有效，否则拒绝"""

import os

import aiohttp

from .config import log


VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


def enabled() -> bool:
    return bool((os.environ.get("TURNSTILE_SECRET") or "").strip())


def site_key() -> str:
    return (os.environ.get("TURNSTILE_SITE_KEY") or "").strip()


async def verify(token: str, remoteip: str = "") -> bool:
    secret = (os.environ.get("TURNSTILE_SECRET") or "").strip()
    if not secret:
        return True  # 未配置 → 不校验
    if not token:
        return False

    data = {"secret": secret, "response": token}
    if remoteip:
        data["remoteip"] = remoteip
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as s:
            async with s.post(VERIFY_URL, data=data) as resp:
                body = await resp.json(content_type=None)
                return bool(body.get("success"))
    except Exception as e:
        log.warning(f"Turnstile verify 异常: {e}")
        return False
