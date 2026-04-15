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

const BLIND_DEFAULT_TEMPLATE = '感谢{name}的{count}个盲盒，{verdict}'
const GUARD_DEFAULT_TEMPLATE = '感谢{name}{content}了{num}个月{guard}'
const WELCOME_DEFAULT_TEMPLATE = '欢迎{name}进入直播间'

// 多模版编辑器，用于大航海感谢/盲盒播报/欢迎弹幕，按需提供占位符说明与默认。
function MultiTemplateEditor({
  roomId, cmdId, initialTemplates, defaultTemplate, placeholdersHint, onSaved,
}: {
  roomId: number | null
  cmdId: string
  initialTemplates: string[]
  defaultTemplate: string
  placeholdersHint: React.ReactNode
  onSaved: (config: { templates: string[] }) => void
}) {
  const [items, setItems] = useState<string[]>(initialTemplates.length ? initialTemplates : [defaultTemplate])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  function upd(idx: number, v: string) {
    setItems((prev) => prev.map((m, i) => (i === idx ? v : m)))
  }
  function rem(idx: number) {
    setItems((prev) => (prev.length <= 1 ? [''] : prev.filter((_, i) => i !== idx)))
  }
  function add() {
    setItems((prev) => [...prev, ''])
  }

  async function persist(templates: string[]) {
    if (!roomId) return
    const cleaned = templates.map((s) => s.trim()).filter(Boolean)
    const final = cleaned.length ? cleaned : [defaultTemplate]
    setSaving(true)
    try {
      await saveCommandConfig(roomId, cmdId, { templates: final })
      onSaved({ templates: final })
      setSaved(true); setTimeout(() => setSaved(false), 1500)
    } finally { setSaving(false) }
  }

  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 12, color: '#888' }}>{placeholdersHint}</div>
      {items.map((m, idx) => (
        <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Input size="sm" value={m} onChange={(v) => upd(idx, v)} placeholder={defaultTemplate} style={{ flex: 1 }} />
          <button className="rs-btn rs-btn-subtle rs-btn-sm" onClick={() => rem(idx)} title="删除">×</button>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="rs-btn rs-btn-subtle rs-btn-sm" onClick={add}>+ 添加一条</button>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="rs-btn rs-btn-subtle rs-btn-sm"
            style={{ width: 88 }}
            onClick={() => { setItems([defaultTemplate]); void persist([defaultTemplate]) }}
          >恢复默认</button>
          <button
            className="rs-btn rs-btn-primary rs-btn-sm"
            style={{ width: 88 }}
            onClick={() => persist(items)}
            disabled={saving}
          >
            {saving ? '保存中…' : saved ? '已保存' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
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
        支持占位符：<code>{'{streamer}'}</code> 替换为主播昵称
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
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="rs-btn rs-btn-subtle rs-btn-sm"
            style={{ width: 88 }}
            onClick={async () => {
              if (!roomId) return
              const defMsgs = ['动动手指给{streamer}点点关注']
              const defIv = 300
              setMessages(defMsgs)
              setInterval(String(defIv))
              await saveCommandConfig(roomId, cmdId, { messages: defMsgs, interval_sec: defIv })
              onSaved({ messages: defMsgs, interval_sec: defIv })
              setSaved(true); setTimeout(() => setSaved(false), 1500)
            }}
          >恢复默认</button>
          <button
            className="rs-btn rs-btn-primary rs-btn-sm"
            style={{ width: 88 }}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? '保存中…' : saved ? '已保存' : '保存'}
          </button>
        </div>
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
            {(cmd.id === 'broadcast_welcome' || cmd.id === 'broadcast_guard' || cmd.id === 'broadcast_blind') && (
              <MultiTemplateEditor
                roomId={roomId}
                cmdId={cmd.id}
                initialTemplates={
                  (cmd.config?.templates as string[])
                  || (cmd.config?.template ? [cmd.config.template as string] : [])
                }
                defaultTemplate={
                  cmd.id === 'broadcast_welcome' ? WELCOME_DEFAULT_TEMPLATE
                    : cmd.id === 'broadcast_guard' ? GUARD_DEFAULT_TEMPLATE
                    : BLIND_DEFAULT_TEMPLATE
                }
                placeholdersHint={
                  cmd.id === 'broadcast_welcome'
                    ? (<>占位符：<code>{'{name}'}</code> 用户昵称，<code>{'{streamer}'}</code> 主播昵称</>)
                    : cmd.id === 'broadcast_guard'
                    ? (<>占位符：<code>{'{name}'}</code> 用户昵称，<code>{'{streamer}'}</code> 主播昵称，<code>{'{content}'}</code> 开通/续费，<code>{'{num}'}</code> 月数，<code>{'{guard}'}</code> 舰长/提督/总督</>)
                    : (<>占位符：<code>{'{name}'}</code> 用户昵称，<code>{'{streamer}'}</code> 主播昵称，<code>{'{count}'}</code> 盲盒数，<code>{'{verdict}'}</code> 盈亏</>)
                }
                onSaved={(config: { templates: string[] }) => {
                  setCommands((prev) => prev.map((c) => (
                    c.id === cmd.id ? { ...c, config: { ...c.config, ...config } } : c
                  )))
                }}
              />
            )}
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
