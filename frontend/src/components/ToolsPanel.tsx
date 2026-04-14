import { useState, useEffect } from 'react'
import { Toggle } from 'rsuite'
import type { Command } from '../types'
import { fetchCommands, toggleCommand, fetchAutoClip, toggleAutoClip } from '../api/client'

interface Props {
  roomId: number | null
}

export function ToolsPanel({ roomId }: Props) {
  const [commands, setCommands] = useState<Command[]>([])
  const [autoClip, setAutoClip] = useState(false)

  useEffect(() => {
    if (!roomId) return
    fetchCommands(roomId).then(setCommands).catch(() => {})
    fetchAutoClip(roomId).then(setAutoClip).catch(() => {})
  }, [roomId])

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
          <div className="cmd-desc">直播时收到 ≥<span style={{ color: '#ef5350' }}>¥1000</span> 礼物时自动录制前后片段，可在礼物和大航海列表下载</div>
          <div className="cmd-desc">录制片段仅保留 24 小时</div>
        </div>
        <Toggle checked={autoClip} onChange={handleAutoClipToggle} size="sm" />
      </div>
    </div>
    </div>
  )
}
