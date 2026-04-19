import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'

/** 进场&礼物特效 OBS 叠加页：轮询队列接口，拉到事件按顺序播一段视频。
 * 同一时间只播一个；播放中进来的新事件排队等前一个播完。
 *
 * 两种 kind：
 *   user    — 主播上传绑定到 UID 的进场视频，普通 mp4 直接 <video> 播
 *   gift_vap — 弹幕「礼物特效测试<gift_id>」触发，B站 VAP 格式 (alpha+RGB 并排)，
 *              需要 canvas 抽 alpha 通道合成，透明背景叠加到 OBS 画面
 */

const POLL_MS = 3000

interface QueuedEvent {
  kind?: 'user' | 'gift_vap'
  id: number
  uid?: number
  user_name?: string
  mp4_url?: string
  json_url?: string
  enqueued_at: number
}

interface VapInfo {
  w: number
  h: number
  f: number
  fps: number
  rgbFrame: [number, number, number, number]
  aFrame: [number, number, number, number]
}

export function OverlayEntryEffectsPage() {
  const { roomId } = useParams()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  // sound_on 从后端 queue 响应拿，主播在面板里切换后下一次 poll 就生效。
  const [soundOn, setSoundOn] = useState(false)
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
        if (cancelled) return
        setSoundOn(!!d.sound_on)
        const events: QueuedEvent[] = Array.isArray(d.events) ? d.events : []
        if (events.length) {
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

  if (!token) return <div style={{ color: '#f55', padding: 20 }}>缺少 token</div>
  if (!current) return null

  const onDone = () => (window as unknown as { __entry_effect_done: () => void }).__entry_effect_done()
  const key = `${current.kind ?? 'user'}-${current.id}-${current.enqueued_at}`

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'transparent',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none',
    }}>
      {current.kind === 'gift_vap' && current.mp4_url && current.json_url ? (
        <VapPlayer
          key={key}
          mp4Url={current.mp4_url}
          jsonUrl={current.json_url}
          soundOn={soundOn}
          onDone={onDone}
        />
      ) : (
        <video
          key={key}
          src={`/api/overlay/${roomId}/entry-effects/${current.id}/video?token=${encodeURIComponent(token)}`}
          autoPlay
          muted={!soundOn}
          playsInline
          onEnded={onDone}
          onError={onDone}
          style={{ maxWidth: '100%', maxHeight: '100%' }}
        />
      )}
    </div>
  )
}

/** B站 VAP mp4 是 alpha+RGB 并排帧，直接 <video> 会露出 alpha 图块。
 * 这里用隐藏 <video> 逐帧绘到 canvas：RGB 半边做颜色，alpha 半边灰度值
 * 写到 RGB 半边的 A 通道，得到真正带透明度的帧。 */
function VapPlayer({
  mp4Url, jsonUrl, soundOn, onDone,
}: {
  mp4Url: string
  jsonUrl: string
  soundOn: boolean
  onDone: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    let cancelled = false
    let rafId = 0
    let rvfcId = 0

    async function start() {
      // B站 CDN (*.hdslb.com) 返回 Access-Control-Allow-Origin: *，可直连；
      // <video crossOrigin="anonymous"> 让 canvas 不被 tainted，getImageData 就能用。
      let info: VapInfo
      try {
        const jsonResp = await fetch(jsonUrl)
        if (!jsonResp.ok) throw new Error('json fetch fail')
        const j = await jsonResp.json()
        info = (j.info || j) as VapInfo
      } catch {
        onDone()
        return
      }
      if (cancelled) return

      const canvas = canvasRef.current
      const video = videoRef.current
      if (!canvas || !video) { onDone(); return }
      canvas.width = info.w
      canvas.height = info.h

      const ctx = canvas.getContext('2d')
      if (!ctx) { onDone(); return }
      // 同尺寸的临时 canvas 做 alpha 合成
      const tmp = document.createElement('canvas')
      tmp.width = info.w; tmp.height = info.h
      const tmpCtx = tmp.getContext('2d', { willReadFrequently: true })
      if (!tmpCtx) { onDone(); return }

      video.crossOrigin = 'anonymous'
      video.src = mp4Url
      video.muted = !soundOn
      video.playsInline = true
      try { await video.play() } catch { onDone(); return }

      const [rx, ry, rw, rh] = info.rgbFrame
      const [ax, ay, aw, ah] = info.aFrame

      const drawFrame = () => {
        tmpCtx.clearRect(0, 0, info.w, info.h)
        tmpCtx.drawImage(video, rx, ry, rw, rh, 0, 0, info.w, info.h)
        const rgb = tmpCtx.getImageData(0, 0, info.w, info.h)
        tmpCtx.clearRect(0, 0, info.w, info.h)
        tmpCtx.drawImage(video, ax, ay, aw, ah, 0, 0, info.w, info.h)
        const alpha = tmpCtx.getImageData(0, 0, info.w, info.h)
        const out = rgb.data
        const al = alpha.data
        for (let p = 0; p < out.length; p += 4) out[p + 3] = al[p]
        ctx.putImageData(rgb, 0, 0)
      }

      // 优先 requestVideoFrameCallback：只在视频真有新帧时合成，
      // 省掉 60fps rAF 里一半重复画上一帧的浪费。不支持时回退 rAF。
      type VideoWithRvfc = HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number
        cancelVideoFrameCallback?: (id: number) => void
      }
      const v = video as VideoWithRvfc
      if (typeof v.requestVideoFrameCallback === 'function') {
        const loop = () => {
          if (cancelled || video.ended) return
          drawFrame()
          rvfcId = v.requestVideoFrameCallback!(loop)
        }
        rvfcId = v.requestVideoFrameCallback(loop)
      } else {
        const tick = () => {
          if (cancelled) return
          if (video.readyState >= 2 && !video.paused && !video.ended) drawFrame()
          rafId = requestAnimationFrame(tick)
        }
        rafId = requestAnimationFrame(tick)
      }
    }

    start()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      const v = videoRef.current as (HTMLVideoElement & {
        cancelVideoFrameCallback?: (id: number) => void
      }) | null
      if (rvfcId && v?.cancelVideoFrameCallback) v.cancelVideoFrameCallback(rvfcId)
    }
  }, [mp4Url, jsonUrl, soundOn, onDone])

  return (
    <>
      <video
        ref={videoRef}
        style={{ display: 'none' }}
        onEnded={onDone}
        onError={onDone}
      />
      <canvas
        ref={canvasRef}
        style={{ maxWidth: '100%', maxHeight: '100%' }}
      />
    </>
  )
}
