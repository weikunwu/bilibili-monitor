import { useEffect, useRef, useState } from 'react'
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
      {/* 外层 gap 为 0：canvas 本身 PAD_TOP=6 已经留了相邻卡的间距，
          再加 marginTop=-6 抵消首张卡上方的多余空白。 */}
      <div style={{ display: 'flex', flexDirection: 'column', padding: 8 }}>
        {users.map((u, i) => (
          u.type === 'superchat' ? (
            <SuperChatCardCanvas
              key={u.event_id}
              item={u}
              first={i === 0}
            />
          ) : (
            <GiftCardCanvas
              key={u.event_id}
              user={u}
              first={i === 0}
            />
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
