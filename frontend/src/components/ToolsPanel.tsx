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
          <div className="cmd-name">礼物自动剪辑</div>
          <div className="cmd-desc">直播中，收到 ≥¥1000 礼物时自动录制前后片段</div>
        </div>
        <Toggle checked={autoClip} onChange={handleAutoClipToggle} size="sm" />
      </div>
    </div>
    </div>
  )
}
