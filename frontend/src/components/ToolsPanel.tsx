import { useState, useEffect } from 'react'
import { Toggle, SelectPicker, Input, InputGroup } from 'rsuite'
import type { Command } from '../types'
import {
  fetchCommands, toggleCommand, fetchAutoClip, toggleAutoClip,
  fetchCheapGifts, saveCommandConfig, type CheapGift,
} from '../api/client'

interface Props {
  roomId: number | null
}

// 每条一行的文本框 + 间隔输入；失焦/点击保存时提交。
function ScheduledDanmuEditor({
  roomId, cmdId, initialMessages, initialInterval, onSaved,
}: {
  roomId: number | null
  cmdId: string
  initialMessages: string[]
  initialInterval: number
  onSaved: (config: { messages: string[]; interval_sec: number }) => void
}) {
  const [messages, setMessages] = useState<string[]>(
    initialMessages.length > 0 ? initialMessages : [''],
  )
  const [interval, setInterval] = useState(String(initialInterval))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  function updateMsg(idx: number, val: string) {
    setMessages((prev) => prev.map((m, i) => (i === idx ? val : m)))
  }
  function removeMsg(idx: number) {
    setMessages((prev) => (prev.length <= 1 ? [''] : prev.filter((_, i) => i !== idx)))
  }
  function addMsg() {
    setMessages((prev) => [...prev, ''])
  }

  async function handleSave() {
    if (!roomId) return
    const cleaned = messages.map((s) => s.trim()).filter(Boolean)
    const iv = Math.max(60, Math.min(3600, Number(interval) || 300))
    setSaving(true)
    try {
      await saveCommandConfig(roomId, cmdId, { messages: cleaned, interval_sec: iv })
      onSaved({ messages: cleaned, interval_sec: iv })
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <InputGroup size="sm" style={{ width: 240 }}>
        <InputGroup.Addon>间隔</InputGroup.Addon>
        <Input
          type="number"
          value={interval}
          onChange={setInterval}
          style={(() => {
            const n = Number(interval)
            const invalid = interval !== '' && Number.isFinite(n) && (n < 60 || n > 3600)
            return invalid
              ? { textDecoration: 'line-through', color: '#ef5350' }
              : undefined
          })()}
          onBlur={() => {
            // 失焦时夹到 [60, 3600]，空值回到 300
            const n = Number(interval)
            if (!Number.isFinite(n) || interval === '') setInterval('300')
            else if (n < 60) setInterval('60')
            else if (n > 3600) setInterval('3600')
          }}
        />
        <InputGroup.Addon>秒 (60–3600)</InputGroup.Addon>
      </InputGroup>
      <div style={{ fontSize: 12, color: '#888' }}>
        支持占位符：<code>{'{主播}'}</code> 替换为主播昵称
      </div>
      {messages.map((m, idx) => (
        <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Input
            size="sm"
            value={m}
            onChange={(v) => updateMsg(idx, v)}
            placeholder={`弹幕 ${idx + 1}`}
            style={{ flex: 1 }}
          />
          <button
            className="rs-btn rs-btn-subtle rs-btn-sm"
            onClick={() => removeMsg(idx)}
            title="删除"
          >×</button>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="rs-btn rs-btn-subtle rs-btn-sm" onClick={addMsg}>+ 添加一条</button>
        <button
          className="rs-btn rs-btn-primary rs-btn-sm"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? '保存中…' : saved ? '已保存' : '保存'}
        </button>
      </div>
    </div>
  )
}

export function ToolsPanel({ roomId }: Props) {
  const [commands, setCommands] = useState<Command[]>([])
  const [autoClip, setAutoClip] = useState(false)
  const [cheapGifts, setCheapGifts] = useState<CheapGift[]>([])

  useEffect(() => {
    if (!roomId) return
    fetchCommands(roomId).then(setCommands).catch(() => {})
    fetchAutoClip(roomId).then(setAutoClip).catch(() => {})
    fetchCheapGifts(roomId).then(setCheapGifts).catch(() => {})
  }, [roomId])

  // 选中礼物后保存 config，数量按"总价 ≥ 1元"凑：1元 = 1000 金瓜子。
  async function handleAutoGiftChange(cmdIndex: number, giftId: number | null) {
    if (!roomId || giftId == null) return
    const g = cheapGifts.find((x) => x.gift_id === giftId)
    if (!g) return
    const num = Math.max(1, Math.ceil(1000 / g.price))
    const config = { gift_id: g.gift_id, gift_price: g.price, gift_num: num }
    await saveCommandConfig(roomId, commands[cmdIndex].id, config)
    setCommands((prev) => prev.map((c, i) => (
      i === cmdIndex ? { ...c, config: { ...c.config, ...config } } : c
    )))
  }

  async function handleToggle(cmdId: string, index: number) {
    if (!roomId) return
    await toggleCommand(roomId, cmdId)
    setCommands((prev) =>
      prev.map((c, i) => (i === index ? { ...c, enabled: !c.enabled } : c)),
    )
  }

  async function handleAutoClipToggle(enabled: boolean) {
    if (!roomId) return
    setAutoClip(enabled)
    try { await toggleAutoClip(roomId, enabled) } catch { setAutoClip(!enabled) }
  }

  return (
    <div>
      <div className="panel-title">主播工具</div>
      <div style={{ padding: '0 24px 16px' }}>
      {commands.map((cmd, i) => cmd.id === 'nickname_commands' ? null : (
        <div key={cmd.id} className="cmd-item">
          <div className="cmd-info">
            <div className="cmd-name" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{cmd.name}</span>
              <Toggle
                checked={cmd.enabled}
                onChange={() => handleToggle(cmd.id, i)}
                size="sm"
              />
            </div>
            <div className="cmd-desc">{cmd.description}</div>
            {cmd.id === 'scheduled_danmu' && (
              <ScheduledDanmuEditor
                roomId={roomId}
                cmdId={cmd.id}
                initialMessages={(cmd.config?.messages as string[]) || []}
                initialInterval={(cmd.config?.interval_sec as number) || 300}
                onSaved={(config: { messages: string[]; interval_sec: number }) => {
                  setCommands((prev) => prev.map((c) => (
                    c.id === cmd.id ? { ...c, config: { ...c.config, ...config } } : c
                  )))
                }}
              />
            )}
            {cmd.id === 'auto_gift' && cheapGifts.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <SelectPicker
                  size="sm"
                  searchable
                  cleanable={false}
                  data={cheapGifts.map((g) => {
                    const num = Math.max(1, Math.ceil(1000 / g.price))
                    const total = ((g.price * num) / 1000).toFixed(1).replace(/\.0$/, '')
                    return { label: `${g.name} ×${num} (¥${total})`, value: g.gift_id }
                  })}
                  value={cmd.config?.gift_id ?? null}
                  onChange={(v) => handleAutoGiftChange(i, v as number | null)}
                  placeholder="选择礼物"
                  style={{ width: 240 }}
                />
              </div>
            )}
          </div>
        </div>
      ))}
      <div className="cmd-section-title">实验功能</div>
      <div className="cmd-item">
        <div className="cmd-info">
          <div className="cmd-name" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>礼物自动剪辑</span>
            <Toggle checked={autoClip} onChange={handleAutoClipToggle} size="sm" />
            <span style={{ color: '#ef5350', fontWeight: 'normal' }}>
              非实际录屏！！仅模拟合成！！
            </span>
          </div>
          <div className="cmd-desc">直播时收到单价 ≥<span style={{ color: '#ef5350' }}>¥1000</span> 礼物时自动录制前后片段，可在礼物和大航海列表下载</div>
          <div className="cmd-desc">录制片段仅保留 24 小时</div>
        </div>
      </div>
    </div>
    </div>
  )
}
