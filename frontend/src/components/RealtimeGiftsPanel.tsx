import { useEffect, useState } from 'react'
import {
  Input, InputGroup, Button, Checkbox, CheckboxGroup,
  RadioGroup, Radio, Message, Slider, Tag, Toggle, useToaster,
} from 'rsuite'
import CopyIcon from '@rsuite/icons/Copy'
import VisibleIcon from '@rsuite/icons/Visible'
import ReloadIcon from '@rsuite/icons/Reload'
import TrashIcon from '@rsuite/icons/Trash'
import {
  fetchOverlayToken, rotateOverlayToken,
  fetchOverlaySettings, updateOverlaySettings, clearOverlayHistory,
  type OverlaySettings,
} from '../api/client'
import { useIsMobile } from '../hooks/useIsMobile'
import { confirmDialog } from '../lib/confirm'

interface Props {
  roomId: number
}

const DEFAULTS: OverlaySettings = {
  max_events: 10,
  min_price: 0,
  max_price: 0,
  price_mode: 'total',
  show_gift: true,
  show_blind: true,
  show_guard: true,
  show_superchat: true,
  time_range: 'today',
  scroll_enabled: true,
  scroll_speed: 40,
  cleared_at: '',
}

const LABEL_WIDTH = 84

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: description ? 4 : 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#e8e8e8' }}>{title}</div>
      </div>
      {description && (
        <div style={{ fontSize: 12, color: '#888', lineHeight: 1.6, marginBottom: 12 }}>{description}</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </div>
  )
}

function Row({
  label, children, isMobile,
}: { label: string; children: React.ReactNode; isMobile: boolean }) {
  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 13, color: '#bbb' }}>{label}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {children}
        </div>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ width: LABEL_WIDTH, flexShrink: 0, fontSize: 13, color: '#bbb' }}>{label}</div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {children}
      </div>
    </div>
  )
}

