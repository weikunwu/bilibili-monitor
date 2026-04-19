import { useState, useEffect } from 'react'
import { Toggle, SelectPicker, Input, InputGroup, Button, IconButton } from 'rsuite'
import PlusIcon from '@rsuite/icons/Plus'
import CloseIcon from '@rsuite/icons/Close'
import type { Command } from '../types'
import {
  fetchCommands, toggleCommand, fetchAutoClip, toggleAutoClip,
  fetchCheapGifts, saveCommandConfig, type CheapGift,
} from '../api/client'
import { useIsMobile } from '../hooks/useIsMobile'

export type ToolsCategory = 'reactive' | 'automation'

interface Props {
  roomId: number | null
  /**
   * reactive = 观众触发 → 机器人回（AI/欢迎/感谢/潜水）
   * automation = 主播口令/定时/实验功能（打个有效/定时弹幕/自动剪辑）
   */
  category: ToolsCategory
}

// 按 category 归属每个 cmd.id。broadcast_thanks 的子项在 render 里被 ThanksGroup 吃掉，
// 这里只列出"会在顶层 map 里判断是否保留"的 id。
const REACTIVE_IDS = new Set([
  'ai_reply', 'broadcast_welcome', 'broadcast_thanks', 'lurker_mention', 'scheduled_danmu',
])
const AUTOMATION_IDS = new Set([
  'auto_gift', 'rare_blind_query',
])

const BLIND_DEFAULT_TEMPLATE = '感谢{name}的{count}个盲盒，{verdict}'
const GIFT_DEFAULT_TEMPLATE = '感谢{name}的 {gift_count}'
const GUARD_DEFAULT_TEMPLATE = '感谢{name}{content}了{num}个月{guard}'
const FOLLOW_DEFAULT_TEMPLATE = '感谢{name}的关注~'
const LIKE_DEFAULT_TEMPLATE = '感谢{name}的点赞~'
const SHARE_DEFAULT_TEMPLATE = '感谢{name}的分享~'
const SUPERCHAT_DEFAULT_TEMPLATE = '感谢{name}的醒目留言'
const LURKER_DEFAULT_TEMPLATE = '说点什么呀~'

function LurkerEditor({
  roomId, cmdId, initialTemplate, initialWaitSec, onSaved, onCommitEnabled, onRestoreEnabled,
}: {
  roomId: number | null
  cmdId: string
  initialTemplate: string
  initialWaitSec: number
  onSaved: (config: { template: string; wait_sec: number }) => void
  onCommitEnabled?: () => Promise<void>
  onRestoreEnabled?: () => void
}) {
  const [tpl, setTpl] = useState(initialTemplate || LURKER_DEFAULT_TEMPLATE)
  const [wait, setWait] = useState(String(initialWaitSec || 900))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function persist(template: string, w: number) {
    if (!roomId) return
    setSaving(true)
    try {
      if (onCommitEnabled) await onCommitEnabled()
      await saveCommandConfig(roomId, cmdId, { template, wait_sec: w })
      onSaved({ template, wait_sec: w })
      setSaved(true); setTimeout(() => setSaved(false), 1500)
    } finally { setSaving(false) }
  }

  const waitNum = Number(wait)
  const waitInvalid = wait !== '' && Number.isFinite(waitNum) && (waitNum < 300 || waitNum > 900)

  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <InputGroup size="sm" style={{ maxWidth: 260, width: '100%' }}>
        <InputGroup.Addon>等待</InputGroup.Addon>
        <Input
          type="number"
          value={wait}
          onChange={setWait}
          style={waitInvalid ? { textDecoration: 'line-through', color: '#ef5350' } : undefined}
          onBlur={() => {
            const n = Number(wait)
            if (!Number.isFinite(n) || wait === '') setWait('900')
            else if (n < 300) setWait('300')
            else if (n > 900) setWait('900')
          }}
        />
        <InputGroup.Addon>秒 (300–900)</InputGroup.Addon>
      </InputGroup>
      <div style={{ fontSize: 12, color: '#888' }}>
        占位符：<code>{'{name}'}</code> 用户昵称，<code>{'{streamer}'}</code> 主播昵称
      </div>
      <Input size="sm" value={tpl} onChange={setTpl} placeholder={LURKER_DEFAULT_TEMPLATE} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <Button
          appearance="subtle" size="sm" style={{ width: 88 }}
          onClick={() => { setTpl(LURKER_DEFAULT_TEMPLATE); setWait('900'); onRestoreEnabled?.() }}
        >恢复默认</Button>
        <Button
          appearance="primary" size="sm" style={{ width: 88 }}
          onClick={() => persist(tpl.trim() || LURKER_DEFAULT_TEMPLATE, Math.max(300, Math.min(900, Number(wait) || 900)))}
          disabled={saving}
        >
          {saving ? '保存中…' : saved ? '已保存' : '保存'}
        </Button>
      </div>
    </div>
  )
}
const WELCOME_DEFAULT_TEMPLATE = '欢迎{name}进入直播间'

