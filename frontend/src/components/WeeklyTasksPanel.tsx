import { useEffect, useState } from 'react'
import { Input, InputGroup, Button } from 'rsuite'
import CopyIcon from '@rsuite/icons/Copy'
import VisibleIcon from '@rsuite/icons/Visible'
import ReloadIcon from '@rsuite/icons/Reload'
import { fetchOverlayToken, rotateOverlayToken } from '../api/client'
import { useIsMobile } from '../hooks/useIsMobile'
import { confirmDialog } from '../lib/confirm'
import previewImg from '../assets/weekly-tasks-preview.png'
import critPreviewImg from '../assets/crit-task-preview.png'

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

  useEffect(() => {
    let cancelled = false
    fetchOverlayToken(roomId).then((t) => { if (!cancelled) setToken(t) }).catch(() => {})
    return () => { cancelled = true }
  }, [roomId])

  const url = token ? `${window.location.origin}/overlay/${roomId}/weekly-tasks?token=${token}` : ''

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
          description="本周累计「心动盲盒」数量的进度条件栏，里程碑 20 / 60 / 120 / 180，按 B 站心动盲盒 cycle 自动重置。暴击任务触发时会自动切到暴击任务进度。用 OBS 等直播工具添加「浏览器源」粘贴此链接即可叠加到直播画面。链接带 token 鉴权，和其他 overlay 共用同一个 token，「重新生成」会同时让所有旧链接失效。"
        >
          <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', flexWrap: 'wrap', gap: isMobile ? 12 : 8 }}>
            {[
              { src: previewImg, alt: '心动盲盒 overlay 预览', caption: '心动盲盒收集期' },
              { src: critPreviewImg, alt: '暴击任务 overlay 预览', caption: '暴击任务收集期' },
            ].map(({ src, alt, caption }) => (
              <div key={alt} style={{ flex: isMobile ? '0 0 auto' : '1 1 220px', minWidth: 0 }}>
                <img
                  src={src}
                  alt={alt}
                  style={{
                    display: 'block',
                    width: '100%',
                    maxWidth: 460,
                    margin: '0 auto',
                    borderRadius: 8,
                  }}
                />
                <div style={{ fontSize: 11, color: '#888', marginTop: 4, textAlign: 'center' }}>
                  {caption}
                </div>
              </div>
            ))}
          </div>
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
