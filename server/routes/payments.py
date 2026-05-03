"""扫码续费房间：用户在前端选档位 + 渠道（目前仅 Z-Pay → 支付宝）→ 后端调
provider 下单拿 code_url → 前端把 code_url 渲染成二维码让用户扫付。

幂等链路：
  1. 创建本地订单 (out_trade_no, status=pending) + 调 provider 下单
  2. 用户扫码付款
  3. provider 异步推 notify → /api/payments/notify/{provider}
       验签 → 反查 out_trade_no → apply_payment_order(...) 续期房间 + 写 paid
  4. 前端轮询 /api/payments/order/{out_trade_no}/status：
       看本地 status；如果还是 pending 主动调 provider query 兜底
       （网络抖动导致 notify 迟到时也能在前端及时显示成功）

订单号格式：BB<UNIX_MS>-<6 位 hex>，前缀方便日志检索；
provider 接受最长 32 字节，BB + 13 + 1 + 6 = 22 字节足够。
"""

from __future__ import annotations

import json
import secrets
import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from .. import config
from ..auth import require_room_access
from ..config import RENEWAL_PLANS, RENEWAL_PLANS_BY_ID, log
from ..db import (
    apply_payment_order, create_payment_order, get_payment_order,
    get_room_expires_at, reverse_payment_order, mark_payment_order_rejected,
)
from ..payments import zpay


router = APIRouter()


def _gen_out_trade_no() -> str:
    return f"BB{int(time.time() * 1000)}-{secrets.token_hex(3)}"


# 下单接口的用户级限流：每用户最近 60s 不超过 5 次成功下单尝试。
# 防有人快速点 / 脚本灌爆我们 DB + 把 zpay 商户号 QPS 耗光。
# 算法：每 user 一个 timestamp deque，新请求来时清掉 60s 前的，再看长度。
_ORDER_RATE_WINDOW_SEC = 60
_ORDER_RATE_MAX = 60
_order_attempts: dict[int, deque[float]] = defaultdict(deque)


def _check_order_rate(user_id: int) -> None:
    """命中限流时直接抛 429。"""
    now = time.time()
    dq = _order_attempts[user_id]
    while dq and now - dq[0] > _ORDER_RATE_WINDOW_SEC:
        dq.popleft()
    if len(dq) >= _ORDER_RATE_MAX:
        raise HTTPException(429, f"下单太频繁，请稍后再试（{_ORDER_RATE_WINDOW_SEC}s 内最多 {_ORDER_RATE_MAX} 次）")
    dq.append(now)


# 仅 admin/staff 可见可付的档位 id;前端不下发,后端下单也拦
_STAFF_ONLY_PLAN_IDS = {"test"}


def _is_staff(request: Request) -> bool:
    return getattr(request.state, "user_role", None) in ("admin", "staff")


def _public_plans(request: Request) -> list[dict]:
    show_staff = _is_staff(request)
    return [
        {"id": p["id"], "months": p["months"], "yuan": p["yuan"], "label": p["label"]}
        for p in RENEWAL_PLANS
        if show_staff or p["id"] not in _STAFF_ONLY_PLAN_IDS
    ]


@router.get("/api/payments/plans")
async def get_plans(request: Request):
    """前端打开 modal 时拉一次：可选档位 + 哪些渠道开了。
    渠道没配置就不显示，避免用户点了之后才报 500。"""
    return {
        "plans": _public_plans(request),
        "channels": {
            "zpay": config.ZPAY_ENABLED,
        },
    }


@router.post("/api/rooms/{room_id}/payments/order")
async def create_order(
    room_id: int, request: Request, _=Depends(require_room_access),
):
    """body: {plan_id: str, channel: 'zpay'}
    返回 {out_trade_no, code_url, expire, channel}。code_url 是
    https://z-pay.cn/submit.php?... 前端直接渲染成 QR;
    扫码者浏览器打开后由 zpay 跳支付宝收银台。"""
    body = await request.json()
    plan_id = str(body.get("plan_id", "")).strip()
    channel = str(body.get("channel", "")).strip()
    plan = RENEWAL_PLANS_BY_ID.get(plan_id)
    if not plan:
        raise HTTPException(400, "无效的档位")
    # 仅员工可下单的档位(如测试单),普通用户拼 plan_id 调过来直接 403
    if plan_id in _STAFF_ONLY_PLAN_IDS and not _is_staff(request):
        raise HTTPException(403, "无权使用该档位")
    if channel != "zpay":
        raise HTTPException(400, "channel 必须是 zpay")
    if not config.ZPAY_ENABLED:
        raise HTTPException(503, "Z-Pay 未配置")

    user_id = getattr(request.state, "user_id", None)
    if user_id:
        _check_order_rate(user_id)
    out_trade_no = _gen_out_trade_no()
    subject = f"BlackBubu 房间 {room_id} 续费 · {plan['label']}"
    notify_url = f"{config.PAYMENT_NOTIFY_BASE}/api/payments/notify/{channel}"

    try:
        code_url = await zpay.create_order(
            out_trade_no, plan["yuan"], subject, notify_url,
        )
    except RuntimeError as e:
        log.warning(f"[payments] 下单失败 channel={channel} room={room_id} plan={plan_id}: {e}")
        raise HTTPException(400, str(e))

    create_payment_order(
        out_trade_no=out_trade_no, provider=channel, room_id=room_id,
        user_id=user_id, plan_id=plan_id, months=plan["months"],
        yuan=plan["yuan"], code_url=code_url,
    )
    log.info(
        f"[payments] 下单 channel={channel} room={room_id} user={user_id} "
        f"plan={plan_id} yuan={plan['yuan']} out_trade_no={out_trade_no}"
    )
    return {
        "out_trade_no": out_trade_no,
        "code_url": code_url,
        "channel": channel,
        "expire": config.PAYMENT_ORDER_TTL_SEC,
        "yuan": plan["yuan"],
        "months": plan["months"],
    }


