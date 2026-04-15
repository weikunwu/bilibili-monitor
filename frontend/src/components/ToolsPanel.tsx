import { useState, useEffect } from 'react'
import { Toggle, SelectPicker } from 'rsuite'
import type { Command } from '../types'
import {
  fetchCommands, toggleCommand, fetchAutoClip, toggleAutoClip,
  fetchCheapGifts, saveCommandConfig, type CheapGift,
} from '../api/client'

interface Props {
  roomId: number | null
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
      {commands.map((cmd, i) => (
        <div key={cmd.id} className="cmd-item">
          <div className="cmd-info">
            <div className="cmd-name">{cmd.name}</div>
            <div className="cmd-desc">{cmd.description}</div>
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
          <Toggle
            checked={cmd.enabled}
            onChange={() => handleToggle(cmd.id, i)}
            size="sm"
          />
        </div>
      ))}
      <div className="cmd-section-title">实验功能</div>
      <div className="cmd-item">
        <div className="cmd-info">
          <div className="cmd-name">
            礼物自动剪辑
            <span style={{ color: '#ef5350', marginLeft: 8, fontWeight: 'normal' }}>
              非实际录屏！！仅模拟合成！！
            </span>
          </div>
          <div className="cmd-desc">直播时收到单价 ≥<span style={{ color: '#ef5350' }}>¥1000</span> 礼物时自动录制前后片段，可在礼物和大航海列表下载</div>
          <div className="cmd-desc">录制片段仅保留 24 小时</div>
        </div>
        <Toggle checked={autoClip} onChange={handleAutoClipToggle} size="sm" />
      </div>
    </div>
    </div>
  )
}
