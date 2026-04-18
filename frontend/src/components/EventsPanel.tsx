import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckPicker, DateRangePicker, Pagination, Nav } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'

import type { LiveEvent, GiftGifItem, EventsKind } from '../types'
import { fetchEventsByType } from '../api/client'
import { fmtDateTime, localToUTC } from '../lib/formatters'
import { PREDEFINED_RANGES } from '../lib/dateRanges'
import { GiftPanel } from './GiftPanel'
import { GuardPanel } from './GuardPanel'
import { SuperChatPanel } from './SuperChatPanel'
import { EventItem } from './EventItem'
import type { SuperChatImageOptions } from './SuperChatPanel'
import { useIsMobile } from '../hooks/useIsMobile'

interface Props {
  roomId: number
  onGenerateGiftImage: (userName: string) => Promise<void> | void
  onGenerateBlindBoxImage?: (userName: string) => Promise<void> | void
  onShowCardPreview?: (imgUrl: string, ext?: 'png' | 'gif') => void
  onGenerateGiftGif?: (items: GiftGifItem[]) => Promise<void> | void
  onGenerateSuperChatImage?: (event: LiveEvent, options: SuperChatImageOptions) => void
}

const CHIPS: { kind: EventsKind; label: string }[] = [
  { kind: 'gift', label: '礼物' },
  { kind: 'guard', label: '大航海' },
  { kind: 'superchat', label: '醒目留言' },
  { kind: 'danmu', label: '弹幕' },
]

function thisMonthRange(): DateRange {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0)
  // 月末 = 下月 1 号减 1 毫秒
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
  return [start, end]
}

/**
 * 合并 弹幕/礼物/大航海/SC 的历史查询页。顶部 chip 切换类型，内层直接复用
 * 原有 GiftPanel/GuardPanel/SuperChatPanel。每个子 panel 自带筛选/分页/
 * DateRangePicker，挂载一次后保留在 DOM 里（display:none），切回时状态还在。
 */
export function EventsPanel({
  roomId, onGenerateGiftImage, onGenerateBlindBoxImage,
  onShowCardPreview, onGenerateGiftGif, onGenerateSuperChatImage,
}: Props) {
  const [kind, setKind] = useState<EventsKind>('gift')
  // 事件查询和直播流用的是不同时间范围：直播流默认今天（RoomPage 管），
  // 查询页默认本月（这里自己管，避免两边互相污染）。
  const [dateRange, setDateRange] = useState<DateRange>(thisMonthRange())
  const onQueryRange = (_from: string, _to: string, range: DateRange) => setDateRange(range)
  // 首次切到某个 kind 才挂载对应 panel，避免启动时并发拉 4 种历史数据。
  const [mounted, setMounted] = useState<Record<EventsKind, boolean>>({
    gift: true, guard: false, superchat: false, danmu: false,
  })

  const selectChip = (k: EventsKind) => {
    setKind(k)
    setMounted((m) => m[k] ? m : { ...m, [k]: true })
  }

  return (
    <div>
      <div className="panel-title">事件查询</div>
      <Nav
        appearance="subtle"
        activeKey={kind}
        onSelect={(key) => key && selectChip(key as EventsKind)}
        className="events-nav"
      >
        {CHIPS.map((c) => (
          <Nav.Item key={c.kind} eventKey={c.kind}>{c.label}</Nav.Item>
        ))}
      </Nav>

      <div style={{ display: kind === 'danmu' ? 'block' : 'none' }}>
        {mounted.danmu && (
          <DanmuHistoryPanel
            roomId={roomId}
            dateRange={dateRange}
            onQueryRange={onQueryRange}
          />
        )}
      </div>
      <div style={{ display: kind === 'gift' ? 'block' : 'none' }}>
        {mounted.gift && (
          <GiftPanel
            roomId={roomId}
            dateRange={dateRange}
            onQueryRange={onQueryRange}
            onGenerateGiftImage={onGenerateGiftImage}
            onGenerateBlindBoxImage={onGenerateBlindBoxImage}
            onShowCardPreview={onShowCardPreview}
            onGenerateGiftGif={onGenerateGiftGif}
          />
        )}
      </div>
      <div style={{ display: kind === 'guard' ? 'block' : 'none' }}>
        {mounted.guard && (
          <GuardPanel
            roomId={roomId}
            dateRange={dateRange}
            onQueryRange={onQueryRange}
            onShowCardPreview={onShowCardPreview}
            onGenerateGiftGif={onGenerateGiftGif}
          />
        )}
      </div>
      <div style={{ display: kind === 'superchat' ? 'block' : 'none' }}>
        {mounted.superchat && (
          <SuperChatPanel
            roomId={roomId}
            dateRange={dateRange}
            onQueryRange={onQueryRange}
            onGenerateSuperChatImage={onGenerateSuperChatImage}
          />
        )}
      </div>
    </div>
  )
}

/** 弹幕历史：和 Gift/Guard/SC 结构相同的筛选+分页列表，但用现成的 EventItem 渲染。 */
function DanmuHistoryPanel({
  roomId, dateRange, onQueryRange,
}: {
  roomId: number
  dateRange: DateRange
  onQueryRange: (from: string, to: string, range: DateRange) => void
}) {
  const isMobile = useIsMobile()
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
    <>
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
          onChange={(range) => {
            if (!range) return
            onQueryRange(fmtDateTime(range[0]), fmtDateTime(range[1]), range)
          }}
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
    </>
  )
}
