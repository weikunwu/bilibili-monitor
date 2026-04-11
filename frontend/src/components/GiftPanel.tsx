import { useState, useMemo, useEffect, useCallback } from 'react'
import { CheckPicker, DateRangePicker, Checkbox, Table } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'

import type { LiveEvent } from '../types'
import { formatTime, formatCoin, fixUrl } from '../lib/formatters'
import { GenerateImageButton } from './GenerateImageButton'
import { EVENT_GIFT } from '../lib/constants'

const { Column, HeaderCell, Cell } = Table

interface Props {
  events: LiveEvent[]
  defaultRange: DateRange | null
  onQueryRange: (from: string, to: string) => void
  onGenerateGiftImage: (userName: string) => Promise<void> | void
  onGenerateBlindBoxImage?: (userName: string) => Promise<void> | void
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

function useIsMobile(breakpoint = 768) {
  const [mobile, setMobile] = useState(() => window.innerWidth <= breakpoint)
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [breakpoint])
  return mobile
}

export function GiftPanel({
  events, defaultRange, onQueryRange,
  onGenerateGiftImage, onGenerateBlindBoxImage,
}: Props) {
  const isMobile = useIsMobile()
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set())

  const giftEvents = useMemo(() =>
    events.filter((ev) => ev.event_type === EVENT_GIFT),
    [events])

  const userOptions = useMemo(() => {
    const names = new Set(giftEvents.map((ev) => ev.user_name || ''))
    return Array.from(names).filter(Boolean).map((n) => ({ label: n, value: n }))
  }, [giftEvents])

  const indexed = useMemo(() =>
    giftEvents.map((ev, i) => ({ ...ev, _key: `${ev.timestamp}-${i}` })),
    [giftEvents])

  const filtered = selectedUsers.length > 0
    ? indexed.filter((ev) => selectedUsers.includes(ev.user_name || ''))
    : indexed

  const totalGold = filtered.reduce((s, ev) => s + (ev.extra?.total_coin || 0), 0)

  const toggleKey = useCallback((key: string) => {
    setCheckedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    setCheckedKeys((prev) =>
      prev.size === filtered.length ? new Set() : new Set(filtered.map((ev) => ev._key))
    )
  }, [filtered])

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

      {filtered.length === 0 ? (
        <div className="empty">暂无礼物数据</div>
      ) : (
        <div className="gift-table-wrap">
          <Table
            data={filtered}
            autoHeight
            rowKey="_key"
            rowClassName={(rowData) => checkedKeys.has(rowData?._key) ? 'gift-row-checked' : ''}
            onRowClick={(rowData) => toggleKey(rowData._key)}
          >
            <Column width={50} align="center">
              <HeaderCell>
                <Checkbox
                  checked={checkedKeys.size > 0 && checkedKeys.size === filtered.length}
                  indeterminate={checkedKeys.size > 0 && checkedKeys.size < filtered.length}
                  onChange={toggleAll}
                />
              </HeaderCell>
              <Cell>
                {(rowData: LiveEvent & { _key: string }) => (
                  <Checkbox
                    checked={checkedKeys.has(rowData._key)}
                    onChange={() => toggleKey(rowData._key)}
                  />
                )}
              </Cell>
            </Column>

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

            <Column flexGrow={2}>
              <HeaderCell>礼物</HeaderCell>
              <Cell>
                {(rowData: LiveEvent) => {
                  const extra = rowData.extra || {}
                  return (
                    <span className="gift-item">
                      {extra.gift_img && <img className="gift-item-img" src={fixUrl(extra.gift_img)} alt="" />}
                      {extra.gift_name || rowData.content} x{extra.num || 1}
                      {isMobile && extra.total_coin ? (
                        <span className="gift-item-coin">{formatCoin(extra.total_coin, extra.coin_type)}</span>
                      ) : null}
                    </span>
                  )
                }}
              </Cell>
            </Column>

            {!isMobile && (
              <Column flexGrow={1} align="right">
                <HeaderCell>价值</HeaderCell>
                <Cell>
                  {(rowData: LiveEvent) => (
                    rowData.extra?.total_coin
                      ? <span className="gift-total">{formatCoin(rowData.extra.total_coin, rowData.extra.coin_type)}</span>
                      : null
                  )}
                </Cell>
              </Column>
            )}

            {!isMobile && (
              <Column flexGrow={3}>
                <HeaderCell>操作</HeaderCell>
                <Cell>
                  {(rowData: LiveEvent) => rowData.user_name ? (
                    <div className="gift-actions">
                      <GenerateImageButton size="sm" onClick={() => onGenerateGiftImage(rowData.user_name!)}>
                        今日礼物
                      </GenerateImageButton>
                      {onGenerateBlindBoxImage && (
                        <GenerateImageButton size="sm" onClick={() => onGenerateBlindBoxImage(rowData.user_name!)}>
                          今日盲盒
                        </GenerateImageButton>
                      )}
                    </div>
                  ) : null}
                </Cell>
              </Column>
            )}
          </Table>

          <div className="gift-table-footer">
            共 {filtered.length} 条，合计: <span className="gift-total">{formatCoin(totalGold, 'gold')}</span>
          </div>
        </div>
      )}
    </div>
  )
}
