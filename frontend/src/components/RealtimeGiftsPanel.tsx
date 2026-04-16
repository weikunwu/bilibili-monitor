import { useEffect, useState } from 'react'
import { Input, Button } from 'rsuite'
import { fetchOverlayToken, rotateOverlayToken } from '../api/client'

interface Props {
  roomId: number
}

export function RealtimeGiftsPanel({ roomId }: Props) {
  const [token, setToken] = useState('')
  const [copied, setCopied] = useState(false)
  const [rotating, setRotating] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchOverlayToken(roomId).then((t) => { if (!cancelled) setToken(t) }).catch(() => {})
    return () => { cancelled = true }
  }, [roomId])

  const url = token ? `${window.location.origin}/overlay/${roomId}/gifts?token=${token}` : ''

  async function copy() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  async function rotate() {
    if (!confirm('重新生成 token 会让旧链接立即失效，确认继续？')) return
    setRotating(true)
    try {
      const t = await rotateOverlayToken(roomId)
      setToken(t)
    } finally { setRotating(false) }
  }

  return (
    <div>
      <div className="panel-title">实时礼物</div>
      <div style={{ padding: '0 24px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: '#bbb', lineHeight: 1.6 }}>
          OBS 浏览器源用。打开下面的链接会显示"今天最近收到的礼物"（最多 10 位观众，按最近送礼时间排序，每 5 秒刷新）。
          链接带 token 鉴权，任何人知道这个 URL 都能看到；token 外泄后点"重新生成"即可让旧链接失效。
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Input readOnly value={url} size="sm" style={{ flex: 1 }} placeholder="加载中…" />
          <Button appearance="primary" size="sm" onClick={copy} disabled={!url} style={{ width: 88 }}>
            {copied ? '已复制' : '复制链接'}
          </Button>
          <Button appearance="subtle" size="sm" onClick={() => url && window.open(url, '_blank')} disabled={!url}>
            打开预览
          </Button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button appearance="ghost" size="sm" onClick={rotate} disabled={rotating}>
            {rotating ? '生成中…' : '重新生成 token'}
          </Button>
        </div>
      </div>
    </div>
  )
}
