import type { ReactNode } from 'react'
import { Checkbox } from 'rsuite'
import { fixUrl } from '../lib/formatters'

interface Props {
  checked?: boolean
  onCheckChange?: () => void
  avatarUrl?: string
  userName: string
  timestamp?: string
  mainContent: ReactNode
  value?: ReactNode
  actions?: ReactNode
}

export function EventCard({
  checked, onCheckChange, avatarUrl, userName, timestamp,
  mainContent, value, actions,
}: Props) {
  return (
    <div className={`event-card${checked ? ' event-card-checked' : ''}`}>
      <div className="event-card-head">
        {onCheckChange != null && (
          <Checkbox checked={checked} onChange={onCheckChange} />
        )}
        {avatarUrl && <img className="event-card-avatar" src={fixUrl(avatarUrl)} referrerPolicy="no-referrer" alt="" />}
        <div className="event-card-user">
          <div className="event-card-name">{userName}</div>
          {timestamp && <div className="event-card-time">{timestamp}</div>}
        </div>
        {value != null && <div className="event-card-value">{value}</div>}
      </div>
      {mainContent != null && <div className="event-card-main">{mainContent}</div>}
      {actions != null && <div className="event-card-actions">{actions}</div>}
    </div>
  )
}
