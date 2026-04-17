import { useEffect, useState } from 'react'
import { Button, Input, Message, useToaster } from 'rsuite'
import { sendRegisterCode, registerWithCode } from '../api/client'

export function RegisterPage() {
  const toaster = useToaster()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const [sending, setSending] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  const showErr = (msg: string) =>
    toaster.push(<Message type="error">{msg}</Message>, { placement: 'topCenter', duration: 3000 })
  const showOk = (msg: string) =>
    toaster.push(<Message type="success">{msg}</Message>, { placement: 'topCenter', duration: 3000 })

  const handleSendCode = async () => {
    if (!email || !email.includes('@')) { showErr('请输入有效邮箱'); return }
    setSending(true)
    try {
      const res = await sendRegisterCode(email.trim().toLowerCase())
      if (res.ok) {
        showOk('验证码已发送，请查收邮箱（含垃圾箱）')
        setCooldown(60)
      } else {
        showErr(res.error || '发送失败')
      }
    } finally {
      setSending(false)
    }
  }

  const handleRegister = async () => {
    if (!email || !email.includes('@')) { showErr('请输入有效邮箱'); return }
    if (code.length !== 6) { showErr('验证码为 6 位数字'); return }
    if (password.length < 6) { showErr('密码至少 6 位'); return }
    if (password !== confirm) { showErr('两次输入的密码不一致'); return }
    setSubmitting(true)
    try {
      const res = await registerWithCode(email.trim().toLowerCase(), code.trim(), password)
      if (res.ok) {
        showOk('注册成功，正在登录…')
        setTimeout(() => { window.location.href = '/' }, 600)
      } else {
        showErr(res.error || '注册失败')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
    }}>
      <div style={{
        background: '#1a1a2e', padding: 36, borderRadius: 16,
        border: '1px solid #2a2a4a', width: '100%', maxWidth: 360,
      }}>
        <h2 style={{ color: '#fb7299', textAlign: 'center', marginTop: 0 }}>布布机器人</h2>
        <p style={{ color: '#888', textAlign: 'center', fontSize: 13, marginTop: -8 }}>注册新账号</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 20 }}>
          <Input type="email" placeholder="邮箱" value={email} onChange={setEmail} autoFocus />
          <div style={{ display: 'flex', gap: 8 }}>
            <Input placeholder="6 位验证码" value={code} onChange={setCode} style={{ flex: 1 }} />
            <Button
              appearance="ghost"
              onClick={handleSendCode}
              disabled={cooldown > 0 || sending}
              loading={sending}
              style={{ minWidth: 110 }}
            >
              {cooldown > 0 ? `${cooldown}s` : '发送验证码'}
            </Button>
          </div>
          <Input type="password" placeholder="密码（至少 6 位）" value={password} onChange={setPassword} />
          <Input type="password" placeholder="确认密码" value={confirm} onChange={setConfirm} />
          <Button
            appearance="primary"
            onClick={handleRegister}
            loading={submitting}
            style={{ background: '#fb7299', border: 'none', marginTop: 4 }}
            block
          >
            注册
          </Button>
        </div>

        <div style={{ textAlign: 'center', marginTop: 16, fontSize: 13 }}>
          <a href="/login" style={{ color: '#fb7299' }}>已有账号？登录</a>
        </div>
      </div>
    </div>
  )
}
