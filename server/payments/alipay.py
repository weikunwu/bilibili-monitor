"""支付宝当面付（alipay.trade.precreate）。

最小实现，无 SDK 依赖。文档：https://opendocs.alipay.com/open/02ekfg
请求签名：把除 sign 外的所有 form 参数按 key 字典序排序 → 拼成
key1=value1&key2=value2 → SHA256withRSA → base64。
异步通知验签：把除 sign / sign_type 外的所有字段同样字典序拼接 → 用支付宝
公钥 RSA-SHA256 verify base64 解出来的签名。
"""

from __future__ import annotations

import base64
import json
from datetime import datetime
from typing import Any
from urllib.parse import urlencode

import aiohttp
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from .. import config
from ..config import log


def _wrap_pem(body: str, label: str) -> str:
    """64 列折行 + 加 PEM 头尾。body 必须是纯 base64 字符串（无空格）。"""
    body = "".join(body.split())
    lines = "\n".join(body[i:i + 64] for i in range(0, len(body), 64))
    return f"-----BEGIN {label}-----\n{lines}\n-----END {label}-----"


def _load_private_key():
    """支付宝密钥工具有两种导出格式：PKCS#8（"BEGIN PRIVATE KEY"）和
    PKCS#1（"BEGIN RSA PRIVATE KEY"）。env 里既可能带 PEM 头也可能纯 base64，
    依次尝试两种格式，给用户的容错足够大。"""
    raw = config.ALIPAY_APP_PRIVATE_KEY.strip()
    if raw.startswith("-----"):
        return serialization.load_pem_private_key(raw.encode(), password=None)
    last_err: Exception | None = None
    for label in ("PRIVATE KEY", "RSA PRIVATE KEY"):
        try:
            pem = _wrap_pem(raw, label)
            return serialization.load_pem_private_key(pem.encode(), password=None)
        except (ValueError, TypeError) as e:
            last_err = e
    raise ValueError(f"无法解析 ALIPAY_APP_PRIVATE_KEY: {last_err}")


def _load_public_key():
    """支付宝平台公钥默认 X.509 SPKI（"BEGIN PUBLIC KEY"），但偶尔也见 PKCS#1
    （"BEGIN RSA PUBLIC KEY"）。同样依次尝试。"""
    raw = config.ALIPAY_PUBLIC_KEY.strip()
    if raw.startswith("-----"):
        return serialization.load_pem_public_key(raw.encode())
    last_err: Exception | None = None
    for label in ("PUBLIC KEY", "RSA PUBLIC KEY"):
        try:
            pem = _wrap_pem(raw, label)
            return serialization.load_pem_public_key(pem.encode())
        except (ValueError, TypeError) as e:
            last_err = e
    raise ValueError(f"无法解析 ALIPAY_PUBLIC_KEY: {last_err}")


def _canonical(params: dict[str, str]) -> str:
    """按 key 字典序拼成 k=v&k=v；空值字段排除。"""
    items = sorted((k, v) for k, v in params.items() if v not in ("", None))
    return "&".join(f"{k}={v}" for k, v in items)


def _sign(params: dict[str, str]) -> str:
    raw = _canonical(params).encode("utf-8")
    sig = _load_private_key().sign(raw, padding.PKCS1v15(), hashes.SHA256())
    return base64.b64encode(sig).decode()


