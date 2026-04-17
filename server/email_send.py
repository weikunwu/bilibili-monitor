"""Resend 邮件发送封装（注册验证码等）"""

import os

import aiohttp

from .config import log


RESEND_API_URL = "https://api.resend.com/emails"


def _render_code_email(code: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,'PingFang SC',sans-serif;background:#f5f5f5;margin:0;padding:32px">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
<h2 style="color:#fb7299;margin:0 0 16px">布布机器人 注册验证码</h2>
<p style="color:#555;font-size:14px;line-height:1.6">你的验证码是：</p>
<div style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#222;
  background:#f8f8fa;padding:16px;border-radius:8px;text-align:center;margin:16px 0">{code}</div>
<p style="color:#888;font-size:13px;line-height:1.6">10 分钟内有效。如果不是你本人操作，忽略这封邮件即可。</p>
</div></body></html>"""


async def send_verification_code(email: str, code: str) -> tuple[bool, str]:
    """返回 (ok, error_msg)。失败时 error_msg 含原因。"""
    api_key = (os.environ.get("RESEND_API_KEY") or "").strip()
    sender = (os.environ.get("RESEND_FROM") or "").strip()
    if not api_key or not sender:
        log.error("RESEND_API_KEY 或 RESEND_FROM 未配置")
        return False, "邮件服务未配置"

    payload = {
        "from": sender,
        "to": [email],
        "subject": "布布机器人 注册验证码",
        "html": _render_code_email(code),
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as s:
            async with s.post(RESEND_API_URL, json=payload, headers=headers) as resp:
                if resp.status < 300:
                    return True, ""
                text = await resp.text()
                log.warning(f"Resend 发送失败 {resp.status}: {text[:200]}")
                return False, f"邮件发送失败 ({resp.status})"
    except Exception as e:
        log.warning(f"Resend 请求异常: {e}")
        return False, "邮件发送异常"
