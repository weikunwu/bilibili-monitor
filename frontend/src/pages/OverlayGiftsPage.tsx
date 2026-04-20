import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import type { GiftUser, LiveEvent } from '../types'
import { generateGiftCard } from '../lib/giftCard'
import { generateSuperChatCard } from '../lib/superchatCard'

type GiftOverlayItem = GiftUser & { event_id: number; type: 'gift' | 'guard' }
type SuperChatOverlayItem = {
  event_id: number
  type: 'superchat'
  user_name: string
  content: string
  extra: LiveEvent['extra']
}
type OverlayItem = GiftOverlayItem | SuperChatOverlayItem

const POLL_MS = 5000

export function OverlayGiftsPage() {
  const { roomId } = useParams()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  const [users, setUsers] = useState<OverlayItem[]>([])
  const [error, setError] = useState<string>('')
  // 主播在面板里调的循环滚动开关 + 速度百分比 0–100。poll 时带回，
  // 后端没返回就用默认（开启 + 40%）兜底。
  const [scrollEnabled, setScrollEnabled] = useState<boolean>(true)
  const [scrollPercent, setScrollPercent] = useState<number>(40)

  // 全局 body/html 背景是深色 (#0f0f1a)，OBS 浏览器源需要透明，
  // 挂载期间强制 html/body 透明，卸载还原。
  useEffect(() => {
    const prevHtml = document.documentElement.style.background
    const prevBody = document.body.style.background
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    return () => {
      document.documentElement.style.background = prevHtml
      document.body.style.background = prevBody
    }
  }, [])

  useEffect(() => {
    if (!roomId) return
    if (!token) { setError('缺少 token'); return }
    let cancelled = false
    let iv = 0
    async function poll() {
      try {
        const r = await fetch(`/api/overlay/gifts/${roomId}?token=${encodeURIComponent(token)}`)
        if (r.status === 410) {
          // 房间到期，停轮询
          setError('房间已到期')
          cancelled = true
          clearInterval(iv)
          return
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d = await r.json()
        if (!cancelled) {
          setUsers(Array.isArray(d.users) ? d.users : [])
          if (typeof d.scroll_enabled === 'boolean') {
            setScrollEnabled(d.scroll_enabled)
          }
          if (typeof d.scroll_speed === 'number' && d.scroll_speed >= 0) {
            setScrollPercent(Math.max(0, Math.min(100, d.scroll_speed)))
          }
          setError('')
        }
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    }
    poll()
    iv = window.setInterval(poll, POLL_MS)
    return () => { cancelled = true; clearInterval(iv) }
  }, [roomId, token])

  // 内容超过视口高度时从下往上循环滚动（marquee）。实现：
  // 1. 渲染两份相同卡片列表（set A + set B），translateY 从 0 滚到 -50%
  //    （即一整份的高度），到末尾瞬间跳回 0，因为 set B 和 set A 像素完全
  //    一致，视觉上看不到"跳回"。
  // 2. 一份内容高度 ≤ 视口 → 关闭动画，保持原来静态列表。
  // 3. 动画时长按内容高度 × 固定速度算，卡多滚得慢、卡少滚得快。
  const trackRef = useRef<HTMLDivElement>(null)
  const [scrollSec, setScrollSec] = useState(0)  // 0 = 静态不滚
  const overflow = scrollSec > 0

  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    const measure = () => {
      const kids = track.children.length
      if (kids === 0 || users.length === 0 || !scrollEnabled || scrollPercent <= 0) {
        // 关闭滚动或 0%：溢出卡片会被外层 overflow:hidden 裁掉
        setScrollSec(0)
        return
      }
      // 未溢出时只渲染 set A，溢出时渲染两份；按实际子节点数判断单份高度
      const duplicated = kids >= users.length * 2
      const singleH = duplicated ? track.scrollHeight / 2 : track.scrollHeight
      const viewportH = window.innerHeight
      if (singleH <= viewportH - 16) {
        setScrollSec(0)
      } else {
        // 百分比 → px/s：1% = 1px/s，100% = 100px/s（100 已经够快，再高观众看不清）
        const pxPerSec = Math.max(1, scrollPercent)
        setScrollSec(singleH / pxPerSec)
      }
    }
    measure()
    // 卡片 canvas 异步绘制完会改变高度，ResizeObserver 监听再量一次
    const ro = new ResizeObserver(measure)
    ro.observe(track)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [users, scrollEnabled, scrollPercent])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        margin: 0,
        padding: 0,
        background: 'transparent',
        overflow: 'hidden',
        fontFamily: '-apple-system, "PingFang SC", sans-serif',
      }}
    >
      <style>{`
        @keyframes overlay-marquee-up {
          from { transform: translateY(0); }
          to   { transform: translateY(-50%); }
        }
      `}</style>
      {/* 外层 gap 为 0：canvas 本身 PAD_TOP=6 已经留了相邻卡的间距，
          再加 marginTop=-6 抵消首张卡上方的多余空白。 */}
      <div
        ref={trackRef}
        style={{
          display: 'flex',
          flexDirection: 'column',
          padding: 8,
          animation: overflow ? `overlay-marquee-up ${scrollSec}s linear infinite` : undefined,
          willChange: overflow ? 'transform' : undefined,
        }}
      >
        {/* set A */}
        {users.map((u, i) => (
          u.type === 'superchat' ? (
            <SuperChatCardCanvas key={`a-${u.event_id}`} item={u} first={i === 0} />
          ) : (
            <GiftCardCanvas key={`a-${u.event_id}`} user={u} first={i === 0} />
          )
        ))}
        {/* set B 只在 overflow 时才渲染，避免无滚动时多画一倍 canvas */}
        {overflow && users.map((u) => (
          u.type === 'superchat' ? (
            <SuperChatCardCanvas key={`b-${u.event_id}`} item={u} first={false} />
          ) : (
            <GiftCardCanvas key={`b-${u.event_id}`} user={u} first={false} />
          )
        ))}
      </div>
      {error && (
        <div style={{ position: 'fixed', bottom: 4, right: 4, fontSize: 10, color: '#ef5350', opacity: 0.6 }}>
          {error}
        </div>
      )}
    </div>
  )
}

function GiftCardCanvas({
  user, first,
}: { user: GiftUser; first: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // 每次 gifts/total 变化才重绘，减小闪烁
  const sig = JSON.stringify({
    g: user.gifts, c: user.gift_coins, l: user.guard_level, a: user.avatar,
  })

  useEffect(() => {
    if (!canvasRef.current) return
    generateGiftCard(canvasRef.current, user).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', marginTop: first ? -6 : 0 }}
    />
  )
}

function SuperChatCardCanvas({
  item, first,
}: { item: SuperChatOverlayItem; first: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    // generateSuperChatCard 期待的是 LiveEvent shape：拼一个最小的过去
    const pseudoEvent: LiveEvent = {
      id: item.event_id,
      timestamp: '',
      event_type: 'superchat',
      user_name: item.user_name,
      content: item.content,
      extra: item.extra,
    } as LiveEvent
    generateSuperChatCard(canvasRef.current, pseudoEvent).catch(() => {})
  }, [item])

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', marginTop: first ? 0 : 8 }}
    />
  )
}