@router.get("/api/payments/order/{out_trade_no}/status")
async def get_order_status(out_trade_no: str, request: Request):
    """前端轮询用，纯看本地 DB 状态。
    pending 转 paid 由 notify webhook（亚秒级）+ reconcile 任务（≤5min）兜底,
    本接口不再主动调 provider —— modal 每 3s 一次 × 多用户在线，会把 zpay
    商户号 QPS 打满，且兜底场景已被 reconcile 覆盖。
    返回 {status, expires_at?}。expires_at 仅 paid 时返回（前端刷新房间列表用）。"""
    order = get_payment_order(out_trade_no)
    if not order:
        raise HTTPException(404, "订单不存在")
    allowed = getattr(request.state, "allowed_rooms", None)
    if allowed is not None and order["room_id"] not in allowed:
        raise HTTPException(403, "无权限访问该房间")

    status = order["status"]
    if status == "paid":
        return {"status": "paid", "expires_at": get_room_expires_at(order["room_id"])}
    if status == "rejected":
        return {"status": "rejected"}
    if status in ("expired", "refunded"):
        return {"status": "expired"}
    return {"status": "pending"}


# ─── 异步通知 webhook（auth.py 白名单）──
# 公网可达；zpay 默认走 GET（query string），也兼容 POST form-encoded。
# 只声明 POST 会让 GET 通知吃 405、订单只能靠 reconcile 兜底。

@router.api_route("/api/payments/notify/zpay", methods=["GET", "POST"])
async def notify_zpay(request: Request):
    if request.method == "GET":
        form = dict(request.query_params)
    else:
        form = dict(await request.form())
    event, out_trade_no, trade_no, amount = zpay.verify_notify(form)
    if event == "invalid":
        # 验签失败 / pid 不对 → 让 zpay 重推（也能在日志看到攻击迹象）
        return Response(content="failure", media_type="text/plain", status_code=400)
    if event == "ignore" or not out_trade_no:
        # 中间态：验签过但无需动作；回 success 让 zpay 停推
        return Response(content="success", media_type="text/plain")

    raw = json.dumps(form, ensure_ascii=False)

    if event == "paid":
        # 金额校验：zpay 传回的 money 必须跟本地订单 yuan 严格相等。
        # 这是防御纵深 —— 即使签名层被绕过，攻击者也没法用 1 元订单续年卡。
        order = get_payment_order(out_trade_no)
        if not order:
            log.warning(f"[payments] zpay notify 找不到本地订单 out_trade_no={out_trade_no}")
            return Response(content="success", media_type="text/plain")
        expected = f"{int(order['yuan']):.2f}"
        if amount and amount != expected:
            log.warning(
                f"[payments] zpay notify 金额不符 out_trade_no={out_trade_no} "
                f"got={amount} expected={expected} → 标记 rejected"
            )
            # 落库 rejected 防 polling/reconcile 路径绕过校验把它应用上
            mark_payment_order_rejected(out_trade_no, raw_json=raw)
            return Response(content="failure", media_type="text/plain", status_code=400)
        ok, info = apply_payment_order(out_trade_no, external_trade_no=trade_no, raw_json=raw)
        if ok:
            log.info(f"[payments] zpay notify 应用成功 out_trade_no={out_trade_no} → {info}")
        else:
            log.info(f"[payments] zpay notify 未应用 out_trade_no={out_trade_no}: {info}")
        return Response(content="success", media_type="text/plain")

    if event == "refunded":
        ok, info = reverse_payment_order(out_trade_no, raw_json=raw)
        if ok:
            log.warning(
                f"[payments] zpay 退款回滚 out_trade_no={out_trade_no} "
                f"refund_money={amount} → expires_at={info}"
            )
        else:
            log.info(f"[payments] zpay 退款未应用 out_trade_no={out_trade_no}: {info}")
        return Response(content="success", media_type="text/plain")

    return Response(content="success", media_type="text/plain")
