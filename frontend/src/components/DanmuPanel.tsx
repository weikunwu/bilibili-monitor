import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckPicker, DateRangePicker, Pagination } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'

import type { LiveEvent } from '../types'
import { fetchEventsByType } from '../api/client'
import { fmtDateTime, localToUTC } from '../lib/formatters'
import { PREDEFINED_RANGES } from '../lib/dateRanges'
import { EventItem } from './EventItem'
import { useIsMobile } from '../hooks/useIsMobile'

interface Props {
  roomId: number
}

function thisMonthRange(): DateRange {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0)
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
  return [start, end]
}

/** 弹幕历史：本月默认窗口，按用户筛 + 分页查看。 */
export function DanmuPanel({ roomId }: Props) {
  const isMobile = useIsMobile()
  const [dateRange, setDateRange] = useState<DateRange>(thisMonthRange())
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!dateRange) return
    fetchEventsByType(roomId, 'danmu', {
      timeFrom: localToUTC(fmtDateTime(dateRange[0])),
      timeTo: localToUTC(fmtDateTime(dateRange[1])),
    }).then(setEvents)
  }, [roomId, dateRange])

  useEffect(() => { setPage(1) }, [selectedUsers.length, events.length])

  const userOptions = useMemo(() => {
    const names = new Set(events.map((ev) => ev.user_name).filter(Boolean) as string[])
    return Array.from(names).map((n) => ({ label: n, value: n }))
  }, [events])

  const filtered = selectedUsers.length > 0
    ? events.filter((ev) => selectedUsers.includes(ev.user_name || ''))
    : events
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize)

  return (
    <div>
      <div className="panel-title">弹幕历史</div>
      <div className="event-filter">
        <CheckPicker
          data={userOptions}
          value={selectedUsers}
          onChange={setSelectedUsers}
          placeholder="筛选用户"
          size="sm"
          searchable
          countable
          block={isMobile}
          style={isMobile ? undefined : { width: 200 }}
        />
        {!isMobile && <span style={{ flex: 1 }} />}
        <DateRangePicker
          format="yyyy-MM-dd HH:mm:ss"
          character=" ~ "
          placeholder="选择时间范围"
          size="sm"
          appearance="subtle"
          ranges={PREDEFINED_RANGES}
          value={dateRange}
          onChange={(range) => { if (range) setDateRange(range) }}
          placement="bottomEnd"
          block={isMobile}
          style={isMobile ? undefined : { width: 340 }}
        />
      </div>
      <div className="events-container" ref={containerRef}>
        {filtered.length === 0 ? (
          <div className="empty">暂无弹幕数据</div>
        ) : (
          paged.map((ev, i) => (
            <EventItem key={`${ev.timestamp}-${(page - 1) * pageSize + i}`} event={ev} showDate />
          ))
        )}
      </div>
      {filtered.length > 0 && (
        <div className="gift-table-footer">
          <span>共 {filtered.length} 条</span>
          <Pagination
            size="xs" prev next ellipsis boundaryLinks maxButtons={5}
            total={filtered.length} limit={pageSize} activePage={page}
            onChangePage={setPage}
            onChangeLimit={(v) => { setPageSize(v); setPage(1) }}
            limitOptions={[50, 100, 200]}
            layout={['limit', '|', 'pager']}
            locale={{ limit: '{0} 条/页' }}
          />
        </div>
      )}
    </div>
  )
}
