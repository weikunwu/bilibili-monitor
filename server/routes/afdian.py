"""爱发电（ifdian）Webhook + 订单兑现

流程：
  用户点"爱发电续费" → 跳到 ifdian.net/order/create 带 custom_order_id=<room_id>
  → 付款成功后爱发电 POST /api/afdian/webhook
  → 我们反查 query-order（带签名）确认订单真实
  → plan_id → months 映射 → 更新 room.expires_at
  → 把订单写进 afdian_orders 表幂等防重

安全模型：webhook body 是爱发电发来的，但为了防伪造，所有实际字段都从
query-order 的响应里取，不信任 body 里的金额 / plan_id / custom_order_id。
Webhook URL 本身作为低敏感 secret（URL 已在 AuthMiddleware 白名单里）。
"""

import hashlib
import json
import time

import aiohttp
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..config import AFDIAN_PLANS, AFDIAN_QUERY_ORDER_API, log
from ..db import apply_afdian_order
import os

router = APIRouter()


def _afdian_sign(user_id: str, params_json: str, ts: int, token: str) -> str:
    # 爱发电签名规则：key 按字典序排序，拼成 token + k1 + v1 + k2 + v2 ... 再 md5
    # 这里要签的三个字段 key 字典序：params, ts, user_id
    raw = f"{token}params{params_json}ts{ts}user_id{user_id}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


async def _query_order(out_trade_no: str) -> dict | None:
    user_id = os.environ.get("AFDIAN_USER_ID", "")
    token = os.environ.get("AFDIAN_TOKEN", "")
    if not user_id or not token:
        log.warning("[afdian] AFDIAN_USER_ID/AFDIAN_TOKEN 未配置，无法验证订单")
        return None
    params_json = json.dumps({"out_trade_no": out_trade_no}, separators=(",", ":"))
    ts = int(time.time())
    sign = _afdian_sign(user_id, params_json, ts, token)
    body = {
        "user_id": user_id,
        "params": params_json,
        "ts": ts,
        "sign": sign,
    }
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(AFDIAN_QUERY_ORDER_API, json=body,
                              timeout=aiohttp.ClientTimeout(total=10)) as r:
                data = await r.json(content_type=None)
        if data.get("ec") != 200:
            log.warning(f"[afdian] query-order ec={data.get('ec')} em={data.get('em')}")
            return None
        orders = (data.get("data") or {}).get("list") or []
        for o in orders:
            if o.get("out_trade_no") == out_trade_no:
                return o
        log.warning(f"[afdian] out_trade_no={out_trade_no} 不在 query-order 返回里")
        return None
    except Exception as e:
        log.warning(f"[afdian] query-order 异常: {e}")
        return None


@router.post("/api/afdian/webhook")
async def afdian_webhook(request: Request):
    # 爱发电约定：响应 {"ec": 200, "em": ""} 视为成功，否则会重试。
    # 就算我们处理失败也尽量返回 200（日志里自己记），避免重试风暴打满 DB。
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ec": 200, "em": "bad json ignored"})

    order_from_hook = (body.get("data") or {}).get("order") or {}
    out_trade_no = order_from_hook.get("out_trade_no") or ""
    if not out_trade_no:
        log.warning(f"[afdian] webhook 无 out_trade_no: {body}")
        return JSONResponse({"ec": 200, "em": "no out_trade_no"})

    # 不信任 body，反查爱发电确认
    order = await _query_order(out_trade_no)
    if not order:
        # 查不到就当订单不存在 / 配置错了；返回 200 防重试，自己看日志
        return JSONResponse({"ec": 200, "em": "order not verified"})

    plan_id = order.get("plan_id") or ""
    months = AFDIAN_PLANS.get(plan_id)
    if not months:
        log.warning(f"[afdian] 未知 plan_id={plan_id}, out_trade_no={out_trade_no}")
        return JSONResponse({"ec": 200, "em": "unknown plan"})

    custom_order_id = (order.get("custom_order_id") or "").strip()
    try:
        room_id = int(custom_order_id)
    except (TypeError, ValueError):
        log.warning(f"[afdian] custom_order_id 不是 room_id: {custom_order_id!r}, "
                    f"out_trade_no={out_trade_no}")
        return JSONResponse({"ec": 200, "em": "bad custom_order_id"})

    ok, info = apply_afdian_order(
        out_trade_no=out_trade_no, room_id=room_id, months=months,
        total_amount=str(order.get("total_amount") or ""),
        raw_json=json.dumps(order, ensure_ascii=False),
    )
    if ok:
        log.info(f"[afdian] 订单 {out_trade_no} 为房间 {room_id} 续 {months} 月 → {info}")
    else:
        log.info(f"[afdian] 订单 {out_trade_no} 未应用: {info}")
    return JSONResponse({"ec": 200, "em": "ok"})
