"""支付通道：用户扫码续费房间。当前接的是 Z-Pay (彩虹易支付，type=alipay)。

provider 模块导出：
  • create_order(out_trade_no, yuan, subject, notify_url) → code_url
  • verify_notify(form) → (event, out_trade_no, trade_no, amount)
  • query_order(out_trade_no) → (status, external_trade_no)
    status ∈ 'pending' | 'paid' | 'closed' | 'unknown'
"""
