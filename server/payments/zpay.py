"""彩虹易支付 / Z-Pay 接入（z-pay.cn 协议）。
文档：https://z-pay.cn/doc.html

接口契约对齐其他 provider:
  • create_order(out_trade_no, yuan, subject, notify_url) → code_url（前端渲二维码）
  • verify_notify(form) → (event, out_trade_no, trade_no, amount)
  • query_order(out_trade_no) → (status, external_trade_no)

下单走 submit.php (页面跳转模式),不发 HTTP 请求只构造带签名的 URL。
理由:zpay 商户默认支持 submit.php; mapi.php (API JSON 模式) 需要另外申请权限。
扫码者浏览器打开 URL → zpay 验签 → 跳转支付宝收银台。

签名算法 (MD5):
  非空参数(除 sign/sign_type)按 key ASCII 升序排序 → 拼成 a=b&c=d&...
  (value 不 URL encode) → 末尾追加 KEY → hashlib.md5().hexdigest() 32 位小写。
URL 参数侧做 urlencode 让浏览器能解析,zpay 收到后会先 URL decode 再验签。
"""

from __future__ import annotations

import hashlib
from typing import Any
from urllib.parse import urlencode

import aiohttp

from .. import config
from ..config import log


_SITENAME = "BlackBubu"


def _sign(params: dict[str, str]) -> str:
    items = sorted(
        (k, v) for k, v in params.items()
        if k not in ("sign", "sign_type") and v not in ("", None)
    )
    raw = "&".join(f"{k}={v}" for k, v in items)
    return hashlib.md5((raw + config.ZPAY_KEY).encode("utf-8")).hexdigest()


async def create_order(out_trade_no: str, yuan: int, subject: str, notify_url: str) -> str:
    """构造 submit.php URL,前端把它渲成二维码。

    return_url 是 zpay 完成付款后浏览器跳转的页面;扫码场景手机付完不会回 PC,
    传 root 即可,不影响轮询路径。"""
    if not config.ZPAY_ENABLED:
        raise RuntimeError("Z-Pay 未配置")
    params: dict[str, str] = {
        "pid": config.ZPAY_PID,
        "type": "alipay",
        "out_trade_no": out_trade_no,
        "notify_url": notify_url,
        "return_url": config.PAYMENT_NOTIFY_BASE,
        "name": subject,
        "money": f"{yuan:.2f}",
        "sitename": _SITENAME,
        "sign_type": "MD5",
    }
    params["sign"] = _sign(params)
    return f"{config.ZPAY_GATEWAY}/submit.php?{urlencode(params)}"


def verify_notify(form: dict[str, str]) -> tuple[str, str, str, str]:
    """验签 + 事件归类。返回 (event, out_trade_no, trade_no, amount)。
    event:
      • 'paid'     —— trade_status=TRADE_SUCCESS;
                     amount = money 字符串 (e.g. "21.00")，外层据此校验金额
      • 'refunded' —— trade_status=TRADE_REFUND（部分版本会推）
      • 'ignore'   —— 验签过但无需动作（让外层回 success 停推）
      • 'invalid'  —— 签名 / pid 不对（让外层回非 success 让 zpay 重试 / 报警）
    """
    if not config.ZPAY_ENABLED:
        return "invalid", "", "", ""
    sign = (form.get("sign") or "").strip()
    if not sign:
        return "invalid", "", "", ""
    expected = _sign(form)
    if sign.lower() != expected.lower():
        log.warning(f"[zpay] notify 验签失败 form={form}")
        return "invalid", "", "", ""
    if form.get("pid") != config.ZPAY_PID:
        log.warning(f"[zpay] notify pid 不匹配: {form.get('pid')}")
        return "invalid", "", "", ""

    out_trade_no = form.get("out_trade_no", "")
    trade_no = form.get("trade_no", "")
    status = form.get("trade_status", "")
    money = form.get("money", "")

    if status == "TRADE_REFUND":
        return "refunded", out_trade_no, trade_no, money
    if status == "TRADE_SUCCESS":
        return "paid", out_trade_no, trade_no, money
    return "ignore", out_trade_no, trade_no, ""


async def query_order(out_trade_no: str) -> tuple[str, str]:
    """GET api.php?act=order 查单。返回 (status, external_trade_no)。
    status ∈ {'pending', 'paid', 'closed', 'unknown'}。

    注意:zpay 不像支付宝有 TRADE_CLOSED 这种明确状态,订单"过期不付"
    在 zpay 端没有显式状态,我们把 status=0 一律当 pending 看待,
    超 24h 由本地 reconcile task 标 expired。"""
    if not config.ZPAY_ENABLED:
        return "unknown", ""
    params = {
        "act": "order",
        "pid": config.ZPAY_PID,
        "key": config.ZPAY_KEY,
        "out_trade_no": out_trade_no,
    }
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(
                f"{config.ZPAY_GATEWAY}/api.php",
                params=params,
                timeout=aiohttp.ClientTimeout(total=8),
            ) as r:
                data: dict[str, Any] = await r.json(content_type=None)
    except Exception as e:
        log.warning(f"[zpay] query_order 异常 out_trade_no={out_trade_no}: {e}")
        return "unknown", ""
    code = int(data.get("code") or 0)
    if code != 1:
        msg = (data.get("msg") or "").strip()
        # 订单不存在 → 还没付（可能下单后用户没扫，或 zpay 端没建好）
        if "不存在" in msg or "未找到" in msg or "no order" in msg.lower():
            return "pending", ""
        log.warning(f"[zpay] query 异常 out_trade_no={out_trade_no} resp={data}")
        return "unknown", ""
    trade_no = data.get("trade_no", "") or ""
    # 易支付 status: 1=已支付, 0=未付
    if int(data.get("status") or 0) == 1:
        return "paid", trade_no
    return "pending", trade_no
