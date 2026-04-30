import { useState, useMemo, useCallback, useEffect } from 'react'
import { CheckPicker, DateRangePicker, Checkbox, Table, Pagination, Input } from 'rsuite'
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

// 大航海购买事件：gift_name 就是档位名。普通礼物事件即使 sender 有舰长等级，
// gift_name 也不会落在这里。区分开才不会把舰长用户送的所有礼物强制染成蓝色。
const GUARD_GIFT_NAMES = new Set(['舰长', '提督', '总督'])

function tierCoinForGuard(level: number): number {
  // 总督=金(10000+) / 提督=紫(1000-4999) / 舰长=蓝(<1000)
  return level === 1 ? 10000 : level === 2 ? 1000 : 0
}

interface Props {
  roomId: number
  dateRange: DateRange
  onQueryRange: (from: string, to: string, range: DateRange) => void
  onGenerateGiftImage: (userName: string) => Promise<void> | void
  onGenerateBlindBoxImage?: (userName: string) => Promise<void> | void
  onShowCardPreview?: (imgUrl: string, ext?: 'png' | 'gif') => void
  onGenerateGiftGif?: (items: GiftGifItem[]) => Promise<void> | void
}

export function GiftPanel({
  roomId, dateRange, onQueryRange,
  onGenerateGiftImage, onGenerateBlindBoxImage, onShowCardPreview, onGenerateGiftGif,
}: Props) {
  const isMobile = useIsMobile()
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [selectedGifts, setSelectedGifts] = useState<string[]>([])
  const [minTotal, setMinTotal] = useState<string>('')
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [giftEvents, setGiftEvents] = useState<LiveEvent[]>([])

  useEffect(() => {
    if (!dateRange) return
    fetchEventsByType(roomId, 'gift', {
      timeFrom: localToUTC(fmtDateTime(dateRange[0])),
      timeTo: localToUTC(fmtDateTime(dateRange[1])),
    }).then(setGiftEvents)
  }, [roomId, dateRange])

  const userOptions = useMemo(() => {
    const names = new Set(giftEvents.map((ev) => ev.user_name || ''))
    return Array.from(names).filter(Boolean).map((n) => ({ label: n, value: n }))
  }, [giftEvents])

  const giftNameOptions = useMemo(() => {
    const names = new Set(giftEvents.map((ev) => ev.extra?.gift_name || ''))
    return Array.from(names).filter(Boolean).map((n) => ({ label: n, value: n }))
  }, [giftEvents])

  const indexed = useMemo(() =>
    giftEvents.map((ev, i) => ({ ...ev, _key: `${ev.timestamp}-${i}` })),
    [giftEvents])

  // 输入是元，total_coin 是电池（1 元 = 10 电池）
  const minTotalBattery = (Number(minTotal) || 0) * 10
  const filtered = indexed.filter((ev) => {
    if (selectedUsers.length > 0 && !selectedUsers.includes(ev.user_name || '')) return false
    if (selectedGifts.length > 0 && !selectedGifts.includes(ev.extra?.gift_name || '')) return false
    if (minTotalBattery > 0 && (ev.extra?.total_coin || 0) < minTotalBattery) return false
    return true
  })

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

  const aggregateChecked = useCallback(() => {
    // 按 (用户, 礼物) 聚合：同一用户送同一种礼物合并计数，但不同礼物/不同用户
    // 各自独占一张卡。最后按单卡 total_coin 全局降序，避免同一用户的所有礼物
    // 被强行捏在一起。
    const checked = filtered.filter((ev) => checkedKeys.has(ev._key))
    const map: Record<string, GiftUser> = {}
    for (const ev of checked) {
      const extra = ev.extra || {}
      const userName = ev.user_name || ''
      const giftName = extra.gift_name || ev.content || ''
      const key = `${userName}\u0000${giftName}`
      if (!map[key]) {
        map[key] = {
          user_name: userName, avatar: extra.avatar || '',
          gifts: {}, gift_imgs: {}, gift_actions: {}, gift_coins: {}, gift_ids: {},
          guard_level: 0, total_coin: 0,
        }
      }
      const u = map[key]
      if (!u.avatar && extra.avatar) u.avatar = extra.avatar
      if (extra.guard_level && extra.guard_level > u.guard_level) u.guard_level = extra.guard_level
      const num = extra.num || 1
      const coin = extra.total_coin || 0
      // 只有真的买大航海（gift_name 是舰长/提督/总督）才按档位上色；
      // 舰长发的普通礼物不应被 guard_level 污染成蓝卡。
      const isGuardBuy = GUARD_GIFT_NAMES.has(giftName)
      const tierCoin = isGuardBuy ? tierCoinForGuard(extra.guard_level || 0) : coin
      u.gifts[giftName] = (u.gifts[giftName] || 0) + num
      u.gift_coins[giftName] = (u.gift_coins[giftName] || 0) + tierCoin
      u.total_coin += coin
      if (extra.gift_img && !u.gift_imgs[giftName]) u.gift_imgs[giftName] = extra.gift_img
      if (extra.action && !u.gift_actions[giftName]) u.gift_actions[giftName] = extra.action
      if (extra.gift_id && !u.gift_ids[giftName]) u.gift_ids[giftName] = extra.gift_id
      if (extra.gift_gif) {
        if (!u.gift_gifs) u.gift_gifs = {}
        if (!u.gift_gifs[giftName]) u.gift_gifs[giftName] = extra.gift_gif
      }
    }
    return Object.values(map).sort((a, b) => b.total_coin - a.total_coin)
  }, [filtered, checkedKeys])

  const handleGenerateCard = useCallback(async () => {
    const users = aggregateChecked()
    if (users.length === 0) return
    try { await document.fonts.load('italic 800 30px "Baloo 2"') } catch { /* ok */ }
    const canvases: HTMLCanvasElement[] = []
    for (const u of users) {
      const c = document.createElement('canvas')
      await generateGiftCard(c, u)
      canvases.push(c)
    }
    onShowCardPreview?.(stackCanvasesVertically(canvases).toDataURL('image/png'))
  }, [aggregateChecked, onShowCardPreview])

  const handleGenerateRowGif = useCallback((rowData: LiveEvent) => {
    const extra = rowData.extra!
    const name = extra.gift_name!
    const isGuardBuy = GUARD_GIFT_NAMES.has(name)
    const tierCoin = isGuardBuy
      ? tierCoinForGuard(extra.guard_level || 0)
      : (extra.total_coin || 0)
    const u: GiftUser = {
      user_name: rowData.user_name!,
      avatar: extra.avatar || '',
      gifts: { [name]: extra.num || 1 },
      gift_imgs: extra.gift_img ? { [name]: extra.gift_img } : {},
      gift_actions: extra.action ? { [name]: extra.action } : {},
      gift_coins: { [name]: tierCoin },
      gift_ids: extra.gift_id ? { [name]: extra.gift_id } : {},
      gift_gifs: { [name]: extra.gift_gif! },
      guard_level: extra.guard_level || 0,
      total_coin: extra.total_coin || 0,
    }
    return onGenerateGiftGif?.([{ u, giftName: name }])
  }, [onGenerateGiftGif])

  const handleGenerateGif = useCallback(async () => {
    const users = aggregateChecked()
    if (users.length === 0) return
    const items: { u: GiftUser; giftName: string }[] = []
    for (const u of users) {
      for (const giftName of Object.keys(u.gifts)) {
        if (u.gift_gifs?.[giftName]) items.push({ u, giftName })
      }
    }
    if (items.length === 0) { toast('所选礼物均无动态图', 'warning'); return }
    if (items.length > 10) { toast('动态截图一次最多生成 10 个，请减少选择', 'warning'); return }
    await onGenerateGiftGif?.(items)
  }, [aggregateChecked, onGenerateGiftGif])

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
        <CheckPicker
          data={giftNameOptions}
          value={selectedGifts}
          onChange={setSelectedGifts}
          placeholder="筛选礼物"
          size="sm"
          searchable
          countable
          block={isMobile}
          style={isMobile ? undefined : { width: 200 }}
        />
        <Input
          type="number"
          value={minTotal}
          onChange={setMinTotal}
          placeholder="最低总价(元)"
          size="sm"
          style={{ width: isMobile ? '100%' : 120 }}
        />
        {checkedKeys.size > 0 && (
          <>
            <GenerateImageButton size="sm" appearance="primary" onClick={handleGenerateCard}>
              生成礼物截图 ({checkedKeys.size})
            </GenerateImageButton>
            <GenerateImageButton size="sm" appearance="primary" onClick={handleGenerateGif}>
              生成动态截图 ({checkedKeys.size})
            </GenerateImageButton>
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
        <div className="empty">暂无礼物数据</div>
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
              return (
                <EventCard
                  key={ev._key}
                  checked={checkedKeys.has(ev._key)}
                  onCheckChange={() => toggleKey(ev._key)}
                  avatarUrl={extra.avatar}
                  userName={ev.user_name || ''}
                  timestamp={formatShortDateTime(ev.timestamp)}
                  value={extra.total_coin ? formatBattery(extra.total_coin) : null}
                  mainContent={
                    <span className="gift-item">
                      {extra.gift_img && <img className="gift-item-img" src={fixUrl(extra.gift_img)} referrerPolicy="no-referrer" alt="" />}
                      {extra.gift_name || ev.content} x{extra.num || 1}
                    </span>
                  }
                  actions={ev.user_name ? (
                    <>
                      <GenerateImageButton size="sm" onClick={() => onGenerateGiftImage(ev.user_name!)}>
                        今日礼物
                      </GenerateImageButton>
                      {onGenerateBlindBoxImage && (
                        <GenerateImageButton size="sm" onClick={() => onGenerateBlindBoxImage(ev.user_name!)}>
                          今日盲盒
                        </GenerateImageButton>
                      )}
                      {onGenerateGiftGif && extra.gift_gif && extra.gift_name && (
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
            <span>共 {filtered.length} 条，合计: <span className="gift-total">{formatBattery(totalGold)}</span></span>
            <Pagination
              size="xs"
              prev
              next
              ellipsis
              boundaryLinks
              maxButtons={5}
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
              <HeaderCell>礼物</HeaderCell>
              <Cell>
                {(rowData: LiveEvent) => {
                  const extra = rowData.extra || {}
                  return (
                    <span className="gift-item">
                      {extra.gift_img && <img className="gift-item-img" src={fixUrl(extra.gift_img)} referrerPolicy="no-referrer" alt="" />}
                      {extra.gift_name || rowData.content} x{extra.num || 1}
                      {isMobile && extra.total_coin ? (
                        <span className="gift-item-coin">{formatBattery(extra.total_coin)}</span>
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
                      ? <span className="gift-total">{formatBattery(rowData.extra.total_coin)}</span>
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
                      {onGenerateGiftGif && rowData.extra?.gift_gif && rowData.extra?.gift_name && (
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
            <span>共 {filtered.length} 条，合计: <span className="gift-total">{formatBattery(totalGold)}</span></span>
            <Pagination
              size="xs"
              prev
              next
              ellipsis
              boundaryLinks
              maxButtons={5}
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
