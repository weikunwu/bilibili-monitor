import { useEffect, useState } from 'react'
import { Button } from 'rsuite'
import type { LiveEvent } from '../types'
import { matchClip } from '../api/client'
import { composeClipInBrowser, downloadBlob } from '../lib/clipCompose'
import { EVENT_GIFT, EVENT_GUARD } from '../lib/constants'

// ≥ 1000 电池 (¥1000) — matches the server-side CLIP_GIFT_THRESHOLD.
export const CLIP_MIN_COIN = 10000

export function isClippable(ev: LiveEvent): boolean {
  if (ev.event_type !== EVENT_GIFT && ev.event_type !== EVENT_GUARD) return false
  const extra = ev.extra || {}
  const coin = extra.total_coin ?? (extra.price || 0) * (extra.num || 1)
  return coin >= CLIP_MIN_COIN
}

// Module-level cache so every row in the panel doesn't refetch the
// auto-clip flag (decides whether the button renders at all).
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

// Per-room cache of clip trigger (label, trigger_ts) pairs. Lets each row
// pre-check availability on mount so expired clips can render a permanently
// disabled "已失效" button without a user click.
interface ClipTrig { label: string; trigger_ts: string }
const clipTrigsCache = new Map<number, ClipTrig[]>()
const clipTrigsFetches = new Map<number, Promise<ClipTrig[]>>()

function fetchClipTrigs(roomId: number): Promise<ClipTrig[]> {
  const cached = clipTrigsCache.get(roomId)
  if (cached) return Promise.resolve(cached)
  let p = clipTrigsFetches.get(roomId)
  if (!p) {
    p = fetch(`/api/rooms/${roomId}/clips`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Array<{ overlays?: ClipTrig[] }>) => {
        const out: ClipTrig[] = []
        for (const c of list) for (const ov of c.overlays || []) {
          if (ov.trigger_ts) out.push({ label: ov.label || '', trigger_ts: ov.trigger_ts })
        }
        clipTrigsCache.set(roomId, out)
        return out
      })
      .catch(() => [] as ClipTrig[])
    clipTrigsFetches.set(roomId, p)
  }
  return p
}

// Mirror the server-side match logic in routes/clips.py so the on-mount
// check agrees with what clicking would actually do.
function hasMatch(trigs: ClipTrig[], userName: string, tsIso: string): boolean {
  const eventMs = Date.parse(tsIso.replace(' ', 'T') + 'Z')
  if (!Number.isFinite(eventMs)) return false
  const safe = (userName.match(/[\w-]/g) || []).join('').slice(0, 32)
  for (const t of trigs) {
    const tMs = Date.parse(t.trigger_ts.replace(' ', 'T') + 'Z')
    if (!Number.isFinite(tMs)) continue
    if (Math.abs(tMs - eventMs) > 60_000) continue
    if (t.label && safe && t.label === safe.slice(0, t.label.length)) return true
  }
  return false
}

// On-demand lookup — clip download is a rare event and the anchor could
// swap their background mid-stream, so hit the backend fresh each click.
async function fetchRoomBackground(roomId: number): Promise<string | undefined> {
  try {
    const d = await fetch(`/api/rooms/${roomId}/background`).then((r) => r.json())
    return d?.url || undefined
  } catch {
    return undefined
  }
}

interface Props {
  event: LiveEvent
  size?: 'xs' | 'sm' | 'md' | 'lg'
}

export function ClipDownloadButton({ event, size = 'sm' }: Props) {
  const autoClip = useAutoClip(event.room_id)
  const [busy, setBusy] = useState(false)
  const [missing, setMissing] = useState(false)
  const [progress, setProgress] = useState('')

  // Pre-check availability once auto-clip is known enabled — expired clips
  // stay permanently disabled without making the user click first.
  useEffect(() => {
    if (!autoClip || !event.room_id || !event.user_name || !event.timestamp) return
    let cancelled = false
    fetchClipTrigs(event.room_id).then((trigs) => {
      if (cancelled) return
      if (!hasMatch(trigs, event.user_name!, event.timestamp)) setMissing(true)
    })
    return () => { cancelled = true }
  }, [autoClip, event.room_id, event.user_name, event.timestamp])

  if (!autoClip) return null

  async function handleClick() {
    if (!event.room_id || !event.user_name || !event.timestamp) return
    setBusy(true)
    setMissing(false)
    setProgress('匹配中...')
    try {
      const [m, cover] = await Promise.all([
        matchClip(event.room_id, event.user_name, event.timestamp),
        fetchRoomBackground(event.room_id),
      ])
      if (!m) { setMissing(true); return }
      const blob = await composeClipInBrowser(event.room_id, m.name, event, cover, (p) => {
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
      {missing ? '已失效' : (busy && progress ? progress : '下载录屏')}
    </Button>
  )
}