// 感谢弹幕分组：礼物/大航海/盲盒/关注/点赞 共用同一个总开关和保存/恢复默认按钮。
// 总开关：任一子项开启即显示开启；关时一键全关，开时一键全开。
function ThanksGroup({
  roomId, master, gift, guard, blind, follow, like, share, superchat,
  onToggleDraft, onUpdateConfig, onCommitEnabled, onRestoreEnabled,
}: {
  roomId: number | null
  master: Command
  gift: Command
  guard: Command
  blind: Command
  follow: Command
  like: Command
  share: Command
  superchat: Command
  onToggleDraft: (cmdId: string) => void
  onUpdateConfig: (cmdId: string, config: Record<string, unknown>) => void
  onCommitEnabled: (cmdIds: string[]) => Promise<void>
  onRestoreEnabled?: () => void
}) {
  const initTpls = (cmd: Command, def: string): string[] => {
    const t = cmd.config?.templates as string[] | undefined
    if (t && t.length) return t
    const legacy = cmd.config?.template as string | undefined
    return [legacy || def]
  }
  const [giftTpls, setGiftTpls] = useState<string[]>(initTpls(gift, GIFT_DEFAULT_TEMPLATE))
  const [guardTpls, setGuardTpls] = useState<string[]>(initTpls(guard, GUARD_DEFAULT_TEMPLATE))
  const [blindTpls, setBlindTpls] = useState<string[]>(initTpls(blind, BLIND_DEFAULT_TEMPLATE))
  const [followTpls, setFollowTpls] = useState<string[]>(initTpls(follow, FOLLOW_DEFAULT_TEMPLATE))
  const [likeTpls, setLikeTpls] = useState<string[]>(initTpls(like, LIKE_DEFAULT_TEMPLATE))
  const [shareTpls, setShareTpls] = useState<string[]>(initTpls(share, SHARE_DEFAULT_TEMPLATE))
  const [superchatTpls, setSuperchatTpls] = useState<string[]>(initTpls(superchat, SUPERCHAT_DEFAULT_TEMPLATE))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const allIds = [
    'broadcast_thanks', 'broadcast_gift', 'broadcast_guard', 'broadcast_blind',
    'broadcast_follow', 'broadcast_like', 'broadcast_share', 'broadcast_superchat',
  ]

  async function saveAll() {
    if (!roomId) return
    const clean = (arr: string[], def: string) => {
      const c = arr.map((s) => s.trim()).filter(Boolean)
      return c.length ? c : [def]
    }
    const gi = clean(giftTpls, GIFT_DEFAULT_TEMPLATE)
    const g = clean(guardTpls, GUARD_DEFAULT_TEMPLATE)
    const b = clean(blindTpls, BLIND_DEFAULT_TEMPLATE)
    const f = clean(followTpls, FOLLOW_DEFAULT_TEMPLATE)
    const l = clean(likeTpls, LIKE_DEFAULT_TEMPLATE)
    const sh = clean(shareTpls, SHARE_DEFAULT_TEMPLATE)
    const sc = clean(superchatTpls, SUPERCHAT_DEFAULT_TEMPLATE)
    setSaving(true)
    try {
      await onCommitEnabled(allIds)
      await saveCommandConfig(roomId, 'broadcast_gift', { templates: gi })
      await saveCommandConfig(roomId, 'broadcast_guard', { templates: g })
      await saveCommandConfig(roomId, 'broadcast_blind', { templates: b })
      await saveCommandConfig(roomId, 'broadcast_follow', { templates: f })
      await saveCommandConfig(roomId, 'broadcast_like', { templates: l })
      await saveCommandConfig(roomId, 'broadcast_share', { templates: sh })
      await saveCommandConfig(roomId, 'broadcast_superchat', { templates: sc })
      onUpdateConfig('broadcast_gift', { templates: gi })
      onUpdateConfig('broadcast_guard', { templates: g })
      onUpdateConfig('broadcast_blind', { templates: b })
      onUpdateConfig('broadcast_follow', { templates: f })
      onUpdateConfig('broadcast_like', { templates: l })
      onUpdateConfig('broadcast_share', { templates: sh })
      onUpdateConfig('broadcast_superchat', { templates: sc })
      setGiftTpls(gi); setGuardTpls(g); setBlindTpls(b); setFollowTpls(f); setLikeTpls(l); setShareTpls(sh); setSuperchatTpls(sc)
      setSaved(true); setTimeout(() => setSaved(false), 1500)
    } finally { setSaving(false) }
  }

  function restoreDefaults() {
    setGiftTpls([GIFT_DEFAULT_TEMPLATE])
    setGuardTpls([GUARD_DEFAULT_TEMPLATE])
    setBlindTpls([BLIND_DEFAULT_TEMPLATE])
    setFollowTpls([FOLLOW_DEFAULT_TEMPLATE])
    setLikeTpls([LIKE_DEFAULT_TEMPLATE])
    setShareTpls([SHARE_DEFAULT_TEMPLATE])
    setSuperchatTpls([SUPERCHAT_DEFAULT_TEMPLATE])
    onRestoreEnabled?.()
  }

  const isMobile = useIsMobile()

  function section(
    cmd: Command,
    items: string[] | null,
    setItems: ((v: string[]) => void) | null,
    placeholder: string,
    placeholdersHint: React.ReactNode = null,
  ) {
    return (
      <div key={cmd.id} style={{ border: '1px solid #2a2a4a', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, background: '#14141f' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500 }}>
          <Toggle size="sm" checked={cmd.enabled} onChange={() => onToggleDraft(cmd.id)} />
          <span>{cmd.name}</span>
        </div>
        <div style={{ fontSize: 12, color: '#888' }}>
          {cmd.description}
          {placeholdersHint ? <div style={{ marginTop: 4 }}>{placeholdersHint}</div> : null}
        </div>
        {items && setItems ? (
          <>
            {items.map((m, idx) => (
              <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Input
                  size="sm" value={m}
                  onChange={(v) => setItems(items.map((s, i) => (i === idx ? v : s)))}
                  placeholder={placeholder} style={{ flex: 1 }}
                />
                <IconButton
                  appearance="subtle" size="sm"
                  icon={<CloseIcon />}
                  onClick={() => {
                    const next = items.filter((_, j) => j !== idx)
                    setItems(next.length ? next : [''])
                  }}
                  title="删除"
                />
              </div>
            ))}
            <Button
              appearance="subtle" size="sm" startIcon={<PlusIcon />}
              style={{ alignSelf: 'flex-start' }}
              onClick={() => setItems([...items, ''])}
            >添加一条</Button>
          </>
        ) : null}
      </div>
    )
  }

  return (
    <div className="cmd-item">
      <div className="cmd-info">
        <div className="cmd-name" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{master.name}</span>
          <Toggle size="sm" checked={master.enabled} onChange={() => onToggleDraft(master.id)} />
        </div>
        <div style={{
          marginTop: 6,
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)',
          gap: 8,
        }}>
          {section(
            follow, followTpls, setFollowTpls, FOLLOW_DEFAULT_TEMPLATE,
            <>占位符：<code>{'{name}'}</code> 用户昵称，<code>{'{streamer}'}</code> 主播昵称</>,
          )}
          {section(
            like, likeTpls, setLikeTpls, LIKE_DEFAULT_TEMPLATE,
            <>占位符：<code>{'{name}'}</code> 用户昵称，<code>{'{streamer}'}</code> 主播昵称</>,
          )}
          {section(
            share, shareTpls, setShareTpls, SHARE_DEFAULT_TEMPLATE,
            <>占位符：<code>{'{name}'}</code> 用户昵称，<code>{'{streamer}'}</code> 主播昵称</>,
          )}
          {section(
            gift, giftTpls, setGiftTpls, GIFT_DEFAULT_TEMPLATE,
            <>占位符：<code>{'{name}'}</code> 用户昵称，<code>{'{streamer}'}</code> 主播昵称，<code>{'{gift}'}</code> 礼物名，<code>{'{num}'}</code> 数量，<code>{'{gift_count}'}</code> 名字+数量（如 "爱心抱枕 x3"，数量为 1 时只显示名字）</>,
          )}
          {section(
            guard, guardTpls, setGuardTpls, GUARD_DEFAULT_TEMPLATE,
            <>占位符：<code>{'{name}'}</code> 用户昵称，<code>{'{streamer}'}</code> 主播昵称，<code>{'{content}'}</code> 开通/续费，<code>{'{num}'}</code> 月数，<code>{'{guard}'}</code> 舰长/提督/总督</>,
          )}
          {section(
            superchat, superchatTpls, setSuperchatTpls, SUPERCHAT_DEFAULT_TEMPLATE,
            <>占位符：<code>{'{name}'}</code> 用户昵称，<code>{'{streamer}'}</code> 主播昵称，<code>{'{price}'}</code> 电池数，<code>{'{content}'}</code> 留言内容</>,
          )}
          {section(
            blind, blindTpls, setBlindTpls, BLIND_DEFAULT_TEMPLATE,
            <>占位符：<code>{'{name}'}</code> 用户昵称，<code>{'{streamer}'}</code> 主播昵称，<code>{'{count}'}</code> 盲盒数，<code>{'{verdict}'}</code> 盈亏（如 "赚3元"/"亏5元"/"不亏不赚"）</>,
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
          <Button appearance="subtle" size="sm" style={{ width: 88 }}
            onClick={restoreDefaults}
          >恢复默认</Button>
          <Button appearance="primary" size="sm" style={{ width: 88 }}
            onClick={saveAll} disabled={saving}
          >{saving ? '保存中…' : saved ? '已保存' : '保存'}</Button>
        </div>
      </div>
    </div>
  )
}

// 每条一行的文本框 + 间隔输入；失焦/点击保存时提交。
function ScheduledDanmuEditor({
  roomId, cmdId, initialMessages, initialInterval, onSaved, onCommitEnabled, onRestoreEnabled,
}: {
  roomId: number | null
  cmdId: string
  initialMessages: string[]
  initialInterval: number
  onSaved: (config: { messages: string[]; interval_sec: number }) => void
  onCommitEnabled?: () => Promise<void>
  onRestoreEnabled?: () => void
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
      if (onCommitEnabled) await onCommitEnabled()
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
      <InputGroup size="sm" style={{ maxWidth: 260, width: '100%' }}>
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
          <IconButton
            appearance="subtle" size="sm"
            icon={<CloseIcon />}
            onClick={() => removeMsg(idx)}
            title="删除"
          />
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Button appearance="subtle" size="sm" startIcon={<PlusIcon />} onClick={addMsg}>添加一条</Button>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button
            appearance="subtle" size="sm"
            style={{ width: 88 }}
            onClick={() => {
              setMessages(['动动手指给{streamer}点点关注'])
              setInterval('300')
              onRestoreEnabled?.()
            }}
          >恢复默认</Button>
          <Button
            appearance="primary" size="sm"
            style={{ width: 88 }}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? '保存中…' : saved ? '已保存' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// 欢迎弹幕：MultiTemplateEditor + 粉丝牌门槛
interface WelcomeCfg {
  normal_enabled: boolean; normal_templates: string[]
  medal_enabled: boolean;  medal_templates: string[]
  guard_enabled: boolean;  guard_templates: string[]
}
const WELCOME_DEFAULTS: WelcomeCfg = {
  normal_enabled: true, normal_templates: [WELCOME_DEFAULT_TEMPLATE],
  medal_enabled: true,  medal_templates: ['欢迎{name}回家~'],
  guard_enabled: true,  guard_templates: ['{guard}{name}驾到！'],
}

function WelcomeEditor({
  roomId, cmdId, initial, onSaved, onCommitEnabled, onRestoreEnabled,
}: {
  roomId: number | null
  cmdId: string
  initial: WelcomeCfg
  onSaved: (config: WelcomeCfg) => void
  onCommitEnabled?: () => Promise<void>
  onRestoreEnabled?: () => void
}) {
  const [cfg, setCfg] = useState<WelcomeCfg>(initial)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const isMobile = useIsMobile()

  async function persist(next: WelcomeCfg) {
    if (!roomId) return
    setSaving(true)
    try {
      if (onCommitEnabled) await onCommitEnabled()
      await saveCommandConfig(roomId, cmdId, next as unknown as Record<string, unknown>)
      onSaved(next)
      setSaved(true); setTimeout(() => setSaved(false), 1500)
    } finally { setSaving(false) }
  }

  type Kind = 'normal' | 'medal' | 'guard'
  const labels: Record<Kind, string> = { normal: '普通欢迎', medal: '粉丝牌欢迎', guard: '大航海欢迎' }
  const enKey = (k: Kind) => `${k}_enabled` as keyof WelcomeCfg
  const tplKey = (k: Kind) => `${k}_templates` as keyof WelcomeCfg

  function section(k: Kind) {
    const enabled = cfg[enKey(k)] as boolean
    const items = (cfg[tplKey(k)] as string[]) || []
    const placeholder = WELCOME_DEFAULTS[tplKey(k)] as string[]
    return (
      <div key={k} style={{ border: '1px solid #2a2a4a', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, background: '#14141f' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500 }}>
          <Toggle
            size="sm"
            checked={enabled}
            onChange={(v) => setCfg({ ...cfg, [enKey(k)]: v })}
          />
          <span>{labels[k]}</span>
        </div>
        <div style={{ fontSize: 12, color: '#888' }}>
          占位符：<code>{'{name}'}</code> 用户昵称，<code>{'{streamer}'}</code> 主播昵称{k === 'guard' ? (<>，<code>{'{guard}'}</code> 舰长/提督/总督</>) : null}
        </div>
        {(items.length ? items : ['']).map((m, idx) => (
          <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Input
              size="sm" value={m}
              onChange={(v) => {
                const next = [...items]; next[idx] = v
                setCfg({ ...cfg, [tplKey(k)]: next })
              }}
              placeholder={placeholder[0]} style={{ flex: 1 }}
            />
            <IconButton
              appearance="subtle" size="sm"
              icon={<CloseIcon />}
              onClick={() => {
                const next = items.filter((_, j) => j !== idx)
                setCfg({ ...cfg, [tplKey(k)]: next.length ? next : [''] })
              }}
              title="删除"
            />
          </div>
        ))}
        <Button
          appearance="subtle" size="sm" startIcon={<PlusIcon />}
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setCfg({ ...cfg, [tplKey(k)]: [...items, ''] })}
        >添加一条</Button>
      </div>
    )
  }

  function cleanCfg(c: WelcomeCfg): WelcomeCfg {
    const clean = (arr: string[]) => arr.map((s) => s.trim()).filter(Boolean)
    return {
      ...c,
      normal_templates: clean(c.normal_templates).length ? clean(c.normal_templates) : WELCOME_DEFAULTS.normal_templates,
      medal_templates: clean(c.medal_templates).length ? clean(c.medal_templates) : WELCOME_DEFAULTS.medal_templates,
      guard_templates: clean(c.guard_templates).length ? clean(c.guard_templates) : WELCOME_DEFAULTS.guard_templates,
    }
  }

  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, color: '#888' }}>
        命中优先级：大航海 &gt; 粉丝牌 &gt; 普通
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)',
        gap: 8,
      }}>
        {(['normal', 'medal', 'guard'] as Kind[]).map(section)}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <Button
          appearance="subtle" size="sm" style={{ width: 88 }}
          onClick={() => { setCfg(WELCOME_DEFAULTS); onRestoreEnabled?.() }}
        >恢复默认</Button>
        <Button
          appearance="primary" size="sm" style={{ width: 88 }}
          onClick={() => persist(cleanCfg(cfg))}
          disabled={saving}
        >{saving ? '保存中…' : saved ? '已保存' : '保存'}</Button>
      </div>
    </div>
  )
}

