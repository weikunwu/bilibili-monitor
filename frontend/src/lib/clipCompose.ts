// Compose a recorded base mp4 with one or more VAP (alpha+rgb side-by-side)
// gift animations in the browser via Canvas + MediaRecorder. The server used
// to do this with ffmpeg, but on our 256MB VM the re-encode kept getting
// OOM-killed. Offloading to the user's browser sidesteps that entirely.

interface VapSidecarInfo {
  w: number
  h: number
  f: number
  fps: number
  rgbFrame: [number, number, number, number]
  aFrame: [number, number, number, number]
}

interface ClipMeta {
  base_mp4: string
  clip_start_ts: string
  duration_sec: number
  overlays: {
    offset_sec: number
    trigger_ts: string
    label: string
    gift_id: number
    effect_id: number
    vap_mp4?: string
    vap_json?: string
  }[]
}

interface LoadedVap {
  offset: number
  info: VapSidecarInfo
  video: HTMLVideoElement
  tmp: HTMLCanvasElement
  tmpCtx: CanvasRenderingContext2D
  durSec: number
  url: string
}

async function loadVideo(src: string): Promise<HTMLVideoElement> {
  const v = document.createElement('video')
  v.src = src
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  await new Promise<void>((resolve, reject) => {
    v.addEventListener('loadedmetadata', () => resolve(), { once: true })
    v.addEventListener('error', () => reject(new Error('video load failed')), { once: true })
  })
  return v
}

function proxied(url: string): string {
  return `/api/proxy-image?url=${encodeURIComponent(url)}`
}

export interface ComposeProgress {
  stage: 'downloading' | 'loading' | 'recording' | 'finalizing'
  ratio?: number
}

export async function composeClipInBrowser(
  roomId: number,
  name: string,
  onProgress?: (p: ComposeProgress) => void,
): Promise<Blob> {
  onProgress?.({ stage: 'downloading' })

  // 1. Fetch sidecar + base + VAPs in parallel (all same-origin via proxy).
  const [meta, baseBlob] = await Promise.all([
    fetch(`/api/rooms/${roomId}/clips/${name}.json`).then((r) => r.json() as Promise<ClipMeta>),
    fetch(`/api/rooms/${roomId}/clips/${name}.mp4`).then((r) => r.blob()),
  ])
  const overlays = meta.overlays.filter((o) => o.vap_mp4 && o.vap_json)
  if (overlays.length === 0) {
    // Nothing to composite — just return the base mp4 as-is.
    return baseBlob
  }

  const vapAssets = await Promise.all(
    overlays.map(async (ov) => {
      const [mp4Blob, info] = await Promise.all([
        fetch(proxied(ov.vap_mp4!)).then((r) => r.blob()),
        fetch(proxied(ov.vap_json!))
          .then((r) => r.json())
          .then((j) => (j.info || j) as VapSidecarInfo),
      ])
      return { mp4Blob, info, offset: ov.offset_sec }
    }),
  )

  onProgress?.({ stage: 'loading' })

  const baseUrl = URL.createObjectURL(baseBlob)
  const baseVideo = await loadVideo(baseUrl)
  const W = baseVideo.videoWidth
  const H = baseVideo.videoHeight

  const vaps: LoadedVap[] = await Promise.all(
    vapAssets.map(async (a) => {
      const url = URL.createObjectURL(a.mp4Blob)
      const video = await loadVideo(url)
      const tmp = document.createElement('canvas')
      tmp.width = a.info.w
      tmp.height = a.info.h
      const tmpCtx = tmp.getContext('2d', { willReadFrequently: true })!
      return {
        offset: a.offset,
        info: a.info,
        video,
        tmp,
        tmpCtx,
        durSec: a.info.fps ? a.info.f / a.info.fps : 12,
        url,
      }
    }),
  )

  // 2. Main canvas + capture stream.
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { alpha: false })!
  const stream = canvas.captureStream(30)

  // Try to pull the base audio track into the recorded stream.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseStream = (baseVideo as any).captureStream?.() || (baseVideo as any).mozCaptureStream?.()
    const audio = baseStream?.getAudioTracks?.()[0]
    if (audio) stream.addTrack(audio)
  } catch { /* best-effort */ }

  // Pick a codec the browser actually supports. Chrome: webm/vp9, Safari: mp4.
  const preferred = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]
  const mimeType = preferred.find((m) => MediaRecorder.isTypeSupported(m)) || ''
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  const stopped = new Promise<void>((r) => { recorder.onstop = () => r() })

  recorder.start(1000)
  onProgress?.({ stage: 'recording', ratio: 0 })

  // 3. Drive playback. requestVideoFrameCallback fires per decoded base frame.
  await baseVideo.play().catch(() => { /* autoplay policies — muted should work */ })

  // Kick off each VAP at its offset. They're short, so we start them on demand
  // and let them play through; we draw whichever is within its time window.
  const vapStarted = vaps.map(() => false)

  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }

    // The loop below may stall in a couple of ways: rVFC stops firing once the
    // base reaches EOF (so we'd never see ended checked again); or decoding
    // hits a bad frame and neither ended nor more rVFC callbacks come. Belt-
    // and-braces: listen to ended/error, and hard-cap at (duration + 5s) of
    // wall-clock so the button can't spin forever.
    baseVideo.addEventListener('ended', finish, { once: true })
    baseVideo.addEventListener('error', finish, { once: true })
    const wallCap = ((baseVideo.duration || meta.duration_sec || 60) + 5) * 1000
    setTimeout(finish, wallCap)

    const draw = () => {
      if (done) return
      ctx.drawImage(baseVideo, 0, 0, W, H)
      const t = baseVideo.currentTime

      for (let i = 0; i < vaps.length; i++) {
        const v = vaps[i]
        if (t >= v.offset && t < v.offset + v.durSec + 0.1) {
          if (!vapStarted[i]) {
            v.video.currentTime = Math.max(0, t - v.offset)
            v.video.play().catch(() => { /* ignore */ })
            vapStarted[i] = true
          }
          drawVapFrame(ctx, v, W, H)
        }
      }

      const dur = baseVideo.duration || meta.duration_sec
      if (dur > 0) onProgress?.({ stage: 'recording', ratio: Math.min(1, t / dur) })

      // Explicitly catch EOF — rVFC won't fire again once no more frames decode.
      if (baseVideo.ended || (dur > 0 && t >= dur - 0.05)) {
        finish()
        return
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rvfc = (baseVideo as any).requestVideoFrameCallback?.bind(baseVideo)
      if (rvfc) rvfc(draw)
      else requestAnimationFrame(draw)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rvfc = (baseVideo as any).requestVideoFrameCallback?.bind(baseVideo)
    if (rvfc) rvfc(draw)
    else requestAnimationFrame(draw)
  })

  onProgress?.({ stage: 'finalizing' })
  recorder.requestData()
  recorder.stop()
  await stopped

  // Cleanup.
  URL.revokeObjectURL(baseUrl)
  vaps.forEach((v) => URL.revokeObjectURL(v.url))

  return new Blob(chunks, { type: recorder.mimeType || 'video/webm' })
}

