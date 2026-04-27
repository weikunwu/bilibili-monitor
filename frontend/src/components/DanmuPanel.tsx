import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckPicker, DateRangePicker, Pagination } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'

import type { LiveEvent } from '../types'
import { fetchEventsPage, fetchEventUsers } from '../api/client'
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

/** 弹幕历史：本月默认窗口，按用户筛 + 分页查看。
 * 真后端分页 —— 高流量房间一晚上几万条弹幕也只在浏览器留当前页。 */
export function DanmuPanel({ roomId }: Props) {
  const isMobile = useIsMobile()
  const [dateRange, setDateRange] = useState<DateRange>(thisMonthRange())
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [total, setTotal] = useState(0)
  const [userOptions, setUserOptions] = useState<{ label: string; value: string }[]>([])
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const containerRef = useRef<HTMLDivElement>(null)

  const timeFrom = useMemo(
    () => dateRange ? localToUTC(fmtDateTime(dateRange[0])) : '',
    [dateRange],
  )
  const timeTo = useMemo(
    () => dateRange ? localToUTC(fmtDateTime(dateRange[1])) : '',
    [dateRange],
  )

  // 任一筛选维度变了 → 回第一页（用户/时间窗各自独立，互不清空）
  useEffect(() => { setPage(1) }, [roomId, timeFrom, timeTo, selectedUsers])

  // 用户筛选下拉：按时间窗一次性拉全（用户数远小于事件数）
  useEffect(() => {
    if (!timeFrom || !timeTo) return
    fetchEventUsers(roomId, 'danmu', { timeFrom, timeTo }).then((users) => {
      setUserOptions(users.map((u) => ({ label: `${u.name} (${u.count})`, value: u.name })))
    })
  }, [roomId, timeFrom, timeTo])

  // 当前页：分页参数或筛选变了才重拉。立刻清空旧结果，避免翻页时先闪
  // 一下上一页内容；cancelled 防止快速连点时旧响应盖掉新响应。
  useEffect(() => {
    if (!timeFrom || !timeTo) return
    let cancelled = false
    setEvents([])
    fetchEventsPage(roomId, 'danmu', {
      timeFrom, timeTo,
      userNames: selectedUsers.length > 0 ? selectedUsers : undefined,
      offset: (page - 1) * pageSize,
      limit: pageSize,
    }).then(({ events, total }) => {
      if (cancelled) return
      setEvents(events)
      setTotal(total)
    })
    return () => { cancelled = true }
  }, [roomId, timeFrom, timeTo, selectedUsers, page, pageSize])

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
        {total === 0 ? (
          <div className="empty">暂无弹幕数据</div>
        ) : (
          events.map((ev, i) => (
            <EventItem key={`${ev.timestamp}-${(page - 1) * pageSize + i}`} event={ev} showDate />
          ))
        )}
      </div>
      {total > 0 && (
        <div className="gift-table-footer">
          <span>共 {total} 条</span>
          <Pagination
            size="xs" prev next ellipsis boundaryLinks maxButtons={5}
            total={total} limit={pageSize} activePage={page}
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
