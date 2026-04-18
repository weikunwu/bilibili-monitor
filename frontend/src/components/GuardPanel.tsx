import { useState, useMemo, useCallback, useEffect } from 'react'
import { CheckPicker, DateRangePicker, Checkbox, Table, Pagination } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'

import type { LiveEvent, GiftUser, GiftGifItem } from '../types'
import { fetchEventsByType } from '../api/client'
import { formatShortDateTime, formatBattery, fixUrl, fmtDateTime, localToUTC } from '../lib/formatters'
import { GenerateImageButton } from './GenerateImageButton'
import { ClipDownloadButton, isClippable } from './ClipDownloadButton'
import { EventCard } from './EventCard'
import { PREDEFINED_RANGES } from '../lib/dateRanges'
import { generateGiftCard } from '../lib/giftCard'
import { stackCanvasesVertically } from '../lib/canvasUtils'
import { useIsMobile } from '../hooks/useIsMobile'
import { toast } from '../lib/toast'

const { Column, HeaderCell, Cell } = Table

const GUARD_NAMES: Record<number, string> = { 1: '总督', 2: '提督', 3: '舰长' }

interface Props {
  roomId: number
  dateRange: DateRange
  onQueryRange: (from: string, to: string, range: DateRange) => void
  onShowCardPreview?: (imgUrl: string) => void
  onGenerateGiftGif?: (items: GiftGifItem[]) => Promise<void> | void
}

