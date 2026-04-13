import { type ReactNode, memo, useState } from 'react'
import { Tag, Checkbox, Button } from 'rsuite'
import type { LiveEvent } from '../types'
import { formatTime, formatBattery, fixUrl } from '../lib/formatters'
import { BADGE_NAMES, EVENT_GIFT, EVENT_SUPERCHAT, EVENT_GUARD } from '../lib/constants'
import { matchClip, clipComposeUrl } from '../api/client'

// ≥ 1000 电池 (¥1000) — matches the server-side CLIP_GIFT_THRESHOLD.
const CLIP_MIN_COIN = 10000

function isClippable(ev: LiveEvent): boolean {
  const extra = ev.extra || {}
  const coin = extra.total_coin ?? (extra.price || 0) * (extra.num || 1)
  if (ev.event_type === EVENT_GIFT) return coin >= CLIP_MIN_COIN
  if (ev.event_type === EVENT_GUARD) return coin >= CLIP_MIN_COIN
  return false
}

function ClipDownloadButton({ ev }: { ev: LiveEvent }) {
  const [busy, setBusy] = useState(false)
  const [missing, setMissing] = useState(false)
  async function handleClick() {
    if (!ev.room_id || !ev.user_name || !ev.timestamp) return
    setBusy(true)
    setMissing(false)
    try {
      const m = await matchClip(ev.room_id, ev.user_name, ev.timestamp)
      if (!m) { setMissing(true); return }
      window.open(clipComposeUrl(ev.room_id, m.name), '_blank')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size="xs" appearance="ghost" loading={busy} onClick={handleClick}
      style={{ marginLeft: 6 }}>
      {missing ? '无录屏' : '录屏'}
    </Button>
  )
}

interface Props {
  event: LiveEvent
  checked?: boolean
  onCheck?: () => void
}

const TAG_COLORS: Record<string, 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'violet' | 'cyan'> = {
  danmu: 'blue',
  gift: 'orange',
  superchat: 'yellow',
  guard: 'violet',
  info: 'cyan',
}

function renderContent(ev: LiveEvent): ReactNode {
  const extra = ev.extra || {}
  const emoticon = extra.emoticon
  const emots = extra.emots

  if (emoticon?.url) {
    return (
      <img
        className="emoticon"
        referrerPolicy="no-referrer"
        src={fixUrl(emoticon.url)}
        alt={ev.content || ''}
        title={ev.content || ''}
      />
    )
  }

  if (emots && Object.keys(emots).length > 0) {
    const text = ev.content || ''
    const parts: ReactNode[] = []
    let key = 0

    const emotKeys = Object.keys(emots).sort((a, b) => b.length - a.length)
    const regex = new RegExp(`(${emotKeys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`)
    const segments = text.split(regex)

    for (const seg of segments) {
      if (emots[seg]) {
        parts.push(
          <img
            key={key++}
            className="emoticon-inline"
            referrerPolicy="no-referrer"
            src={fixUrl(emots[seg].url)}
            alt={seg}
            title={seg}
          />,
        )
      } else if (seg) {
        parts.push(<span key={key++}>{seg}</span>)
      }
    }
    return <>{parts}</>
  }

  return <>{ev.content || ''}</>
}

export const EventItem = memo(function EventItem({ event: ev, checked, onCheck }: Props) {
  const extra = ev.extra || {}
  const face = extra.avatar || ''

  let priceTag: ReactNode = null
  if (ev.event_type === EVENT_GIFT && extra.total_coin) {
    priceTag = <span className="price-tag">{formatBattery(extra.total_coin)}</span>
  } else if (ev.event_type === EVENT_SUPERCHAT && extra.price) {
    priceTag = <span className="price-tag">¥{(extra.price / 10).toFixed(1).replace(/\.0$/, '')}</span>
  } else if (ev.event_type === EVENT_GUARD && extra.guard_name) {
    const num = extra.num || 1
    priceTag = (
      <>
        <span className="price-tag">{extra.guard_name}</span>
        {` x${num}`}
        {extra.price ? <span className="price-tag">{formatBattery(extra.price * num)}</span> : null}
      </>
    )
  }

  return (
    <div className={`event ${ev.event_type}`}>
      {onCheck !== undefined && (
        <Checkbox checked={checked} onChange={onCheck} className="event-checkbox" />
      )}
      <span className="time">{formatTime(ev.timestamp)}</span>
      <Tag size="sm" color={TAG_COLORS[ev.event_type]}>
        {BADGE_NAMES[ev.event_type] || ev.event_type}
      </Tag>
      {face && (
        <img className="avatar" referrerPolicy="no-referrer" src={face} alt="" />
      )}
      {ev.user_name && <span className="user">{ev.user_name}</span>}
      <span className="content">
        {ev.event_type === EVENT_GIFT && extra.action && (
          <span className="gift-action">{extra.action}</span>
        )}
        {renderContent(ev)}
        {priceTag}
        {isClippable(ev) && <ClipDownloadButton ev={ev} />}
      </span>
    </div>
  )
})
