import { useEffect, useState } from 'react'
import { Button } from 'rsuite'
import type { LiveEvent } from '../types'
import { matchClip } from '../api/client'
import { composeClipInBrowser, downloadBlob } from '../lib/clipCompose'
import { EVENT_GIFT, EVENT_GUARD } from '../lib/constants'

// ≥ 1000 电池 (¥1000) — matches the server-side CLIP_GIFT_THRESHOLD.
export const CLIP_MIN_COIN = 10000

// Cheap blind boxes allow-listed for clip testing (mirror of server-side
// CLIP_TEST_BLIND_NAMES in bili_client.py).
const CLIP_TEST_BLIND_NAMES = new Set(['肥肥鲨盒'])

export function isClippable(ev: LiveEvent): boolean {
  if (ev.event_type !== EVENT_GIFT && ev.event_type !== EVENT_GUARD) return false
  const extra = ev.extra || {}
  const coin = extra.total_coin ?? (extra.price || 0) * (extra.num || 1)
  if (coin >= CLIP_MIN_COIN) return true
  const blindName = (extra as { blind_name?: string }).blind_name || ''
  return CLIP_TEST_BLIND_NAMES.has(blindName)
}

// Module-level cache so every row in the panel doesn't refetch.
const autoClipCache = new Map<number, boolean>()
const autoClipFetches = new Map<number, Promise<boolean>>()
const coverCache = new Map<number, string>()
let roomsFetchPromise: Promise<void> | null = null

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

// /api/rooms returns all rooms the user can see — cheap to call once and
// keep the room cover (background / user_cover / keyframe) for backdrop use.
function useRoomCover(roomId: number | undefined): string | undefined {
  const [cover, setCover] = useState<string | undefined>(
    () => (roomId ? coverCache.get(roomId) : undefined),
  )
  useEffect(() => {
    if (!roomId || coverCache.has(roomId)) {
      setCover(roomId ? coverCache.get(roomId) : undefined)
      return
    }
    if (!roomsFetchPromise) {
      roomsFetchPromise = fetch('/api/rooms')
        .then((r) => r.ok ? r.json() : [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((list: any[]) => {
          for (const r of list) {
            const url = r?.room_cover || r?.streamer_avatar
            if (r?.room_id && url) coverCache.set(r.room_id, url)
          }
        })
        .catch(() => { /* ignore */ })
    }
    roomsFetchPromise.then(() => setCover(coverCache.get(roomId)))
  }, [roomId])
  return cover
}

interface Props {
  event: LiveEvent
  size?: 'xs' | 'sm' | 'md' | 'lg'
}

export function ClipDownloadButton({ event, size = 'sm' }: Props) {
  const autoClip = useAutoClip(event.room_id)
  const roomCover = useRoomCover(event.room_id)
  const [busy, setBusy] = useState(false)
  const [missing, setMissing] = useState(false)
  const [progress, setProgress] = useState('')

  if (!autoClip) return null

  async function handleClick() {
    if (!event.room_id || !event.user_name || !event.timestamp) return
    setBusy(true)
    setMissing(false)
    setProgress('匹配中...')
    try {
      const m = await matchClip(event.room_id, event.user_name, event.timestamp)
      if (!m) { setMissing(true); return }
      const blob = await composeClipInBrowser(event.room_id, m.name, event, roomCover, (p) => {
        if (p.stage === 'downloading') setProgress('下载中...')
        else if (p.stage === 'loading') setProgress('加载中...')
        else if (p.stage === 'recording') setProgress(`合成 ${Math.round((p.ratio || 0) * 100)}%`)
        else if (p.stage === 'finalizing') setProgress('收尾...')
      })
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm'
      downloadBlob(blob, `${m.name}.${ext}`)
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  return (
    <Button size={size} loading={busy} disabled={missing} onClick={handleClick}>
      {missing ? '无录屏' : (busy && progress ? progress : '下载录屏')}
    </Button>
  )
}
