import { useEffect, useRef } from 'react'
import { Checkbox, DateRangePicker } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'

import type { LiveEvent, TabType } from '../types'
import { EventItem } from './EventItem'
import { TAB_ALL, EVENT_DANMAKU } from '../lib/constants'

interface Props {
  events: LiveEvent[]
  activeTab: TabType
  autoScroll: boolean
  defaultRange: DateRange | null
  showAutoScroll?: boolean
  onAutoScrollChange: (v: boolean) => void
  onQueryRange: (from: string, to: string) => void
  onGenerateGiftImage: (userName: string) => Promise<void> | void
  onGenerateBlindBoxImage?: (userName: string) => Promise<void> | void
  onShowCardPreview?: (title: string, imgUrl: string) => void
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

function fmtDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const predefinedRanges = [
  {
    label: '今日',
    value: () => {
      const now = new Date()
      return [new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0), new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)] as DateRange
    },
  },
  {
    label: '昨日',
    value: () => {
      const now = new Date()
      return [new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0), new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59)] as DateRange
    },
  },
  {
    label: '本周',
    value: () => {
      const now = new Date()
      const day = now.getDay() || 7
      return [new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1, 0, 0, 0), new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)] as DateRange
    },
  },
  {
    label: '本月',
    value: () => {
      const now = new Date()
      return [new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0), new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)] as DateRange
    },
  },
]

export function EventList({
  events, activeTab, autoScroll, defaultRange, showAutoScroll = true,
  onAutoScrollChange, onQueryRange,
  onGenerateGiftImage, onGenerateBlindBoxImage,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  const filtered = events.filter((ev) => {
    if (activeTab !== TAB_ALL && ev.event_type !== activeTab) return false
    return true
  })

  useEffect(() => {
    if (autoScroll && (activeTab === TAB_ALL || activeTab === EVENT_DANMAKU) && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [filtered.length, autoScroll])

  return (
    <>
      <div className="event-filter">
        {showAutoScroll && (
          <Checkbox
            checked={autoScroll}
            onChange={(_, checked) => onAutoScrollChange(checked)}
          >
            自动滚动
          </Checkbox>
        )}
        <DateRangePicker
          format="yyyy-MM-dd HH:mm:ss"
          character=" ~ "
          placeholder="选择时间范围"
          size="sm"
          appearance="subtle"
          ranges={predefinedRanges}
          defaultValue={defaultRange}
          onChange={(range) => {
            if (!range) return
            onQueryRange(fmtDate(range[0]), fmtDate(range[1]))
          }}
          placement="bottomEnd"
          style={{ width: 340 }}
        />
      </div>
      <div className="events-container" ref={containerRef}>
        {filtered.length === 0 ? (
          <div className="empty">等待接收消息...</div>
        ) : (
          filtered.map((ev, i) => {
            const key = `${ev.timestamp}-${i}`
            const dateStr = getDateStr(ev.timestamp)
            const prevDateStr = i > 0 ? getDateStr(filtered[i - 1].timestamp) : ''
            const showDateSep = dateStr !== prevDateStr
            return (
              <div key={key}>
                {showDateSep && (
                  <div className="date-separator">
                    <span>{formatDateLabel(dateStr)}</span>
                  </div>
                )}
                <EventItem
                  event={ev}
                  onGenerateGiftImage={onGenerateGiftImage}
                  onGenerateBlindBoxImage={onGenerateBlindBoxImage}
                />
              </div>
            )
          })
        )}
      </div>
    </>
  )
}