function AiReplyEditor({
  roomId, cmdId, initial, onSaved, onCommitEnabled, onRestoreEnabled,
}: {
  roomId: number | null
  cmdId: string
  initial: { probability: number; bot_name: string; extra_prompt: string }
  onSaved: (config: { probability: number; bot_name: string; extra_prompt: string }) => void
  onCommitEnabled?: () => Promise<void>
  onRestoreEnabled?: () => void
}) {
  const [prob, setProb] = useState(String(initial.probability ?? 10))
  const [botName, setBotName] = useState(initial.bot_name || '')
  const [extraPrompt, setExtraPrompt] = useState(initial.extra_prompt || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const probNum = Number(prob)
  const probInvalid = prob !== '' && Number.isFinite(probNum) && (probNum < 0 || probNum > 50)

  async function persist() {
    if (!roomId) return
    const p = Math.max(0, Math.min(50, Math.round(Number(prob) || 0)))
    const payload = {
      probability: p,
      bot_name: botName.trim(),
      extra_prompt: extraPrompt.trim(),
    }
    setSaving(true)
    try {
      if (onCommitEnabled) await onCommitEnabled()
      await saveCommandConfig(roomId, cmdId, payload)
      onSaved(payload)
      setProb(String(p))
      setSaved(true); setTimeout(() => setSaved(false), 1500)
    } finally { setSaving(false) }
  }

  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <InputGroup size="sm" style={{ maxWidth: 260, width: '100%' }}>
        <InputGroup.Addon>回复概率</InputGroup.Addon>
        <Input
          type="number"
          value={prob}
          onChange={setProb}
          style={probInvalid ? { textDecoration: 'line-through', color: '#ef5350' } : undefined}
          onBlur={() => {
            const n = Number(prob)
            if (!Number.isFinite(n) || prob === '') setProb('10')
            else if (n < 0) setProb('0')
            else if (n > 50) setProb('50')
            else setProb(String(Math.round(n)))
          }}
        />
        <InputGroup.Addon>% (0–50)</InputGroup.Addon>
      </InputGroup>
      <InputGroup size="sm" style={{ maxWidth: 340, width: '100%' }}>
        <InputGroup.Addon>机器人名称</InputGroup.Addon>
        <Input
          value={botName}
          onChange={setBotName}
          placeholder="例如：小助手"
        />
      </InputGroup>
      <div style={{ fontSize: 12, color: '#888' }}>
        弹幕含机器人名称 → 必定回复；否则按概率随机回复；同一房间 15 秒内最多回复一次
      </div>
      <div style={{ fontSize: 12, color: '#888' }}>
        额外提示词（可选）：给机器人补充人设或口癖。占位符 <code>{'{streamer}'}</code> 替换为主播昵称。
      </div>
      <Input
        size="sm"
        as="textarea"
        rows={3}
        value={extraPrompt}
        onChange={setExtraPrompt}
        placeholder="例如：你特别喜欢吃辣条，回复时偶尔提一下；喜欢叫 {streamer} 为「老板」"
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <Button
          appearance="subtle" size="sm" style={{ width: 88 }}
          onClick={() => {
            setProb('10'); setBotName(''); setExtraPrompt('')
            onRestoreEnabled?.()
          }}
        >恢复默认</Button>
        <Button
          appearance="primary" size="sm" style={{ width: 88 }}
          onClick={persist}
          disabled={saving}
        >{saving ? '保存中…' : saved ? '已保存' : '保存'}</Button>
      </div>
    </div>
  )
}