// Composite one VAP frame: alpha half masks the RGB half. We do it by reading
// both pixel regions, multiplying the alpha channel, and drawing the result
// onto the main canvas at the correct position.
function drawVapFrame(
  mainCtx: CanvasRenderingContext2D,
  v: LoadedVap,
  W: number,
  _H: number,
) {
  const { video, tmp, tmpCtx, info } = v
  const [rx, ry, rw, rh] = info.rgbFrame
  const [ax, ay, aw, ah] = info.aFrame

  tmpCtx.globalCompositeOperation = 'source-over'
  tmpCtx.clearRect(0, 0, info.w, info.h)
  tmpCtx.drawImage(video, rx, ry, rw, rh, 0, 0, info.w, info.h)
  const rgbData = tmpCtx.getImageData(0, 0, info.w, info.h)

  tmpCtx.clearRect(0, 0, info.w, info.h)
  tmpCtx.drawImage(video, ax, ay, aw, ah, 0, 0, info.w, info.h)
  const alphaData = tmpCtx.getImageData(0, 0, info.w, info.h)

  const out = rgbData.data
  const al = alphaData.data
  for (let p = 0; p < out.length; p += 4) {
    // Use red channel as luminance proxy (alpha frames are grayscale).
    out[p + 3] = al[p]
  }
  tmpCtx.putImageData(rgbData, 0, 0)

  // Scale to full width of main canvas. Keep VAP's aspect ratio. Position
  // roughly below the middle of the base (matches the old ffmpeg y=50 at 480p).
  const targetW = W
  const targetH = Math.round((info.h * targetW) / info.w)
  const targetY = Math.round(_H * 0.15)
  mainCtx.drawImage(tmp, 0, targetY, targetW, targetH)
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}