export function GuardPanel({
  roomId, dateRange, onQueryRange, onShowCardPreview, onGenerateGiftGif,
}: Props) {
  const isMobile = useIsMobile()
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [guardEvents, setGuardEvents] = useState<LiveEvent[]>([])

  useEffect(() => {
    if (!dateRange) return
    fetchEventsByType(roomId, 'guard', {
      timeFrom: localToUTC(fmtDateTime(dateRange[0])),
      timeTo: localToUTC(fmtDateTime(dateRange[1])),
    }).then(setGuardEvents)
  }, [roomId, dateRange])

  const userOptions = useMemo(() => {
    const names = new Set(guardEvents.map((ev) => ev.user_name || ''))
    return Array.from(names).filter(Boolean).map((n) => ({ label: n, value: n }))
  }, [guardEvents])

  const indexed = useMemo(() =>
    guardEvents.map((ev, i) => ({ ...ev, _key: `${ev.timestamp}-${i}` })),
    [guardEvents])

  const filtered = selectedUsers.length > 0
    ? indexed.filter((ev) => selectedUsers.includes(ev.user_name || ''))
    : indexed

  const totalPrice = filtered.reduce((s, ev) => s + (ev.extra?.price || 0), 0)
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
      if (extra.guard_level && extra.guard_level > u.guard_level) u.guard_level = extra.guard_level
      const name = extra.guard_name || ev.content || ''
      const num = extra.num || 1
      const coin = extra.price || 0
      u.gifts[name] = (u.gifts[name] || 0) + num
      u.total_coin += coin
      if (!u.gift_actions[name]) u.gift_actions[name] = '开通'
      if (extra.gift_img && !u.gift_imgs[name]) u.gift_imgs[name] = extra.gift_img
      // card color by guard level only: 总督=gold, 提督=purple, 舰长=blue
      const level = extra.guard_level || 3
      u.gift_coins[name] = level === 1 ? 10000 : level === 2 ? 1000 : 0
    }
    const users = Object.values(map).sort((a, b) => b.total_coin - a.total_coin)
    try { await document.fonts.load('italic 800 30px "Baloo 2"') } catch { /* ok */ }
    const canvases: HTMLCanvasElement[] = []
    for (const u of users) {
      const c = document.createElement('canvas')
      await generateGiftCard(c, u)
      canvases.push(c)
    }
    onShowCardPreview?.(stackCanvasesVertically(canvases).toDataURL('image/png'))
  }, [filtered, checkedKeys])

  const handleGenerateUserCard = useCallback(async (userName: string) => {
    const userEvents = guardEvents.filter((ev) => ev.user_name === userName)
    if (userEvents.length === 0) return
    const u: GiftUser = {
      user_name: userName, avatar: '',
      gifts: {}, gift_imgs: {}, gift_actions: {}, gift_coins: {}, gift_ids: {},
      guard_level: 0, total_coin: 0,
    }
    for (const ev of userEvents) {
      const extra = ev.extra || {}
      if (!u.avatar && extra.avatar) u.avatar = extra.avatar
      if (extra.guard_level && extra.guard_level > u.guard_level) u.guard_level = extra.guard_level
      const name = extra.guard_name || ev.content || ''
      const num = extra.num || 1
      const coin = extra.price || 0
      u.gifts[name] = (u.gifts[name] || 0) + num
      u.total_coin += coin
      if (!u.gift_actions[name]) u.gift_actions[name] = '开通'
      if (extra.gift_img && !u.gift_imgs[name]) u.gift_imgs[name] = extra.gift_img
      const level = extra.guard_level || 3
      u.gift_coins[name] = level === 1 ? 10000 : level === 2 ? 1000 : 0
    }
    try { await document.fonts.load('italic 800 30px "Baloo 2"') } catch { /* ok */ }
    const c = document.createElement('canvas')
    await generateGiftCard(c, u)
    onShowCardPreview?.(c.toDataURL('image/png'))
  }, [guardEvents])

  const buildGifUserFromEvent = (rowData: LiveEvent): { u: GiftUser; giftName: string } | null => {
    const extra = rowData.extra || {}
    if (!extra.gift_gif) return null
    const level = extra.guard_level || 3
    const name = GUARD_NAMES[level] || extra.guard_name || '舰长'
    const num = extra.num || 1
    const coin = extra.price || 0
    const u: GiftUser = {
      user_name: rowData.user_name || '',
      avatar: extra.avatar || '',
      gifts: { [name]: num },
      gift_imgs: extra.gift_img ? { [name]: extra.gift_img } : {},
      gift_actions: { [name]: '开通' },
      gift_coins: { [name]: level === 1 ? 10000 : level === 2 ? 1000 : 0 },
      gift_ids: {},
      gift_gifs: { [name]: extra.gift_gif },
      guard_level: level,
      total_coin: coin,
    }
    return { u, giftName: name }
  }

  const handleGenerateRowGif = useCallback((rowData: LiveEvent) => {
    const item = buildGifUserFromEvent(rowData)
    if (!item) return
    return onGenerateGiftGif?.([item])
  }, [onGenerateGiftGif])

  const handleGenerateGif = useCallback(async () => {
    const items: GiftGifItem[] = []
    for (const ev of filtered) {
      if (!checkedKeys.has(ev._key)) continue
      const item = buildGifUserFromEvent(ev)
      if (item) items.push(item)
    }
    if (items.length === 0) { toast('所选大航海均无动态图', 'warning'); return }
    if (items.length > 10) { toast('动态截图一次最多生成 10 个，请减少选择', 'warning'); return }
    await onGenerateGiftGif?.(items)
  }, [filtered, checkedKeys, onGenerateGiftGif])

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
        {checkedKeys.size > 0 && (
          <>
            <GenerateImageButton size="sm" appearance="primary" onClick={handleGenerateCard}>
              生成大航海截图 ({checkedKeys.size})
            </GenerateImageButton>
            {onGenerateGiftGif && (
              <GenerateImageButton size="sm" appearance="primary" onClick={handleGenerateGif}>
                生成动态截图 ({checkedKeys.size})
              </GenerateImageButton>
            )}
          </>
        )}
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
        <div className="empty">暂无大航海数据</div>
      ) : isMobile ? (
        <div className="gift-table-wrap">
          <div className="event-cards-header">
            <Checkbox
              checked={checkedKeys.size > 0 && checkedKeys.size === filtered.length}
              indeterminate={checkedKeys.size > 0 && checkedKeys.size < filtered.length}
              onChange={toggleAll}
            >
              全选
            </Checkbox>
          </div>
          <div className="event-cards">
            {paged.map((ev) => {
              const extra = ev.extra || {}
              const level = extra.guard_level || 3
              const name = GUARD_NAMES[level] || extra.guard_name || '舰长'
              const num = extra.num || 1
              return (
                <EventCard
                  key={ev._key}
                  checked={checkedKeys.has(ev._key)}
                  onCheckChange={() => toggleKey(ev._key)}
                  avatarUrl={extra.avatar}
                  userName={ev.user_name || ''}
                  timestamp={formatShortDateTime(ev.timestamp)}
                  value={extra.price ? `¥${(extra.price / 10).toFixed(1).replace(/\.0$/, '')}` : null}
                  mainContent={
                    <span className="gift-item">
                      {extra.gift_img && <img className="gift-item-img" src={fixUrl(extra.gift_img)} alt="" />}
                      {name} x{num}
                      {extra.price ? (
                        <span className="gift-item-coin">{formatBattery(extra.price * num)}</span>
                      ) : null}
                    </span>
                  }
                  actions={ev.user_name ? (
                    <>
                      <GenerateImageButton size="sm" onClick={() => handleGenerateUserCard(ev.user_name!)}>
                        今日大航海
                      </GenerateImageButton>
                      {onGenerateGiftGif && extra.gift_gif && (
                        <GenerateImageButton size="sm" onClick={() => handleGenerateRowGif(ev)}>
                          动态图
                        </GenerateImageButton>
                      )}
                      {isClippable(ev) && <ClipDownloadButton event={ev} size="sm" />}
                    </>
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

            <Column flexGrow={2}>
              <HeaderCell>大航海</HeaderCell>
              <Cell>
                {(rowData: LiveEvent) => {
                  const extra = rowData.extra || {}
                  const level = extra.guard_level || 3
                  const name = GUARD_NAMES[level] || extra.guard_name || '舰长'
                  const num = extra.num || 1
                  return (
                    <span className="gift-item">
                      {extra.gift_img && <img className="gift-item-img" src={fixUrl(extra.gift_img)} alt="" />}
                      {name} x{num}
                      {isMobile && extra.price ? (
                        <span className="gift-item-coin">{formatBattery(extra.price * num)}</span>
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
                    rowData.extra?.price
                      ? <span className="gift-total">¥{(rowData.extra.price / 10).toFixed(1).replace(/\.0$/, '')}</span>
                      : null
                  )}
                </Cell>
              </Column>
            )}

            {!isMobile && (
              <Column flexGrow={2}>
                <HeaderCell>操作</HeaderCell>
                <Cell>
                  {(rowData: LiveEvent) => rowData.user_name ? (
                    <div className="gift-actions">
                      <GenerateImageButton size="sm" onClick={() => handleGenerateUserCard(rowData.user_name!)}>
                        今日大航海
                      </GenerateImageButton>
                      {onGenerateGiftGif && rowData.extra?.gift_gif && (
                        <GenerateImageButton size="sm" onClick={() => handleGenerateRowGif(rowData)}>
                          动态图
                        </GenerateImageButton>
                      )}
                      {isClippable(rowData) && <ClipDownloadButton event={rowData} size="sm" />}
                    </div>
                  ) : null}
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
