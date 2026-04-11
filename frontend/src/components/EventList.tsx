import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import { CheckPicker, Checkbox, Button } from 'rsuite'

import type { LiveEvent, TabType, GiftUser } from '../types'
import { EventItem } from './EventItem'
import { generateGiftCard } from '../lib/giftCard'

interface Props {
  events: LiveEvent[]
  activeTab: TabType
  autoScroll: boolean
  onGenerateGiftImage: (userName: string) => void
  onGenerateBlindBoxImage?: (userName: string) => void
  onShowCardPreview?: (title: string, imgUrl: string) => void
}

function getDateStr(ts: string): string {
  if (!ts) return ''
  const d = new Date(ts + 'Z')
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatDateLabel(dateStr: string): string {
  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`
  if (dateStr === todayStr) return `今天 ${dateStr}`
  if (dateStr === yesterdayStr) return `昨天 ${dateStr}`
  return dateStr
}

function buildGiftUsersFromEvents(events: LiveEvent[]): GiftUser[] {
  if (events.length === 0) return []
  const map: Record<string, GiftUser> = {}
  for (const ev of events) {
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
    const coin = (extra.price || 0) * num
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
  return Object.values(map)
}

export function EventList({
  events, activeTab, autoScroll,
  onGenerateGiftImage, onGenerateBlindBoxImage, onShowCardPreview,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set())
  const [generating, setGenerating] = useState(false)

  const isGiftTab = activeTab === 'gift'

  const giftUsers = useMemo(() => {
    const names = new Set<string>()
    for (const ev of events) {
      if (ev.event_type === 'gift' && ev.user_name) names.add(ev.user_name)
    }
    return Array.from(names).sort().map((n) => ({ label: n, value: n }))
  }, [events])

  const filtered = events.filter((ev) => {
    if (activeTab !== 'all' && ev.event_type !== activeTab) return false
    if (selectedUsers.length > 0 && activeTab === 'gift' && !selectedUsers.includes(ev.user_name || '')) return false
    return true
  })

  const eventKey = (ev: LiveEvent, i: number) => `${ev.timestamp}-${i}`

  const toggleCheck = useCallback((key: string) => {
    setCheckedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    if (checkedKeys.size === filtered.length) {
      setCheckedKeys(new Set())
    } else {
      setCheckedKeys(new Set(filtered.map((ev, i) => eventKey(ev, i))))
    }
  }, [filtered, checkedKeys.size])

  const handleGenerateCard = useCallback(async () => {
    const selected = filtered.filter((ev, i) => checkedKeys.has(eventKey(ev, i)))
    const giftUsers = buildGiftUsersFromEvents(selected)
    if (giftUsers.length === 0) return
    setGenerating(true)
    try {
      try { await document.fonts.load('italic 800 30px "Baloo 2"') } catch { /* ok */ }

      // Generate a card for each user
      const canvases: HTMLCanvasElement[] = []
      for (const u of giftUsers) {
        const c = document.createElement('canvas')
        await generateGiftCard(c, u)
        canvases.push(c)
      }

      // Stitch vertically
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
      const names = giftUsers.map((u) => u.user_name)
      const title = `${names.join(', ')} - 礼物截图`
      onShowCardPreview?.(title, url)
    } finally {
      setGenerating(false)
    }
  }, [filtered, checkedKeys])

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [filtered.length, autoScroll])

  useEffect(() => {
    setCheckedKeys(new Set())
  }, [activeTab])

  return (
    <>
      {isGiftTab && (
        <div className="event-filter">
          {filtered.length > 0 && (
            <Checkbox
              checked={checkedKeys.size > 0 && checkedKeys.size === filtered.length}
              indeterminate={checkedKeys.size > 0 && checkedKeys.size < filtered.length}
              onChange={selectAll}
            >
              全选
            </Checkbox>
          )}
          <CheckPicker
            data={giftUsers}
            value={selectedUsers}
            onChange={setSelectedUsers}
            placeholder="筛选用户"
            size="sm"
            searchable
            style={{ width: 250, flexShrink: 0 }}
          />
          {checkedKeys.size > 0 && (
            <Button size="sm" appearance="primary" loading={generating} onClick={handleGenerateCard}>
              生成礼物截图 ({checkedKeys.size})
            </Button>
          )}
        </div>
      )}
      <div className="events-container" ref={containerRef}>
        {filtered.length === 0 ? (
          <div className="empty">等待接收消息...</div>
        ) : (
          filtered.map((ev, i) => {
            const key = eventKey(ev, i)
            const dateStr = getDateStr(ev.timestamp)
            const prevDateStr = i > 0 ? getDateStr(filtered[i - 1].timestamp) : ''
            const showDateSep = dateStr !== prevDateStr
            return (
              <div key={key}>
                {showDateSep && (
                  <div className="date-separator">
                    <span>{formatDateLabel(dateStr)}</span>
                  </div>
                )}
                <EventItem
                  event={ev}
                  onGenerateGiftImage={onGenerateGiftImage}
                  onGenerateBlindBoxImage={onGenerateBlindBoxImage}
                  {...(isGiftTab ? { checked: checkedKeys.has(key), onCheck: () => toggleCheck(key) } : {})}
                />
              </div>
            )
          })
        )}
      </div>
    </>
  )
}
