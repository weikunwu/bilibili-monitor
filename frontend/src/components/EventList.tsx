import { useState, useEffect, useRef, useMemo } from 'react'
import { Checkbox, CheckPicker, DateRangePicker, Toggle } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'

import type { LiveEvent, TabType } from '../types'
import { EventItem } from './EventItem'
import { PREDEFINED_RANGES } from '../lib/dateRanges'
import { fmtDateTime } from '../lib/formatters'

interface Props {
  events: LiveEvent[]
  /** 保留参数是为了以后再加子类型过滤时不破坏调用方。当前 EventList 固定展示 TAB_LIVE 全类型。 */
  activeTab?: TabType
  autoScroll: boolean
  dateRange: DateRange
  showAutoScroll?: boolean
  saveDanmu?: boolean
  onToggleSaveDanmu?: (v: boolean) => void
  onAutoScrollChange: (v: boolean) => void
  onQueryRange: (from: string, to: string, range: DateRange) => void
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
  events, autoScroll, dateRange, showAutoScroll = true,
  saveDanmu, onToggleSaveDanmu, onAutoScrollChange, onQueryRange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])

  const userOptions = useMemo(() => {
    const names = new Set(events.map((ev) => ev.user_name).filter(Boolean) as string[])
    return Array.from(names).map((n) => ({ label: n, value: n }))
  }, [events])

  const filtered = selectedUsers.length > 0
    ? events.filter((ev) => selectedUsers.includes(ev.user_name || ''))
    : events

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [filtered.length, autoScroll])

  return (
    <>
      <div className="panel-title">直播流</div>
      <div className="event-filter">
        {onToggleSaveDanmu && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            记录弹幕 <Toggle size="sm" checked={saveDanmu} onChange={onToggleSaveDanmu} />
          </label>
        )}
        {showAutoScroll && (
          <Checkbox
            checked={autoScroll}
            onChange={(_, checked) => onAutoScrollChange(checked)}
          >
            自动滚动
          </Checkbox>
        )}
        {userOptions.length > 0 && (
          <CheckPicker
            data={userOptions}
            value={selectedUsers}
            onChange={setSelectedUsers}
            placeholder="筛选用户"
            size="sm"
            searchable
            countable
            w={200}
          />
        )}
        <span style={{ flex: 1 }} />
        <DateRangePicker
          format="yyyy-MM-dd HH:mm:ss"
          character=" ~ "
          placeholder="选择时间范围"
          size="sm"
          appearance="subtle"
          ranges={PREDEFINED_RANGES}
          value={dateRange}
          onChange={(range) => {
            if (!range) return
            onQueryRange(fmtDateTime(range[0]), fmtDateTime(range[1]), range)
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
                <EventItem event={ev} />
              </div>
            )
          })
        )}
      </div>
    </>
  )
}
