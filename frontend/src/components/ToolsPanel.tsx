import { useState, useEffect } from 'react'
import { Toggle } from 'rsuite'
import type { Command } from '../types'
import { fetchCommands, toggleCommand } from '../api/client'

interface Props {
  roomId: number | null
}

export function ToolsPanel({ roomId }: Props) {
  const [commands, setCommands] = useState<Command[]>([])

  useEffect(() => {
    if (!roomId) return
    fetchCommands(roomId).then(setCommands).catch(() => {})
  }, [roomId])

  async function handleToggle(cmdId: string, index: number) {
    if (!roomId) return
    await toggleCommand(roomId, cmdId)
    setCommands((prev) =>
      prev.map((c, i) => (i === index ? { ...c, enabled: !c.enabled } : c)),
    )
  }

  return (
    <div style={{ padding: '16px 24px' }}>
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
    </div>
  )
}
