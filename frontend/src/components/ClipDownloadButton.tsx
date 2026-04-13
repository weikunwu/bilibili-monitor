import { useEffect, useState } from 'react'
import { Button } from 'rsuite'
import type { LiveEvent } from '../types'
import { matchClip, clipComposeUrl } from '../api/client'
import { EVENT_GIFT, EVENT_GUARD } from '../lib/constants'

// ≥ 1000 电池 (¥1000) — matches the server-side CLIP_GIFT_THRESHOLD.
export const CLIP_MIN_COIN = 10000

export function isClippable(ev: LiveEvent): boolean {
  const extra = ev.extra || {}
  const coin = extra.total_coin ?? (extra.price || 0) * (extra.num || 1)
  if (ev.event_type === EVENT_GIFT || ev.event_type === EVENT_GUARD) {
    return coin >= CLIP_MIN_COIN
  }
  return false
}

// Module-level cache so every row in the panel doesn't refetch.
const autoClipCache = new Map<number, boolean>()
const autoClipFetches = new Map<number, Promise<boolean>>()

function useAutoClip(roomId: number | undefined): boolean | undefined {
  const [state, setState] = useState<boolean | undefined>(
    () => (roomId ? autoClipCache.get(roomId) : undefined),
  )
  useEffect(() => {
    if (!roomId) return
    if (autoClipCache.has(roomId)) { setState(autoClipCache.get(roomId)); return }
    let p = autoClipFetches.get(roomId)
    if (!p) {
      p = fetch(`/api/rooms/${roomId}/auto-clip`)
        .then((r) => r.ok ? r.json() : { enabled: false })
        .then((d) => { const v = !!d.enabled; autoClipCache.set(roomId, v); return v })
        .catch(() => false)
      autoClipFetches.set(roomId, p)
    }
    p.then((v) => setState(v))
  }, [roomId])
  return state
}

interface Props {
  event: LiveEvent
  size?: 'xs' | 'sm' | 'md' | 'lg'
}

export function ClipDownloadButton({ event, size = 'sm' }: Props) {
  const autoClip = useAutoClip(event.room_id)
  const [busy, setBusy] = useState(false)
  const [missing, setMissing] = useState(false)

  if (!autoClip) return null

  async function handleClick() {
    if (!event.room_id || !event.user_name || !event.timestamp) return
    setBusy(true)
    setMissing(false)
    try {
      const m = await matchClip(event.room_id, event.user_name, event.timestamp)
      if (!m) { setMissing(true); return }
      window.open(clipComposeUrl(event.room_id, m.name), '_blank')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button size={size} loading={busy} disabled={missing} onClick={handleClick}>
      {missing ? '无录屏' : '下载录屏'}
    </Button>
  )
}