export function ToolsPanel({ roomId, category }: Props) {
  const [commands, setCommands] = useState<Command[]>([])
  const [autoClip, setAutoClip] = useState(false)
  const [cheapGifts, setCheapGifts] = useState<CheapGift[]>([])

  const [committedEnabled, setCommittedEnabled] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!roomId) return
    fetchCommands(roomId).then((cmds) => {
      setCommands(cmds)
      setCommittedEnabled(Object.fromEntries(cmds.map((c) => [c.id, c.enabled])))
    }).catch(() => {})
    fetchAutoClip(roomId).then(setAutoClip).catch(() => {})
    fetchCheapGifts(roomId).then(setCheapGifts).catch(() => {})
  }, [roomId])

  // 若已保存的 auto_gift.gift_id 不在当前 cheapGifts 中（B站 同名同价多 id，
  // 漂移后旧 id 消失），尝试按 price 匹配回填并重存，避免 SelectPicker 显示为空。
  useEffect(() => {
    if (!roomId || cheapGifts.length === 0 || commands.length === 0) return
    const idx = commands.findIndex((c) => c.id === 'auto_gift')
    if (idx < 0) return
    const cfg = commands[idx].config || {}
    const savedId = Number(cfg.gift_id || 0)
    const savedName = String(cfg.gift_name || '')
    const savedPrice = Number(cfg.gift_price || 0)
    if (!savedId || cheapGifts.some((g) => g.gift_id === savedId)) return
    // 优先按名称匹配；老配置没存名字时回退到按价格匹配。
    const alt = (savedName && cheapGifts.find((g) => g.name === savedName))
      || cheapGifts.find((g) => g.price === savedPrice)
    if (!alt) return
    const num = Math.max(1, Math.ceil(1000 / alt.price))
    const next = { gift_id: alt.gift_id, gift_name: alt.name, gift_price: alt.price, gift_num: num }
    saveCommandConfig(roomId, 'auto_gift', next).then(() => {
      setCommands((prev) => prev.map((c, i) => (
        i === idx ? { ...c, config: { ...c.config, ...next } } : c
      )))
    }).catch(() => {})
  }, [roomId, cheapGifts, commands])

  // 草稿开关：本地翻转，等编辑器的 "保存" 按钮时一起提交。
  function toggleDraft(cmdId: string) {
    setCommands((prev) => prev.map((c) => (
      c.id === cmdId ? { ...c, enabled: !c.enabled } : c
    )))
  }

  // 即时开关：automation tab 下的指令，开关一切就直接落库。
  async function toggleImmediate(cmdId: string) {
    if (!roomId) return
    const cmd = commands.find((c) => c.id === cmdId)
    if (!cmd) return
    const next = !cmd.enabled
    setCommands((prev) => prev.map((c) => (c.id === cmdId ? { ...c, enabled: next } : c)))
    try {
      await toggleCommand(roomId, cmdId)
      setCommittedEnabled((prev) => ({ ...prev, [cmdId]: next }))
    } catch {
      setCommands((prev) => prev.map((c) => (c.id === cmdId ? { ...c, enabled: !next } : c)))
    }
  }

  // auto_gift dropdown onChange：直接存配置，顺带开启开关（如果之前是关的）。
  async function handleAutoGiftChangeImmediate(cmdIndex: number, giftId: number | null) {
    if (giftId == null || !roomId) return
    const g = cheapGifts.find((x) => x.gift_id === giftId)
    if (!g) return
    const num = Math.max(1, Math.ceil(1000 / g.price))
    const config = { gift_id: g.gift_id, gift_name: g.name, gift_price: g.price, gift_num: num }
    setCommands((prev) => prev.map((c, i) => (
      i === cmdIndex ? { ...c, config: { ...c.config, ...config } } : c
    )))
    try {
      await saveCommandConfig(roomId, 'auto_gift', config)
    } catch { /* ignore */ }
  }

  // auto_clip 即时开关
  async function toggleAutoClipImmediate(next: boolean) {
    if (!roomId) return
    setAutoClip(next)
    try {
      await toggleAutoClip(roomId, next)
    } catch {
      setAutoClip(!next)
    }
  }

  // 重置草稿开关到指定值（"恢复默认" 用）
  function setDraftEnabled(cmdIds: string[], value: boolean) {
    setCommands((prev) => prev.map((c) => (
      cmdIds.includes(c.id) ? { ...c, enabled: value } : c
    )))
  }

  // 对给定 cmdIds，若 draft enabled 与 committed 不同，下发 toggle。
  async function commitEnabled(cmdIds: string[]) {
    if (!roomId) return
    const diffs: Array<{ id: string; desired: boolean }> = []
    for (const id of cmdIds) {
      const cmd = commands.find((c) => c.id === id)
      if (!cmd) continue
      if (cmd.enabled !== committedEnabled[id]) {
        diffs.push({ id, desired: cmd.enabled })
      }
    }
    for (const d of diffs) await toggleCommand(roomId, d.id)
    if (diffs.length) {
      setCommittedEnabled((prev) => {
        const next = { ...prev }
        for (const d of diffs) next[d.id] = d.desired
        return next
      })
    }
  }

  const allowedIds = category === 'reactive' ? REACTIVE_IDS : AUTOMATION_IDS
  const title = category === 'reactive' ? '互动回复' : '指令 & 功能'

  return (
    <div>
      <div className="panel-title">{title}</div>
      <div className="tools-panel-body">
      {commands.map((cmd, i) => {
        if (cmd.id === 'nickname_commands') return null
        if (['broadcast_gift', 'broadcast_guard', 'broadcast_blind', 'broadcast_follow', 'broadcast_like', 'broadcast_share', 'broadcast_superchat'].includes(cmd.id)) return null
        if (!allowedIds.has(cmd.id)) return null
        if (cmd.id === 'broadcast_thanks') {
          const gift = commands.find((c) => c.id === 'broadcast_gift')
          const guard = commands.find((c) => c.id === 'broadcast_guard')
          const blind = commands.find((c) => c.id === 'broadcast_blind')
          const follow = commands.find((c) => c.id === 'broadcast_follow')
          const like = commands.find((c) => c.id === 'broadcast_like')
          const share = commands.find((c) => c.id === 'broadcast_share')
          const superchat = commands.find((c) => c.id === 'broadcast_superchat')
          if (!gift || !guard || !blind || !follow || !like || !share || !superchat) return null
          return (
            <ThanksGroup
              key="thanks_group"
              roomId={roomId}
              master={cmd}
              gift={gift}
              guard={guard}
              blind={blind}
              follow={follow}
              like={like}
              share={share}
              superchat={superchat}
              onToggleDraft={toggleDraft}
              onCommitEnabled={commitEnabled}
              onRestoreEnabled={() => setDraftEnabled(['broadcast_thanks', 'broadcast_gift', 'broadcast_guard', 'broadcast_blind', 'broadcast_follow', 'broadcast_like', 'broadcast_share', 'broadcast_superchat'], true)}
              onUpdateConfig={(cid, config) => {
                setCommands((prev) => prev.map((c) => (
                  c.id === cid ? { ...c, config: { ...c.config, ...config } } : c
                )))
              }}
            />
          )
        }
        return (
        <div key={cmd.id} className="cmd-item">
          <div className="cmd-info">
            <div className="cmd-name" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{cmd.name}</span>
              <Toggle
                checked={cmd.enabled}
                onChange={() => (category === 'automation' ? toggleImmediate(cmd.id) : toggleDraft(cmd.id))}
                size="sm"
              />
            </div>
            <div className="cmd-desc">{cmd.description}</div>
            {cmd.id === 'lurker_mention' && (
              <LurkerEditor
                roomId={roomId}
                cmdId={cmd.id}
                initialTemplate={(cmd.config?.template as string) || ''}
                initialWaitSec={Number(cmd.config?.wait_sec || 900)}
                onCommitEnabled={() => commitEnabled([cmd.id])}
                onRestoreEnabled={() => setDraftEnabled([cmd.id], true)}
                onSaved={(config) => {
                  setCommands((prev) => prev.map((c) => (
                    c.id === cmd.id ? { ...c, config: { ...c.config, ...config } } : c
                  )))
                }}
              />
            )}
            {cmd.id === 'broadcast_welcome' && (
              <WelcomeEditor
                roomId={roomId}
                cmdId={cmd.id}
                initial={{
                  normal_enabled: cmd.config?.normal_enabled !== undefined
                    ? Boolean(cmd.config?.normal_enabled)
                    : WELCOME_DEFAULTS.normal_enabled,
                  normal_templates:
                    (cmd.config?.normal_templates as string[])
                    || (cmd.config?.templates as string[])  // 旧 config 迁移
                    || WELCOME_DEFAULTS.normal_templates,
                  medal_enabled: Boolean(cmd.config?.medal_enabled),
                  medal_templates:
                    (cmd.config?.medal_templates as string[])
                    || WELCOME_DEFAULTS.medal_templates,
                  guard_enabled: Boolean(cmd.config?.guard_enabled),
                  guard_templates:
                    (cmd.config?.guard_templates as string[])
                    || WELCOME_DEFAULTS.guard_templates,
                }}
                onCommitEnabled={() => commitEnabled([cmd.id])}
                onRestoreEnabled={() => setDraftEnabled([cmd.id], true)}
                onSaved={(config) => {
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
                onCommitEnabled={() => commitEnabled([cmd.id])}
                onRestoreEnabled={() => setDraftEnabled([cmd.id], true)}
                onSaved={(config: { messages: string[]; interval_sec: number }) => {
                  setCommands((prev) => prev.map((c) => (
                    c.id === cmd.id ? { ...c, config: { ...c.config, ...config } } : c
                  )))
                }}
              />
            )}
            {cmd.id === 'ai_reply' && (
              <AiReplyEditor
                roomId={roomId}
                cmdId={cmd.id}
                initial={{
                  probability: Number(cmd.config?.probability ?? 10),
                  bot_name: (cmd.config?.bot_name as string) || '',
                  extra_prompt: (cmd.config?.extra_prompt as string) || '',
                }}
                onCommitEnabled={() => commitEnabled([cmd.id])}
                onRestoreEnabled={() => setDraftEnabled([cmd.id], true)}
                onSaved={(config) => {
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
                  onChange={(v) => handleAutoGiftChangeImmediate(i, v as number | null)}
                  placeholder="选择礼物"
                  style={{ maxWidth: 260, width: '100%' }}
                />
              </div>
            )}
          </div>
        </div>
        )
      })}
      {category === 'automation' && (
        <>
      <div className="cmd-section-title">实验功能</div>
      <div className="cmd-item">
        <div className="cmd-info">
          <div className="cmd-name" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>礼物自动剪辑</span>
            <Toggle checked={autoClip} onChange={toggleAutoClipImmediate} size="sm" />
            <span style={{ color: '#ef5350', fontWeight: 'normal' }}>
              非实际录屏！！仅模拟合成！！
            </span>
          </div>
          <div className="cmd-desc">直播时收到单价 ≥<span style={{ color: '#ef5350' }}>¥1000</span> 礼物时自动录制前后片段，可在礼物和大航海列表下载</div>
          <div className="cmd-desc">录制片段仅保留 24 小时</div>
        </div>
      </div>
        </>
      )}
    </div>
    </div>
  )
}

// 便捷命名导出：避免每个调用点都记得传 category。
export function ReactiveToolsPanel(props: { roomId: number | null }) {
  return <ToolsPanel {...props} category="reactive" />
}
export function AutomationToolsPanel(props: { roomId: number | null }) {
  return <ToolsPanel {...props} category="automation" />
}