function formatClearedAt(utc: string): string {
  if (!utc) return ''
  // "YYYY-MM-DD HH:MM:SS" (UTC) → Beijing time
  const d = new Date(utc.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return utc
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function RealtimeGiftsPanel({ roomId }: Props) {
  const toaster = useToaster()
  const isMobile = useIsMobile()
  const [token, setToken] = useState('')
  const [copied, setCopied] = useState(false)
  const [rotating, setRotating] = useState(false)

  const [committed, setCommitted] = useState<OverlaySettings>(DEFAULTS)
  const [draft, setDraft] = useState<OverlaySettings>(DEFAULTS)
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchOverlayToken(roomId).then((t) => { if (!cancelled) setToken(t) }).catch(() => {})
    fetchOverlaySettings(roomId).then((s) => {
      // 老后端可能没返新加的字段（如 scroll_enabled），跟 DEFAULTS 合并避免
      // Toggle / Slider 收到 undefined 渲染成关。
      if (!cancelled) {
        const merged = { ...DEFAULTS, ...s }
        setCommitted(merged); setDraft(merged)
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [roomId])

  const url = token ? `${window.location.origin}/overlay/${roomId}/gifts?token=${token}` : ''

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

  async function save() {
    setSaving(true)
    try {
      const s = await updateOverlaySettings(roomId, {
        max_events: draft.max_events,
        min_price: draft.min_price,
        max_price: draft.max_price,
        price_mode: draft.price_mode,
        show_gift: draft.show_gift,
        show_blind: draft.show_blind,
        show_guard: draft.show_guard,
        show_superchat: draft.show_superchat,
        time_range: draft.time_range,
        scroll_enabled: draft.scroll_enabled,
        scroll_speed: draft.scroll_speed,
      })
      const merged = { ...DEFAULTS, ...s }
      setCommitted(merged)
      setDraft(merged)
      toaster.push(<Message type="success" showIcon closable>已保存</Message>, { duration: 2000 })
    } catch (e) {
      toaster.push(<Message type="error" showIcon closable>{(e as Error).message}</Message>, { duration: 3000 })
    } finally { setSaving(false) }
  }

  async function clearDisplay() {
    if (!await confirmDialog({ message: '清除当前 overlay 展示？之后只会显示本次清除之后的新事件。', danger: true, okText: '清除' })) return
    setClearing(true)
    try {
      const s = await clearOverlayHistory(roomId)
      const merged = { ...DEFAULTS, ...s }
      setCommitted(merged)
      setDraft(merged)
      toaster.push(<Message type="success" showIcon closable>已清除</Message>, { duration: 2000 })
    } catch (e) {
      toaster.push(<Message type="error" showIcon closable>{(e as Error).message}</Message>, { duration: 3000 })
    } finally { setClearing(false) }
  }

  function resetDraft() {
    setDraft(committed)
  }

  const dirty = (
    draft.max_events !== committed.max_events
    || draft.min_price !== committed.min_price
    || draft.max_price !== committed.max_price
    || draft.price_mode !== committed.price_mode
    || draft.show_gift !== committed.show_gift
    || draft.show_blind !== committed.show_blind
    || draft.show_guard !== committed.show_guard
    || draft.show_superchat !== committed.show_superchat
    || draft.time_range !== committed.time_range
    || draft.scroll_enabled !== committed.scroll_enabled
    || draft.scroll_speed !== committed.scroll_speed
  )

  const shownTypes: string[] = []
  if (draft.show_gift) shownTypes.push('gift')
  if (draft.show_blind) shownTypes.push('blind')
  if (draft.show_guard) shownTypes.push('guard')
  if (draft.show_superchat) shownTypes.push('superchat')

  return (
    <div>
      <div className="panel-title">实时礼物截图</div>
      <div style={{ padding: isMobile ? '0 12px 20px' : '0 24px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        <Section
          isMobile={isMobile}
          title="浏览器源链接"
          description="链接带 token 鉴权，任何人知道 URL 都能看到该房间的礼物聚合。Token 外泄后点「重新生成」让旧链接失效。"
        >
          <InputGroup size="sm" inside>
            <Input readOnly value={url} placeholder="加载中…" />
            <InputGroup.Button onClick={copy} disabled={!url} title="复制链接">
              <CopyIcon style={{ fontSize: 14 }} /> {copied ? '已复制' : '复制'}
            </InputGroup.Button>
            <InputGroup.Button onClick={() => url && window.open(url, '_blank')} disabled={!url} title="打开预览">
              <VisibleIcon style={{ fontSize: 14 }} /> 预览
            </InputGroup.Button>
          </InputGroup>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Button
                appearance="subtle" size="sm" color="red"
                startIcon={<TrashIcon />} onClick={clearDisplay} loading={clearing}
              >
                清除当前展示
              </Button>
              {committed.cleared_at && (
                <Tag color="cyan">已清除至 {formatClearedAt(committed.cleared_at)}</Tag>
              )}
            </div>
            <Button appearance="subtle" size="sm" startIcon={<ReloadIcon />} onClick={rotate} loading={rotating}>
              重新生成 token
            </Button>
          </div>
        </Section>

        <Section title="展示设置" isMobile={isMobile}>
          <Row label="时间范围" isMobile={isMobile}>
            <RadioGroup
              inline
              value={draft.time_range}
              onChange={(v) => setDraft({ ...draft, time_range: (v as OverlaySettings['time_range']) })}
            >
              <Radio value="today">今日聚合</Radio>
              <Radio value="week">本周聚合</Radio>
              <Radio value="live">本次直播</Radio>
            </RadioGroup>
            <span style={{ color: '#888', fontSize: 12 }}>
              {draft.time_range === 'today' && '北京时间 00:00 起'}
              {draft.time_range === 'week' && '本周一 00:00 起'}
              {draft.time_range === 'live' && '本次开播时间起'}
            </span>
          </Row>

          <Row label="最多展示" isMobile={isMobile}>
            <Input
              type="number" size="sm"
              value={String(draft.max_events)}
              onChange={(v) => {
                const n = Math.max(1, Math.min(20, Number(v) || 10))
                setDraft({ ...draft, max_events: n })
              }}
              style={{ width: 110 }}
            />
            <span style={{ color: '#888', fontSize: 12 }}>条事件（1–20）</span>
          </Row>

          <Row label="展示类型" isMobile={isMobile}>
            <CheckboxGroup
              inline
              value={shownTypes}
              onChange={(vals) => {
                const arr = (vals as string[]) || []
                setDraft({
                  ...draft,
                  show_gift: arr.includes('gift'),
                  show_blind: arr.includes('blind'),
                  show_guard: arr.includes('guard'),
                  show_superchat: arr.includes('superchat'),
                })
              }}
            >
              <Checkbox value="gift">礼物</Checkbox>
              <Checkbox value="blind">盲盒</Checkbox>
              <Checkbox value="guard">大航海</Checkbox>
              <Checkbox value="superchat">醒目留言</Checkbox>
            </CheckboxGroup>
          </Row>

          <Row label="价格基准" isMobile={isMobile}>
            <RadioGroup
              inline
              value={draft.price_mode}
              onChange={(v) => setDraft({ ...draft, price_mode: (v as 'total' | 'unit') })}
            >
              <Radio value="total">总价</Radio>
              <Radio value="unit">单价</Radio>
            </RadioGroup>
            <span style={{ color: '#888', fontSize: 12 }}>
              {draft.price_mode === 'total' ? '按该事件的总金额判断' : '按单个礼物的单价判断'}
            </span>
          </Row>

          <Row label="价格区间" isMobile={isMobile}>
            <InputGroup size="sm" style={{ width: 150 }}>
              <Input
                type="number"
                value={String(draft.min_price)}
                onChange={(v) => setDraft({ ...draft, min_price: Math.max(0, Number(v) || 0) })}
                placeholder="最低"
              />
              <InputGroup.Addon>元</InputGroup.Addon>
            </InputGroup>
            <span style={{ color: '#666' }}>—</span>
            <InputGroup size="sm" style={{ width: 150 }}>
              <Input
                type="number"
                value={String(draft.max_price)}
                onChange={(v) => setDraft({ ...draft, max_price: Math.max(0, Number(v) || 0) })}
                placeholder="最高"
              />
              <InputGroup.Addon>元</InputGroup.Addon>
            </InputGroup>
            <span style={{ color: '#888', fontSize: 12 }}>0 表示不限</span>
          </Row>

          <Row label="循环滚动" isMobile={isMobile}>
            <Toggle
              checked={draft.scroll_enabled}
              onChange={(v) => setDraft({ ...draft, scroll_enabled: v })}
            />
            <span style={{ color: '#888', fontSize: 12 }}>
              {draft.scroll_enabled
                ? '卡片超出窗口时从下往上循环滚动'
                : '超出窗口的卡片直接裁掉'}
            </span>
          </Row>

          {draft.scroll_enabled && (
            <Row label="滚动速度" isMobile={isMobile}>
              <div style={{ width: isMobile ? '100%' : 260, padding: '6px 4px 0' }}>
                <Slider
                  min={1} max={100} step={1}
                  value={Math.max(1, draft.scroll_speed)}
                  onChange={(v) => setDraft({ ...draft, scroll_speed: v })}
                />
              </div>
              <span style={{ color: '#888', fontSize: 12 }}>{draft.scroll_speed}%</span>
            </Row>
          )}
        </Section>

        <div
          style={{
            display: 'flex', justifyContent: 'flex-end', gap: 8,
            padding: '12px 0', borderTop: '1px solid #2a2a4a',
          }}
        >
          <Button appearance="subtle" size="sm" onClick={resetDraft} disabled={!dirty || saving}>
            撤销
          </Button>
          <Button
            appearance="primary" size="sm"
            onClick={save} disabled={!dirty} loading={saving}
            style={{ minWidth: 88 }}
          >
            保存更改
          </Button>
        </div>
      </div>
    </div>
  )
}
