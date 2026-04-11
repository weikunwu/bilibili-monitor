import { useState, useMemo, useCallback } from 'react'
import { CheckPicker, DateRangePicker, Checkbox, Table } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'

import type { LiveEvent, GiftUser } from '../types'
import { formatCoin, fixUrl } from '../lib/formatters'
import { GenerateImageButton } from './GenerateImageButton'
import { EVENT_GIFT } from '../lib/constants'
import { generateGiftCard } from '../lib/giftCard'

const { Column, HeaderCell, Cell } = Table

interface Props {
  events: LiveEvent[]
  defaultRange: DateRange | null
  onQueryRange: (from: string, to: string) => void
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

function buildGiftUsers(events: LiveEvent[]): GiftUser[] {
  const map: Record<string, GiftUser> = {}
  for (const ev of events) {
    if (ev.event_type !== EVENT_GIFT) continue
    const extra = ev.extra || {}
    const key = ev.user_name || ''
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
    const coin = (extra.total_coin || 0)
    u.gifts[name] = (u.gifts[name] || 0) + num
    u.gift_coins[name] = (u.gift_coins[name] || 0) + coin
    u.total_coin += coin
    if (extra.gift_img && !u.gift_imgs[name]) u.gift_imgs[name] = extra.gift_img
    if (extra.action && !u.gift_actions[name]) u.gift_actions[name] = extra.action
    if (extra.gift_id && !u.gift_ids[name]) u.gift_ids[name] = extra.gift_id
    if (extra.guard_level && (!u.guard_level || extra.guard_level < u.guard_level)) {
      u.guard_level = extra.guard_level
    }
  }
  return Object.values(map).sort((a, b) => b.total_coin - a.total_coin)
}

export function GiftPanel({
  events, defaultRange, onQueryRange,
  onGenerateGiftImage, onGenerateBlindBoxImage, onShowCardPreview,
}: Props) {
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [checkedUsers, setCheckedUsers] = useState<Set<string>>(new Set())


  const giftUsers = useMemo(() => buildGiftUsers(events), [events])

  const userOptions = useMemo(() =>
    giftUsers.map((u) => ({ label: u.user_name, value: u.user_name })),
    [giftUsers])

  const filtered = selectedUsers.length > 0
    ? giftUsers.filter((u) => selectedUsers.includes(u.user_name))
    : giftUsers

  const totalGold = filtered.reduce((s, u) => s + u.total_coin, 0)

  const toggleUser = useCallback((name: string) => {
    setCheckedUsers((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    if (checkedUsers.size === filtered.length) {
      setCheckedUsers(new Set())
    } else {
      setCheckedUsers(new Set(filtered.map((u) => u.user_name)))
    }
  }, [filtered, checkedUsers.size])

  const handleGenerateCard = useCallback(async () => {
    const selected = filtered.filter((u) => checkedUsers.has(u.user_name))
    if (selected.length === 0) return
    try { await document.fonts.load('italic 800 30px "Baloo 2"') } catch { /* ok */ }
    const canvases: HTMLCanvasElement[] = []
    for (const u of selected) {
      const c = document.createElement('canvas')
      await generateGiftCard(c, u)
      canvases.push(c)
    }
    const totalHeight = canvases.reduce((h, c) => h + c.height, 0)
    const maxWidth = Math.max(...canvases.map((c) => c.width))
    const merged = document.createElement('canvas')
    merged.width = maxWidth
    merged.height = totalHeight
    const ctx = merged.getContext('2d')!
    let y = 0
    for (const c of canvases) {
      ctx.drawImage(c, 0, y)
      y += c.height
    }
    const url = merged.toDataURL('image/png')
    const names = selected.map((u) => u.user_name)
    onShowCardPreview?.(`${names.join(', ')} - 礼物截图`, url)
  }, [filtered, checkedUsers])

  return (
    <div className="gift-panel">
      <div className="event-filter">
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
        {filtered.length > 0 && (
          <Checkbox
            checked={checkedUsers.size > 0 && checkedUsers.size === filtered.length}
            indeterminate={checkedUsers.size > 0 && checkedUsers.size < filtered.length}
            onChange={selectAll}
          >
            全选
          </Checkbox>
        )}
        {checkedUsers.size > 0 && (
          <GenerateImageButton size="sm" appearance="primary" onClick={handleGenerateCard}>
            生成礼物截图 ({checkedUsers.size})
          </GenerateImageButton>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="empty">暂无礼物数据</div>
      ) : (
        <div className="gift-table-wrap">
          <Table
            data={filtered}
            autoHeight
            rowKey="user_name"
            rowClassName={(rowData) => checkedUsers.has(rowData?.user_name) ? 'gift-row-checked' : ''}
          >
            <Column width={50} align="center">
              <HeaderCell></HeaderCell>
              <Cell>
                {(rowData: GiftUser) => (
                  <Checkbox
                    checked={checkedUsers.has(rowData.user_name)}
                    onChange={() => toggleUser(rowData.user_name)}
                  />
                )}
              </Cell>
            </Column>

            <Column width={160}>
              <HeaderCell>用户</HeaderCell>
              <Cell>
                {(rowData: GiftUser) => (
                  <div className="gift-user-cell">
                    {rowData.avatar && <img className="gift-user-avatar" src={fixUrl(rowData.avatar)} alt="" />}
                    <span className="gift-user-name">{rowData.user_name}</span>
                  </div>
                )}
              </Cell>
            </Column>

            <Column flexGrow={1} minWidth={200}>
              <HeaderCell>礼物明细</HeaderCell>
              <Cell>
                {(rowData: GiftUser) => (
                  <div className="gift-details">
                    {Object.entries(rowData.gifts).map(([name, count]) => (
                      <span key={name} className="gift-item">
                        {rowData.gift_imgs[name] && (
                          <img className="gift-item-img" src={fixUrl(rowData.gift_imgs[name])} alt="" />
                        )}
                        {name} x{count}
                        {rowData.gift_coins[name] > 0 && (
                          <span className="gift-item-coin">{formatCoin(rowData.gift_coins[name], 'gold')}</span>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </Cell>
            </Column>

            <Column width={100} align="right">
              <HeaderCell>总价值</HeaderCell>
              <Cell>
                {(rowData: GiftUser) => (
                  <span className="gift-total">{formatCoin(rowData.total_coin, 'gold')}</span>
                )}
              </Cell>
            </Column>

            <Column width={140}>
              <HeaderCell>操作</HeaderCell>
              <Cell>
                {(rowData: GiftUser) => (
                  <div className="gift-actions">
                    <GenerateImageButton size="xs" onClick={() => onGenerateGiftImage(rowData.user_name)}>
                      今日礼物
                    </GenerateImageButton>
                    {onGenerateBlindBoxImage && (
                      <GenerateImageButton size="xs" onClick={() => onGenerateBlindBoxImage(rowData.user_name)}>
                        今日盲盒
                      </GenerateImageButton>
                    )}
                  </div>
                )}
              </Cell>
            </Column>
          </Table>

          <div className="gift-table-footer">
            合计: <span className="gift-total">{formatCoin(totalGold, 'gold')}</span>
          </div>
        </div>
      )}
    </div>
  )
}
