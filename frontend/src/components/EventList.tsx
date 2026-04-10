import { useEffect, useRef } from 'react'
import type { LiveEvent, TabType } from '../types'
import { EventItem } from './EventItem'

interface Props {
  events: LiveEvent[]
  activeTab: TabType
  showEnter: boolean
  showLike: boolean
  autoScroll: boolean
  onGenerateGiftImage: (userName: string) => void
}

function shouldShow(ev: LiveEvent, activeTab: TabType, showEnter: boolean, showLike: boolean): boolean {
  if (activeTab !== 'all' && ev.event_type !== activeTab) return false
  if (ev.event_type === 'enter' && !showEnter) return false
  if (ev.event_type === 'like' && !showLike) return false
  return true
}

export function EventList({
  events, activeTab, showEnter, showLike, autoScroll,
  onGenerateGiftImage,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  const filtered = events.filter((ev) => shouldShow(ev, activeTab, showEnter, showLike))

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [filtered.length, autoScroll])

  return (
    <div className="events-container" ref={containerRef}>
      {filtered.length === 0 ? (
        <div className="empty">等待接收消息...</div>
      ) : (
        filtered.map((ev, i) => (
          <EventItem
            key={`${ev.timestamp}-${i}`}
            event={ev}
            onGenerateGiftImage={onGenerateGiftImage}
          />
        ))
      )}
    </div>
  )
}
