import { useState, useMemo, useCallback, useEffect } from 'react'
import { CheckPicker, DateRangePicker, Checkbox, Table, Pagination, Input } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'

import type { LiveEvent, GiftUser, GiftGifItem } from '../types'
import { fetchEventsByType } from '../api/client'
import { formatTime, formatBattery, fixUrl, fmtDateTime, localToUTC } from '../lib/formatters'
import { GenerateImageButton } from './GenerateImageButton'
import { ClipDownloadButton, isClippable } from './ClipDownloadButton'
import { PREDEFINED_RANGES } from '../lib/dateRanges'
import { generateGiftCard } from '../lib/giftCard'
import { stackCanvasesVertically } from '../lib/canvasUtils'
import { useIsMobile } from '../hooks/useIsMobile'

const { Column, HeaderCell, Cell } = Table

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
    const checked = filtered.filter((ev) => checkedKeys.has(ev._key))
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
      const name = extra.gift_name || ev.content || ''
      const num = extra.num || 1
      const coin = extra.total_coin || 0
      u.gifts[name] = (u.gifts[name] || 0) + num
      u.gift_coins[name] = (u.gift_coins[name] || 0) + coin
      u.total_coin += coin
      if (extra.gift_img && !u.gift_imgs[name]) u.gift_imgs[name] = extra.gift_img
      if (extra.action && !u.gift_actions[name]) u.gift_actions[name] = extra.action
      if (extra.gift_id && !u.gift_ids[name]) u.gift_ids[name] = extra.gift_id
      if (extra.gift_gif) {
        if (!u.gift_gifs) u.gift_gifs = {}
        if (!u.gift_gifs[name]) u.gift_gifs[name] = extra.gift_gif
      }
    }
    // sort gifts within each user by tier: gold > pink > purple > blue
    function tierOrder(battery: number): number {
      if (battery >= 10000) return 0
      if (battery >= 5000) return 1
      if (battery >= 1000) return 2
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
    return users
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
    const u: GiftUser = {
      user_name: rowData.user_name!,
      avatar: extra.avatar || '',
      gifts: { [name]: extra.num || 1 },
      gift_imgs: extra.gift_img ? { [name]: extra.gift_img } : {},
      gift_actions: extra.action ? { [name]: extra.action } : {},
      gift_coins: { [name]: extra.total_coin || 0 },
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
    if (items.length === 0) { alert('所选礼物均无动态图'); return }
    if (items.length > 10) { alert('动态截图一次最多生成 10 个，请减少选择'); return }
    await onGenerateGiftGif?.(items)
  }, [aggregateChecked, onGenerateGiftGif])

  return (
    <div className="gift-panel">
      <div className="panel-title">礼物</div>
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
        {giftNameOptions.length > 0 && (
          <CheckPicker
            data={giftNameOptions}
            value={selectedGifts}
            onChange={setSelectedGifts}
            placeholder="筛选礼物"
            size="sm"
            searchable
            countable
            w={200}
          />
        )}
        {giftEvents.some((ev) => (ev.extra?.total_coin || 0) > 0) && (
          <Input
            type="number"
            value={minTotal}
            onChange={setMinTotal}
            placeholder="最低总价(元)"
            size="sm"
            style={{ width: 120 }}
          />
        )}
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
