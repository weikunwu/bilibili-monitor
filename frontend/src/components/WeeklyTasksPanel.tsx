import { useEffect, useState } from 'react'
import { Input, InputGroup, Button } from 'rsuite'
import CopyIcon from '@rsuite/icons/Copy'
import VisibleIcon from '@rsuite/icons/Visible'
import ReloadIcon from '@rsuite/icons/Reload'
import { fetchOverlayToken, rotateOverlayToken } from '../api/client'
import { useIsMobile } from '../hooks/useIsMobile'
import { confirmDialog } from '../lib/confirm'
import previewImg from '../assets/weekly-tasks-preview.png'

interface Props {
  roomId: number
}

function Section({
  title, description, children, isMobile,
}: { title: string; description?: string; children: React.ReactNode; isMobile: boolean }) {
  return (
    <div
      style={{
        background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 10,
        padding: isMobile ? '14px 14px' : '16px 20px',
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600, color: '#e8e8e8', marginBottom: description ? 4 : 12 }}>
        {title}
      </div>
      {description && (
        <div style={{ fontSize: 12, color: '#888', lineHeight: 1.6, marginBottom: 12 }}>{description}</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </div>
  )
}

export function WeeklyTasksPanel({ roomId }: Props) {
  const isMobile = useIsMobile()
  const [token, setToken] = useState('')
  const [copied, setCopied] = useState(false)
  const [rotating, setRotating] = useState(false)
  // B 站返回的本轮 cycle 起止（秒级 unix ts），用来展示真实的重置时间 —— 不是每周一，
  // 而是心动盲盒自己的 cycle（在写本段时观察到 Sat 00:00 → Fri 23:59 CST，但以 API 为准）。
  const [cycle, setCycle] = useState<{ start: number; end: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchOverlayToken(roomId).then((t) => { if (!cancelled) setToken(t) }).catch(() => {})
    return () => { cancelled = true }
  }, [roomId])

  useEffect(() => {
    if (!token) return
    let cancelled = false
    fetch(`/api/overlay/weekly-tasks/${roomId}?token=${encodeURIComponent(token)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (cancelled || !d) return
        const s = Number(d.cycle_start_time) || 0
        const e = Number(d.cycle_end_time) || 0
        if (s > 0 && e > 0) setCycle({ start: s, end: e })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [roomId, token])

  const url = token ? `${window.location.origin}/overlay/${roomId}/weekly-tasks?token=${token}` : ''
  const cycleText = cycle ? formatCycleCst(cycle.start, cycle.end) : ''

  async function copy() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }

  async function rotate() {
    if (!await confirmDialog({ message: '重新生成 token 会让旧链接立即失效，确认继续？', danger: true, okText: '重新生成' })) return
    setRotating(true)
    try {
      const t = await rotateOverlayToken(roomId)
      setToken(t)
    } finally { setRotating(false) }
  }

  return (
    <div>
      <div className="panel-title">心动每周进度</div>
      <div style={{ padding: isMobile ? '0 12px 20px' : '0 24px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Section
          isMobile={isMobile}
          title="浏览器源链接"
          description={`本周累计「心动盲盒」数量的进度条件栏，里程碑 20 / 60 / 120 / 180，按 B 站心动盲盒 cycle 自动重置${cycleText ? `（本轮 ${cycleText}，北京时间）` : '（以 B 站 cycle 为准，不是周一）'}。用 OBS 等直播工具添加「浏览器源」粘贴此链接即可叠加到直播画面。链接带 token 鉴权，和其他 overlay 共用同一个 token，「重新生成」会同时让所有 overlay 旧链接失效。`}
        >
          <img
            src={previewImg}
            alt="心动每周进度 overlay 预览"
            style={{
              display: 'block',
              width: '100%',
              maxWidth: 460,
              borderRadius: 8,
              border: '1px solid #2a2a4a',
              background: '#0b0b12',
            }}
          />
          <InputGroup size="sm" inside>
            <Input readOnly value={url} placeholder="加载中…" />
            <InputGroup.Button onClick={copy} disabled={!url} title="复制链接">
              <CopyIcon style={{ fontSize: 14 }} /> {copied ? '已复制' : '复制'}
            </InputGroup.Button>
            <InputGroup.Button onClick={() => url && window.open(url, '_blank')} disabled={!url} title="打开预览">
              <VisibleIcon style={{ fontSize: 14 }} /> 预览
            </InputGroup.Button>
          </InputGroup>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button appearance="subtle" size="sm" startIcon={<ReloadIcon />} onClick={rotate} loading={rotating}>
              重新生成 token
            </Button>
          </div>
        </Section>
      </div>
    </div>
  )
}

// 把 cycle_start/end unix ts 格式化为北京时间的 "M/D(周X) HH:mm → M/D(周X) HH:mm"。
// 不依赖宿主机时区 —— 手动算 CST(+08:00) 的日期字段。
function formatCycleCst(startSec: number, endSec: number): string {
  const fmt = (sec: number) => {
    const d = new Date((sec + 8 * 3600) * 1000)
    const m = d.getUTCMonth() + 1
    const day = d.getUTCDate()
    const hh = String(d.getUTCHours()).padStart(2, '0')
    const mm = String(d.getUTCMinutes()).padStart(2, '0')
    const wk = '日一二三四五六'[d.getUTCDay()]
    return `${m}/${day}(周${wk}) ${hh}:${mm}`
  }
  return `${fmt(startSec)} → ${fmt(endSec)}`
}
