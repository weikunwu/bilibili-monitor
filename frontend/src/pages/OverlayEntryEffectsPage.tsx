import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'

/** 进场特效 OBS 叠加页：轮询队列接口，拉到事件按顺序播一段视频。
 * 同一时间只播一个；播放中进来的新事件排队等前一个播完。 */

const POLL_MS = 1500

interface QueuedEvent {
  id: number
  uid: number
  user_name: string
  enqueued_at: number
}

export function OverlayEntryEffectsPage() {
  const { roomId } = useParams()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  const [current, setCurrent] = useState<QueuedEvent | null>(null)
  const queueRef = useRef<QueuedEvent[]>([])
  const pollRef = useRef<number>(0)
  const currentRef = useRef<QueuedEvent | null>(null)

  // OBS 浏览器源要透明背景
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
    if (!roomId || !token) return
    let cancelled = false

    async function poll() {
      try {
        const r = await fetch(`/api/overlay/${roomId}/entry-effects/queue?token=${encodeURIComponent(token)}`)
        if (!r.ok) return
        const d = await r.json()
        const events: QueuedEvent[] = Array.isArray(d.events) ? d.events : []
        if (events.length && !cancelled) {
          queueRef.current.push(...events)
          // 如果当前没在播，立刻从队首开播
          if (!currentRef.current) pumpNext()
        }
      } catch { /* ignore */ }
    }

    function pumpNext() {
      const next = queueRef.current.shift() || null
      currentRef.current = next
      setCurrent(next)
    }

    function onVideoDone() {
      pumpNext()
    }

    ;(window as unknown as { __entry_effect_done: () => void }).__entry_effect_done = onVideoDone

    poll()
    pollRef.current = window.setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(pollRef.current)
    }
  }, [roomId, token])

  if (!token) return <div style={{ color: '#f55', padding: 20 }}>missing token</div>
  if (!current) return null

  const videoUrl = `/api/overlay/${roomId}/entry-effects/${current.id}/video?token=${encodeURIComponent(token)}`

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'transparent',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none',
    }}>
      <video
        // key 强制每个事件重新挂载 <video>，避免 reuse 带来的 autoplay 失效
        key={`${current.id}-${current.enqueued_at}`}
        src={videoUrl}
        autoPlay
        muted={false}
        playsInline
        onEnded={() => (window as unknown as { __entry_effect_done: () => void }).__entry_effect_done()}
        onError={() => (window as unknown as { __entry_effect_done: () => void }).__entry_effect_done()}
        style={{ maxWidth: '100%', maxHeight: '100%' }}
      />
    </div>
  )
}
