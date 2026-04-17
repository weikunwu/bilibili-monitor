import { useEffect, useState } from 'react'
import { Button, Message, useToaster } from 'rsuite'
import type { LiveEvent } from '../types'
import { matchClip } from '../api/client'
import { composeClipInBrowser, downloadBlob } from '../lib/clipCompose'
import { EVENT_GIFT, EVENT_GUARD } from '../lib/constants'

// ≥ 1000 电池 (¥1000) — matches the server-side CLIP_GIFT_THRESHOLD.
export const CLIP_MIN_COIN = 10000

export function isClippable(ev: LiveEvent): boolean {
  if (ev.event_type !== EVENT_GIFT && ev.event_type !== EVENT_GUARD) return false
  // Unit-price gate (matches server-side CLIP_GIFT_THRESHOLD) — a combo of
  // cheap gifts shouldn't show the download button.
  const unit = ev.extra?.price || 0
  return unit >= CLIP_MIN_COIN
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
  const toaster = useToaster()
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
    } catch (err) {
      toaster.push(
        <Message type="error" showIcon closable>{(err as Error).message || '合成失败'}</Message>,
        { duration: 5000, placement: 'topCenter' },
      )
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
