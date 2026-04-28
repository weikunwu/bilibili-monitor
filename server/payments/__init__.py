"""支付通道：用户扫码续费房间。当前只接了支付宝当面付。

provider 模块导出：
  • create_order(out_trade_no, yuan, subject, notify_url) → code_url
  • verify_notify(form_or_headers, ...) → (ok, out_trade_no, external_trade_no)
  • query_order(out_trade_no) → (status, external_trade_no)
    status ∈ 'pending' | 'paid' | 'closed' | 'unknown'
"""
