import { useState, useMemo, useEffect, useCallback } from 'react'
import { CheckPicker, DateRangePicker, Checkbox, Table, Pagination } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'

import type { LiveEvent, GiftUser } from '../types'
import { formatTime, formatCoin, fixUrl } from '../lib/formatters'
import { GenerateImageButton } from './GenerateImageButton'
import { EVENT_GIFT } from '../lib/constants'
import { generateGiftCard } from '../lib/giftCard'

const { Column, HeaderCell, Cell } = Table

interface Props {
  events: LiveEvent[]
  dateRange: DateRange
  onQueryRange: (from: string, to: string, range: DateRange) => void
  onGenerateGiftImage: (userName: string) => Promise<void> | void
  onGenerateBlindBoxImage?: (userName: string) => Promise<void> | void
  onShowCardPreview?: (title: string, imgUrl: string) => void
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
  events, dateRange, onQueryRange,
  onGenerateGiftImage, onGenerateBlindBoxImage, onShowCardPreview,
}: Props) {
  const isMobile = useIsMobile()
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

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
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize)

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

  const handleGenerateCard = useCallback(async () => {
    const checked = filtered.filter((ev) => checkedKeys.has(ev._key))
    if (checked.length === 0) return
    // aggregate checked events by user
    const map: Record<string, GiftUser> = {}
    for (const ev of checked) {
      const key = ev.user_name || ''
      const extra = ev.extra || {}
      if (!map[key]) {
        map[key] = {
          user_name: key, avatar: extra.avatar || '',
          gifts: {}, gift_imgs: {}, gift_actions: {}, gift_coins: {}, gift_ids: {},
          guard_level: 0, total_coin: 0,
        }
      }
      const u = map[key]
      if (!u.avatar && extra.avatar) u.avatar = extra.avatar
      const name = extra.gift_name || ev.content || ''
      const num = extra.num || 1
      const coin = extra.total_coin || 0
      u.gifts[name] = (u.gifts[name] || 0) + num
      u.gift_coins[name] = (u.gift_coins[name] || 0) + coin
      u.total_coin += coin
      if (extra.gift_img && !u.gift_imgs[name]) u.gift_imgs[name] = extra.gift_img
      if (extra.action && !u.gift_actions[name]) u.gift_actions[name] = extra.action
      if (extra.gift_id && !u.gift_ids[name]) u.gift_ids[name] = extra.gift_id
    }
    // sort gifts within each user by tier: gold > pink > purple > blue
    function tierOrder(coin: number): number {
      const yuan = coin / 1000
      if (yuan >= 1000) return 0
      if (yuan >= 500) return 1
      if (yuan >= 100) return 2
      return 3
    }
    for (const u of Object.values(map)) {
      const sorted = Object.keys(u.gifts).sort((a, b) => {
        const ta = tierOrder(u.gift_coins[a] || 0)
        const tb = tierOrder(u.gift_coins[b] || 0)
        return ta !== tb ? ta - tb : (u.gift_coins[b] || 0) - (u.gift_coins[a] || 0)
      })
      const g: Record<string, number> = {}
      const c: Record<string, number> = {}
      for (const n of sorted) { g[n] = u.gifts[n]; c[n] = u.gift_coins[n] }
      u.gifts = g
      u.gift_coins = c
    }
    const users = Object.values(map).sort((a, b) => b.total_coin - a.total_coin)
    try { await document.fonts.load('italic 800 30px "Baloo 2"') } catch { /* ok */ }
    const canvases: HTMLCanvasElement[] = []
    for (const u of users) {
      const c = document.createElement('canvas')
      await generateGiftCard(c, u)
      canvases.push(c)
    }
    const mergeGap = 0
    const totalHeight = canvases.reduce((h, c) => h + c.height, 0) + (canvases.length - 1) * mergeGap
    const maxWidth = Math.max(...canvases.map((c) => c.width))
    const merged = document.createElement('canvas')
    merged.width = maxWidth
    merged.height = totalHeight
    const ctx = merged.getContext('2d')!
    let y = 0
    for (const c of canvases) { ctx.drawImage(c, 0, y); y += c.height + mergeGap }
    const url = merged.toDataURL('image/png')
    const names = users.map((u) => u.user_name)
    onShowCardPreview?.(`${names.join(', ')} - 礼物截图`, url)
  }, [filtered, checkedKeys])

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
        {checkedKeys.size > 0 && (
          <GenerateImageButton size="sm" appearance="primary" onClick={handleGenerateCard}>
            生成礼物截图 ({checkedKeys.size})
          </GenerateImageButton>
        )}
        <span style={{ flex: 1 }} />
        <DateRangePicker
          format="yyyy-MM-dd HH:mm:ss"
          character=" ~ "
          placeholder="选择时间范围"
          size="sm"
          appearance="subtle"
          ranges={predefinedRanges}
          value={dateRange}
          onChange={(range) => {
            if (!range) return
            onQueryRange(fmtDate(range[0]), fmtDate(range[1]), range)
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
            data={paged}
            autoHeight
            rowKey="_key"
            rowClassName={(rowData) => checkedKeys.has(rowData?._key) ? 'gift-row-checked' : ''}
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
            <span>共 {filtered.length} 条，合计: <span className="gift-total">{formatCoin(totalGold, 'gold')}</span></span>
            <Pagination
              size="xs"
              prev
              next
              total={filtered.length}
              limit={pageSize}
              activePage={page}
              onChangePage={setPage}
              onChangeLimit={(v) => { setPageSize(v); setPage(1) }}
              limitOptions={[20, 50, 100]}
              layout={['limit', '|', 'pager']}
            />
          </div>
        </div>
      )}
    </div>
  )
}
