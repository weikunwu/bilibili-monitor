import { type ReactNode, memo } from 'react'
import type { LiveEvent } from '../types'
import { formatTime, formatCoin, fixUrl } from '../lib/formatters'
import { BADGE_NAMES } from '../lib/constants'

interface Props {
  event: LiveEvent
  onGenerateGiftImage: (userName: string) => void
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
    let remaining = text
    let key = 0

    // Sort emot keys by their position in text (longest first for greedy match)
    const emotKeys = Object.keys(emots).sort((a, b) => b.length - a.length)

    // Simple split approach
    const regex = new RegExp(`(${emotKeys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`)
    const segments = remaining.split(regex)

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

export const EventItem = memo(function EventItem({ event: ev, onGenerateGiftImage }: Props) {
  const extra = ev.extra || {}
  const face = extra.face || ''

  let priceTag: ReactNode = null
  if (ev.event_type === 'gift' && extra.total_coin) {
    priceTag = <span className="price-tag">{formatCoin(extra.total_coin, extra.coin_type)}</span>
  } else if (ev.event_type === 'superchat' && extra.price) {
    priceTag = <span className="price-tag">¥{extra.price}</span>
  } else if (ev.event_type === 'guard' && extra.guard_name) {
    priceTag = <span className="price-tag">{extra.guard_name}</span>
  }

  return (
    <div className={`event ${ev.event_type}`}>
      <span className="time">{formatTime(ev.timestamp)}</span>
      <span className={`badge ${ev.event_type}`}>
        {BADGE_NAMES[ev.event_type] || ev.event_type}
      </span>
      {face && (
        <img className="avatar" referrerPolicy="no-referrer" src={face} alt="" />
      )}
      {ev.user_name && <span className="user">{ev.user_name}</span>}
      <span className="content">
        {renderContent(ev)}
        {priceTag}
      </span>
      {ev.event_type === 'gift' && ev.user_name && (
        <div className="gift-btns">
          <span className="gen-img-btn" onClick={() => onGenerateGiftImage(ev.user_name!)}>
            今日礼物
          </span>
        </div>
      )}
    </div>
  )
})