async def _post(params: dict[str, str], timeout: float) -> dict:
    """手动 URL-encode 整个 body 再发 — 不走 aiohttp.FormData。
    aiohttp 的 FormData 在我们实测里跟支付宝沙箱的 canonical 重建有微妙差异
    （sign 验不过），requests 反而 OK。直接发 application/x-www-form-urlencoded
    原始字节，跟 requests / urllib 行为一致。"""
    body = urlencode(params).encode("utf-8")
    headers = {"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"}
    async with aiohttp.ClientSession(headers=headers) as s:
        async with s.post(
            config.ALIPAY_GATEWAY, data=body,
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as r:
            return await r.json(content_type=None)


async def create_order(out_trade_no: str, yuan: int, subject: str, notify_url: str) -> str:
    """下单，返回 code_url（用户扫这个 URL 即可付款，前端 qrcode.js 渲染成图）。"""
    if not config.ALIPAY_ENABLED:
        raise RuntimeError("支付宝未配置")
    biz = json.dumps(
        {
            "out_trade_no": out_trade_no,
            "total_amount": f"{yuan:.2f}",
            "subject": subject,
        },
        separators=(",", ":"),
        ensure_ascii=False,
    )
    params: dict[str, str] = {
        "app_id": config.ALIPAY_APP_ID,
        "method": "alipay.trade.precreate",
        "format": "JSON",
        "charset": "utf-8",
        "sign_type": "RSA2",
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "version": "1.0",
        "notify_url": notify_url,
        "biz_content": biz,
    }
    params["sign"] = _sign(params)
    data = await _post(params, timeout=10)
    resp = data.get("alipay_trade_precreate_response") or {}
    if resp.get("code") != "10000":
        log.warning(f"[alipay] precreate 失败 out_trade_no={out_trade_no} resp={resp}")
        sub_msg = resp.get("sub_msg") or ""
        # 应用还没上线 / 没签约当面付：把 alipay 内部错误码翻成用户看得懂的话术。
        # 审批 1–3 天，期间用户点"立即购买"会撞这个；上线后自动消失。
        if "应用未上线" in sub_msg or "未上线" in sub_msg:
            raise RuntimeError("支付宝续费正在接入中，敬请期待")
        raise RuntimeError(f"支付宝下单失败: {resp.get('msg')} {sub_msg}".strip())
    qr = resp.get("qr_code") or ""
    if not qr:
        raise RuntimeError("支付宝下单返回无 qr_code")
    return qr


def verify_notify(form: dict[str, str]) -> tuple[str, str, str, str]:
    """验签 + 事件归类。返回 (event, out_trade_no, trade_no, amount)。
    event:
      • 'paid'     —— trade_status=TRADE_SUCCESS/TRADE_FINISHED 且无 refund_fee；
                     amount = total_amount 字符串 (e.g. "57.00")，外层据此校验金额
      • 'refunded' —— 退款通知 (refund_fee 非零 或 trade_status=TRADE_CLOSED 且曾付款)；
                     amount = refund_fee 字符串
      • 'ignore'   —— 验签过但无需动作（WAIT_BUYER_PAY 等），让外层回 success 停推
      • 'invalid'  —— 签名 / app_id 不对，让外层回 failure 让支付宝重试 / 报警
    """
    if not config.ALIPAY_ENABLED:
        return "invalid", "", "", ""
    sign_b64 = form.get("sign", "")
    if not sign_b64:
        return "invalid", "", "", ""
    payload = {k: v for k, v in form.items() if k not in ("sign", "sign_type")}
    raw = _canonical(payload).encode("utf-8")
    try:
        _load_public_key().verify(
            base64.b64decode(sign_b64), raw, padding.PKCS1v15(), hashes.SHA256(),
        )
    except (InvalidSignature, ValueError) as e:
        log.warning(f"[alipay] notify 验签失败: {e}")
        return "invalid", "", "", ""
    if form.get("app_id") != config.ALIPAY_APP_ID:
        log.warning(f"[alipay] notify app_id 不匹配: {form.get('app_id')}")
        return "invalid", "", "", ""

    out_trade_no = form.get("out_trade_no", "")
    trade_no = form.get("trade_no", "")
    status = form.get("trade_status", "")
    refund_fee_raw = (form.get("refund_fee") or "").strip()
    try:
        has_refund = float(refund_fee_raw) > 0 if refund_fee_raw else False
    except ValueError:
        has_refund = False

    if has_refund:
        return "refunded", out_trade_no, trade_no, refund_fee_raw
    if status in ("TRADE_SUCCESS", "TRADE_FINISHED"):
        return "paid", out_trade_no, trade_no, form.get("total_amount", "")
    return "ignore", out_trade_no, trade_no, ""


async def query_order(out_trade_no: str) -> tuple[str, str]:
    """主动查单，给前端轮询用。返回 (status, external_trade_no)。
    status ∈ {'pending', 'paid', 'closed', 'unknown'}。"""
    if not config.ALIPAY_ENABLED:
        return "unknown", ""
    biz = json.dumps({"out_trade_no": out_trade_no}, separators=(",", ":"))
    params: dict[str, str] = {
        "app_id": config.ALIPAY_APP_ID,
        "method": "alipay.trade.query",
        "format": "JSON",
        "charset": "utf-8",
        "sign_type": "RSA2",
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "version": "1.0",
        "biz_content": biz,
    }
    params["sign"] = _sign(params)
    try:
        data: dict[str, Any] = await _post(params, timeout=8)
    except Exception as e:
        log.warning(f"[alipay] query_order 异常 out_trade_no={out_trade_no}: {e}")
        return "unknown", ""
    resp = data.get("alipay_trade_query_response") or {}
    code = resp.get("code")
    # 订单不存在时支付宝返回 40004 ACQ.TRADE_NOT_EXIST → 还没扫
    if code == "40004":
        return "pending", ""
    if code != "10000":
        log.warning(f"[alipay] query 异常 out_trade_no={out_trade_no} resp={resp}")
        return "unknown", ""
    status = resp.get("trade_status", "")
    trade_no = resp.get("trade_no", "")
    if status in ("TRADE_SUCCESS", "TRADE_FINISHED"):
        return "paid", trade_no
    if status == "TRADE_CLOSED":
        return "closed", trade_no
    return "pending", trade_no
