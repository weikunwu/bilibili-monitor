import { useState, useMemo } from 'react'
import { CheckPicker, DateRangePicker, Table, Pagination } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'

import type { LiveEvent } from '../types'
import { formatTime, formatBattery, fixUrl, fmtDateTime } from '../lib/formatters'
import { EVENT_SUPERCHAT } from '../lib/constants'
import { PREDEFINED_RANGES } from '../lib/dateRanges'
import { useIsMobile } from '../hooks/useIsMobile'

const { Column, HeaderCell, Cell } = Table

interface Props {
  events: LiveEvent[]
  dateRange: DateRange
  onQueryRange: (from: string, to: string, range: DateRange) => void
}

export function SuperChatPanel({ events, dateRange, onQueryRange }: Props) {
  const isMobile = useIsMobile()
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const scEvents = useMemo(() =>
    events.filter((ev) => ev.event_type === EVENT_SUPERCHAT),
    [events])

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

      {filtered.length === 0 ? (
        <div className="empty">暂无SC数据</div>
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
                    <span className="time">{formatTime(rowData.timestamp)}</span>
                  )}
                </Cell>
              </Column>
            )}

            <Column flexGrow={2}>
              <HeaderCell>用户</HeaderCell>
              <Cell>
                {(rowData: LiveEvent) => (
                  <div className="gift-user-cell">
                    {!isMobile && rowData.extra?.avatar && <img className="gift-user-avatar" src={fixUrl(rowData.extra.avatar)} alt="" />}
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
