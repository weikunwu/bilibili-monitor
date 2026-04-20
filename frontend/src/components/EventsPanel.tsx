import { useLayoutEffect, useRef, useState } from 'react'
import { Nav } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'

import type { LiveEvent, GiftGifItem, EventsKind } from '../types'
import { GiftPanel } from './GiftPanel'
import { GuardPanel } from './GuardPanel'
import { SuperChatPanel } from './SuperChatPanel'
import type { SuperChatImageOptions } from './SuperChatPanel'

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
  // 首次切到某个 kind 才挂载对应 panel，避免启动时并发拉 3 种历史数据。
  const [mounted, setMounted] = useState<Record<EventsKind, boolean>>({
    gift: true, guard: false, superchat: false, danmu: false,
  })

  const selectChip = (k: EventsKind) => {
    setKind(k)
    setMounted((m) => m[k] ? m : { ...m, [k]: true })
  }

  // event-filter 的 sticky top 必须等于 header 的实际高度，否则上滚到 sticky
  // 触发时会和 header 重叠几像素出现"抖一下"。把 header 高度实测后写入
  // CSS 变量，避免硬编码（rsuite Nav padding 或字体变了就失效）。
  const panelRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const panel = panelRef.current
    const header = headerRef.current
    if (!panel || !header) return
    const ro = new ResizeObserver(() => {
      panel.style.setProperty('--events-header-h', `${header.offsetHeight}px`)
    })
    ro.observe(header)
    panel.style.setProperty('--events-header-h', `${header.offsetHeight}px`)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="events-panel" ref={panelRef}>
      <div className="events-panel-header" ref={headerRef}>
        <div className="panel-title">礼物截图</div>
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

