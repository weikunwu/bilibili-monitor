import { useState } from 'react'
import { Button, Input, Message, useToaster } from 'rsuite'
import { authLogin } from '../api/client'

export function LoginPage() {
  const toaster = useToaster()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const handleLogin = async () => {
    if (!email || !email.includes('@')) {
      toaster.push(<Message type="error">请输入有效邮箱</Message>, { placement: 'topCenter', duration: 3000 })
      return
    }
    setBusy(true)
    try {
      const res = await authLogin(email.trim().toLowerCase(), password)
      if (res.ok) {
        window.location.href = '/'
      } else {
        toaster.push(<Message type="error">{res.error || '登录失败'}</Message>, { placement: 'topCenter', duration: 3000 })
      }
    } finally {
      setBusy(false)
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
        <p style={{ color: '#888', textAlign: 'center', fontSize: 13, marginTop: -8 }}>登录</p>

        <form onSubmit={(e) => { e.preventDefault(); handleLogin() }}
              style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 20 }}>
          <Input type="email" placeholder="邮箱" value={email} onChange={setEmail} autoFocus />
          <Input type="password" placeholder="密码" value={password} onChange={setPassword} />
          <Button
            appearance="primary"
            type="submit"
            loading={busy}
            style={{ background: '#fb7299', border: 'none', marginTop: 4 }}
            block
          >
            登录
          </Button>
        </form>

        <div style={{ textAlign: 'center', marginTop: 16, fontSize: 13 }}>
          <a href="/register" style={{ color: '#fb7299' }}>没有账号？注册</a>
        </div>
      </div>
    </div>
  )
}
