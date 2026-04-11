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

function getDateStr(ts: string): string {
  if (!ts) return ''
  const d = new Date(ts + 'Z')
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatDateLabel(dateStr: string): string {
  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`
  if (dateStr === todayStr) return `今天 ${dateStr}`
  if (dateStr === yesterdayStr) return `昨天 ${dateStr}`
  return dateStr
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
        filtered.map((ev, i) => {
          const dateStr = getDateStr(ev.timestamp)
          const prevDateStr = i > 0 ? getDateStr(filtered[i - 1].timestamp) : ''
          const showDateSep = dateStr !== prevDateStr
          return (
            <div key={`${ev.timestamp}-${i}`}>
              {showDateSep && (
                <div className="date-separator">
                  <span>{formatDateLabel(dateStr)}</span>
                </div>
              )}
              <EventItem
                event={ev}
                onGenerateGiftImage={onGenerateGiftImage}
              />
            </div>
          )
        })
      )}
    </div>
  )
}
