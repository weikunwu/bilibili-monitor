import { useState, useMemo, useEffect } from 'react'
import { CheckPicker, DateRangePicker, Table, Pagination, Checkbox } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'

import type { LiveEvent } from '../types'
import { fetchEventsByType } from '../api/client'
import { formatShortDateTime, formatBattery, fixUrl, fmtDateTime, localToUTC } from '../lib/formatters'
import { PREDEFINED_RANGES } from '../lib/dateRanges'
import { useIsMobile } from '../hooks/useIsMobile'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { GenerateImageButton } from './GenerateImageButton'
import { EventCard } from './EventCard'

const { Column, HeaderCell, Cell } = Table

export interface SuperChatImageOptions {
  showPrice: boolean
}

interface Props {
  roomId: number
  dateRange: DateRange
  onQueryRange: (from: string, to: string, range: DateRange) => void
  onGenerateSuperChatImage?: (event: LiveEvent, options: SuperChatImageOptions) => void
}

export function SuperChatPanel({ roomId, dateRange, onQueryRange, onGenerateSuperChatImage }: Props) {
  const isMobile = useIsMobile()
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [scEvents, setScEvents] = useState<LiveEvent[]>([])
  const [showPrice, setShowPrice] = useLocalStorage('sc:showPrice', true)

  useEffect(() => {
    if (!dateRange) return
    fetchEventsByType(roomId, 'superchat', {
      timeFrom: localToUTC(fmtDateTime(dateRange[0])),
      timeTo: localToUTC(fmtDateTime(dateRange[1])),
    }).then(setScEvents)
  }, [roomId, dateRange])

  useMemo(() => { setPage(1) }, [scEvents.length])

  const userOptions = useMemo(() => {
    const names = new Set(scEvents.map((ev) => ev.user_name || ''))
    return Array.from(names).filter(Boolean).map((n) => ({ label: n, value: n }))
  }, [scEvents])

  const indexed = useMemo(() =>
    scEvents.map((ev, i) => ({ ...ev, _key: `${ev.timestamp}-${i}` })),
    [scEvents])

  const filtered = selectedUsers.length > 0
    ? indexed.filter((ev) => selectedUsers.includes(ev.user_name || ''))
    : indexed

  const totalPrice = filtered.reduce((s, ev) => s + (ev.extra?.price || 0), 0)
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize)

  return (
    <div className="gift-panel">
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
        <Checkbox checked={showPrice} onChange={(_, c) => setShowPrice(c)}>
          截图显示电池数
        </Checkbox>
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

      {filtered.length === 0 ? (
        <div className="empty">暂无SC数据</div>
      ) : isMobile ? (
        <div className="gift-table-wrap">
          <div className="event-cards">
            {paged.map((ev) => {
              const extra = ev.extra || {}
              return (
                <EventCard
                  key={ev._key}
                  avatarUrl={extra.avatar}
                  userName={ev.user_name || ''}
                  timestamp={formatShortDateTime(ev.timestamp)}
                  value={extra.price ? formatBattery(extra.price) : null}
                  mainContent={<span style={{ color: '#ccc' }}>{ev.content}</span>}
                  actions={onGenerateSuperChatImage ? (
                    <GenerateImageButton size="sm" onClick={() => onGenerateSuperChatImage(ev, { showPrice })}>
                      截图
                    </GenerateImageButton>
                  ) : null}
                />
              )
            })}
          </div>

          <div className="gift-table-footer">
            <span>共 {filtered.length} 条，合计: <span className="gift-total">{formatBattery(totalPrice)}</span></span>
            <Pagination
              size="xs"
              prev
              next
              ellipsis
              boundaryLinks
              maxButtons={1}
              total={filtered.length}
              limit={pageSize}
              activePage={page}
              onChangePage={setPage}
              onChangeLimit={(v) => { setPageSize(v); setPage(1) }}
              limitOptions={[20, 50, 100]}
              layout={['limit', '|', 'pager']}
              locale={{ limit: '{0} 条/页' }}
            />
          </div>
        </div>
      ) : (
        <div className="gift-table-wrap">
          <Table
            data={paged}
            autoHeight
            rowKey="_key"
          >
            {!isMobile && (
              <Column flexGrow={1}>
                <HeaderCell>时间</HeaderCell>
                <Cell>
                  {(rowData: LiveEvent) => (
                    <span className="time">{formatShortDateTime(rowData.timestamp)}</span>
                  )}
                </Cell>
              </Column>
            )}

            <Column flexGrow={2}>
              <HeaderCell>用户</HeaderCell>
              <Cell>
                {(rowData: LiveEvent) => (
                  <div className="gift-user-cell">
                    {!isMobile && rowData.extra?.avatar && <img className="gift-user-avatar" src={fixUrl(rowData.extra.avatar)} referrerPolicy="no-referrer" alt="" />}
                    <span className="gift-user-name">{rowData.user_name}</span>
                  </div>
                )}
              </Cell>
            </Column>

            <Column flexGrow={3}>
              <HeaderCell>内容</HeaderCell>
              <Cell>
                {(rowData: LiveEvent) => (
                  <span style={{ color: '#ccc' }}>{rowData.content}</span>
                )}
              </Cell>
            </Column>

            <Column flexGrow={1} align="right">
              <HeaderCell>价值</HeaderCell>
              <Cell>
                {(rowData: LiveEvent) => (
                  rowData.extra?.price
                    ? <span className="gift-total">{formatBattery(rowData.extra.price)}</span>
                    : null
                )}
              </Cell>
            </Column>

            {onGenerateSuperChatImage && (
              <Column flexGrow={1}>
                <HeaderCell>操作</HeaderCell>
                <Cell>
                  {(rowData: LiveEvent) => (
                    <div className="gift-actions">
                      <GenerateImageButton size="sm" onClick={() => onGenerateSuperChatImage(rowData, { showPrice })}>
                        截图
                      </GenerateImageButton>
                    </div>
                  )}
                </Cell>
              </Column>
            )}
          </Table>

          <div className="gift-table-footer">
            <span>共 {filtered.length} 条，合计: <span className="gift-total">{formatBattery(totalPrice)}</span></span>
            <Pagination
              size="xs"
              prev
              next
              ellipsis
              boundaryLinks
              maxButtons={isMobile ? 1 : 5}
              total={filtered.length}
              limit={pageSize}
              activePage={page}
              onChangePage={setPage}
              onChangeLimit={(v) => { setPageSize(v); setPage(1) }}
              limitOptions={[20, 50, 100]}
              layout={['limit', '|', 'pager']}
              locale={{ limit: '{0} 条/页' }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
