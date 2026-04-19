// Compose a recorded base mp4 with one or more VAP (alpha+rgb side-by-side)
// gift animations in the browser via Canvas + MediaRecorder. The server used
// to do this with ffmpeg, but on our 256MB VM the re-encode kept getting
// OOM-killed. Offloading to the user's browser sidesteps that entirely.

import type { LiveEvent, GiftUser } from '../types'
import { generateGiftCard } from './giftCard'

// Fixed output dimensions — the rest of the canvas is filled with the
// streamer's avatar (blurred) when the base aspect ratio doesn't match.
const OUT_W = 430
const OUT_H = 932
const OUT_ASPECT = OUT_W / OUT_H

// Delay the gift animation + card overlay this many seconds past the raw
// trigger time so the overlay has a moment to breathe before the big effect.
const GIFT_START_OFFSET_SEC = 0.5

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
    num?: number
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
  /** 0 = not started, 1 = starting, 2 = playing, 3 = failed (skip drawing) */
  state: 0 | 1 | 2 | 3
  /** 已经重试了几次 play() */
  retries: number
}

async function loadVideo(src: string): Promise<HTMLVideoElement> {
  const v = document.createElement('video')
  v.src = src
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  await new Promise<void>((resolve, reject) => {
    v.addEventListener('loadedmetadata', () => resolve(), { once: true })
    v.addEventListener('error', () => reject(new Error('视频加载失败')), { once: true })
  })
  return v
}

// B站 CDN 都带 Access-Control-Allow-Origin: *，配上 referrerPolicy:'no-referrer'
// 就能直连（CDN 对非 bilibili Referer 返 403）。
const NO_REF: RequestInit = { referrerPolicy: 'no-referrer' }

export interface ComposeProgress {
  stage: 'downloading' | 'loading' | 'recording' | 'finalizing'
  ratio?: number
}

// Build a minimal GiftUser from a gift/guard event so we can reuse the
// giftCard.ts renderer for the in-clip overlay card.
function giftUserFromEvent(ev: LiveEvent): GiftUser | null {
  const extra = ev.extra || {}
  const isGuard = ev.event_type === 'guard'
  const name = isGuard
    ? (extra.guard_name || '舰长')
    : (extra.gift_name || ev.content || '礼物')
  const num = extra.num || 1
  const coin = isGuard
    ? ((extra.price || 0) * num)
    : (extra.total_coin || (extra.price || 0) * num || 0)
  const action = extra.blind_name ? `投喂 ${extra.blind_name} 爆出` : (extra.action || '投喂')
  return {
    user_name: ev.user_name || '',
    avatar: extra.avatar || '',
    gifts: { [name]: num },
    gift_imgs: extra.gift_img ? { [name]: extra.gift_img } : {},
    gift_actions: { [name]: action },
    gift_coins: { [name]: coin },
    gift_ids: extra.gift_id ? { [name]: extra.gift_id } : {},
    guard_level: extra.guard_level || 0,
    total_coin: coin,
  }
}

// Single-line text strip for the bottom mirror card: just "用户名 投喂 礼物名".
// Rendered lazily per frame (not a static canvas) so we can marquee-scroll
// the text if it overflows the 70%-of-viewport pill width.
interface SmallCardSegment {
  text: string
  color: string
}
interface SmallCardSpec {
  segments: SmallCardSegment[]
  font: string
  fontSize: number
  padX: number
  padY: number
  textW: number       // total rendered width across all segments
  h: number
  bgColor: string
  bgImage: HTMLImageElement | null   // matches the main card's tier gradient
  avatar: HTMLImageElement | null
  avatarSize: number
  avatarGap: number
}

async function buildSmallCardSpec(ev: LiveEvent): Promise<SmallCardSpec | null> {
  const extra = ev.extra || {}
  const isGuard = ev.event_type === 'guard'
  const giftName = isGuard
    ? (extra.guard_name || '舰长')
    : (extra.gift_name || ev.content || '礼物')
  const fontSize = 14
  const font = `600 ${fontSize}px -apple-system, "PingFang SC", sans-serif`
  const padX = 12
  const padY = 6
  const WHITE = '#fff'
  const YELLOW = '#FFF176'  // brighter than the B站 reference; pops on gold pill
  const segments: SmallCardSegment[] = []
  const userName = ev.user_name || ''
  if (isGuard) {
    segments.push({ text: userName, color: YELLOW })
    segments.push({ text: ' 开通 ', color: WHITE })
    segments.push({ text: giftName, color: WHITE })
  } else if (extra.blind_name) {
    segments.push({ text: userName, color: YELLOW })
    segments.push({ text: ' 投喂 ', color: WHITE })
    segments.push({ text: extra.blind_name, color: WHITE })
    segments.push({ text: ' 爆出 ', color: WHITE })
    segments.push({ text: giftName, color: WHITE })
  } else {
    segments.push({ text: userName, color: YELLOW })
    segments.push({ text: ' 投喂 ', color: WHITE })
    segments.push({ text: giftName, color: WHITE })
  }
  const meas = document.createElement('canvas').getContext('2d')!
  meas.font = font
  let textW = 0
  for (const s of segments) textW += Math.ceil(meas.measureText(s.text).width)
  // Clips only trigger for unit price ≥ ¥1000 (10000 电池), so the pill
  // always uses the gold tier. Fallback colour mirrors the gold PNG.
  const bgColor = 'rgba(198, 138, 56, 0.85)'
  const bgImage = await new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = '/static/card_tpl_gold.png'
  })
  const avatar = extra.avatar ? await new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.referrerPolicy = 'no-referrer'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = extra.avatar!
  }) : null
  const avatarSize = fontSize + padY * 2 - 6   // inset from pill height so it clearly sits inside the rounded cap
  const avatarGap = 6
  return {
    segments, font, fontSize, padX, padY, textW,
    h: fontSize + padY * 2, bgColor, bgImage,
    avatar, avatarSize, avatarGap,
  }
}

function drawPillPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = h / 2
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2)
  ctx.lineTo(x + r, y + h)
  ctx.arc(x + r, y + r, r, Math.PI / 2, -Math.PI / 2)
  ctx.closePath()
}


export async function composeClipInBrowser(
  roomId: number,
  name: string,
  event?: LiveEvent | null,
  backdropUrl?: string,
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

  const rawVapAssets = await Promise.all(
    overlays.map(async (ov) => {
      const [mp4Blob, info] = await Promise.all([
        fetch(ov.vap_mp4!, NO_REF).then((r) => r.blob()),
        fetch(ov.vap_json!, NO_REF)
          .then((r) => r.json())
          .then((j) => (j.info || j) as VapSidecarInfo),
      ])
      return {
        mp4Blob,
        info,
        offset: ov.offset_sec + GIFT_START_OFFSET_SEC,
        num: Math.max(1, ov.num || 1),
      }
    }),
  )

  // Bilibili plays the special-effect once per gift, even for combos —
  // a 浪漫城堡 x2 yields two effect plays on stream. Replicate each
  // overlay `num` times back-to-back, staggered by the VAP duration so
  // copies don't visually stack.
  const vapAssets = rawVapAssets.flatMap((a) => {
    const dur = a.info.fps ? a.info.f / a.info.fps : 12
    return Array.from({ length: a.num }, (_, i) => ({
      mp4Blob: a.mp4Blob,
      info: a.info,
      offset: a.offset + i * dur,
    }))
  })

  onProgress?.({ stage: 'loading' })

  const baseUrl = URL.createObjectURL(baseBlob)
  const baseVideo = await loadVideo(baseUrl)
  const srcW = baseVideo.videoWidth
  const srcH = baseVideo.videoHeight

  // Compute base placement on a fixed OUT_W×OUT_H canvas.
  //   • Portrait source (H > W): always cover-fit — scale to fill and crop
  //     the sides. Both OUT and the source are portrait, so sacrificing a
  //     little horizontal content beats a blurred backdrop.
  //   • Landscape source: letterbox with the blurred backdrop.
  const srcAspect = srcW / srcH
  const isPortraitSrc = srcAspect < 1
  const fitMode: 'cover' | 'contain' = isPortraitSrc ? 'cover' : 'contain'
  let baseDx = 0, baseDy = 0, baseDw = OUT_W, baseDh = OUT_H
  if (fitMode === 'cover') {
    // Scale to fill both dimensions; whichever dim ends up larger gets cropped.
    if (srcAspect > OUT_ASPECT) {
      // Source is wider than target — fit height, overflow width (crop sides).
      baseDh = OUT_H
      baseDw = Math.round(OUT_H * srcAspect)
      baseDx = Math.round((OUT_W - baseDw) / 2)
    } else {
      // Source narrower than target — fit width, overflow height (crop top/bottom).
      baseDw = OUT_W
      baseDh = Math.round(OUT_W / srcAspect)
      baseDy = Math.round((OUT_H - baseDh) / 2)
    }
  } else {
    // Landscape into portrait — letterbox with backdrop.
    baseDw = OUT_W
    baseDh = Math.round(OUT_W / srcAspect)
    // Shift up ~10% so the VAP (pinned near top) lands on the live picture,
    // not the bottom backdrop gutter.
    baseDy = Math.max(0, Math.round((OUT_H - baseDh) / 2 - OUT_H * 0.15))
  }

  // Load the streamer avatar for the backdrop once, if we need one.
  let bgImg: HTMLImageElement | null = null
  if (fitMode === 'contain' && backdropUrl) {
    bgImg = await new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.referrerPolicy = 'no-referrer'
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = backdropUrl
    })
  }

  // Pre-render the backdrop to its own canvas so we don't re-blur per frame.
  const bgCanvas = document.createElement('canvas')
  bgCanvas.width = OUT_W
  bgCanvas.height = OUT_H
  const bgCtx = bgCanvas.getContext('2d', { alpha: false })!
  if (bgImg) {
    // Cover-fit the background image.
    const iAspect = bgImg.naturalWidth / bgImg.naturalHeight
    let iw = OUT_W, ih = OUT_H, ix = 0, iy = 0
    if (iAspect > OUT_ASPECT) { iw = Math.round(OUT_H * iAspect); ix = Math.round((OUT_W - iw) / 2) }
    else { ih = Math.round(OUT_W / iAspect); iy = Math.round((OUT_H - ih) / 2) }
    bgCtx.drawImage(bgImg, ix, iy, iw, ih)
  } else {
    // Solid dark fill — matches the B站 H5 default when an anchor hasn't set
    // an app_background.
    bgCtx.fillStyle = '#17181c'
    bgCtx.fillRect(0, 0, OUT_W, OUT_H)
  }

  // iOS Safari 同时最多几个 <video> 解码，超了 play() 就静默失败。
  // 同一个 combo（"浪漫城堡 x3"）里 vapAssets 共享同一个 mp4Blob 但 offset 不同 ——
  // 按 blob 复用一个 <video> 元素，combo 就压到 1 个 video；真正并发的只有
  // 不同礼物的叠加情况。也顺便省内存（一个 URL 一份解码缓存）。
  const videoCache = new Map<Blob, { video: HTMLVideoElement; url: string }>()
  async function videoForBlob(blob: Blob): Promise<{ video: HTMLVideoElement; url: string }> {
    const hit = videoCache.get(blob)
    if (hit) return hit
    const url = URL.createObjectURL(blob)
    const video = await loadVideo(url)
    const entry = { video, url }
    videoCache.set(blob, entry)
    return entry
  }

  const vaps: LoadedVap[] = await Promise.all(
    vapAssets.map(async (a) => {
      const { video, url } = await videoForBlob(a.mp4Blob)
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
        state: 0 as const,
        retries: 0,
      }
    }),
  )

  // Pre-render the gift card strip (if the caller passed an event). We'll
  // overlay it at the bottom once playback reaches the trigger offset.
  let cardCanvas: HTMLCanvasElement | null = null
  let smallCardSpec: SmallCardSpec | null = null
  let cardStart = 0
  if (event) {
    const u = giftUserFromEvent(event)
    if (u) {
      try {
        const c = document.createElement('canvas')
        await generateGiftCard(c, u)
        cardCanvas = c
        smallCardSpec = await buildSmallCardSpec(event)
        // Match the 0.5s gift-animation delay so the card appears with it.
        cardStart = vaps[0]?.offset ?? (overlays[0]?.offset_sec ?? 0)
      } catch { /* non-fatal — just skip card overlay */ }
    }
  }

  // 2. Main canvas + capture stream.
  const canvas = document.createElement('canvas')
  canvas.width = OUT_W
  canvas.height = OUT_H
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
  // play() 在手机上可能被 iOS 拒绝（并发 <video> 解码上限、内存压力、
  // 没有 user-gesture 链等），不处理的话 video 停在第 0 帧、drawVapFrame
  // 每帧画冻结画面 = 用户感知的"VAP 卡住"。这里统一用状态机管理生命周期。
  const MAX_PLAY_RETRIES = 2
  function tryPlayVap(v: LoadedVap, seekSec: number) {
    v.state = 1
    v.video.currentTime = seekSec
    v.video.play().then(() => {
      v.state = 2
    }).catch((e) => {
      if (v.retries < MAX_PLAY_RETRIES) {
        v.retries += 1
        // 短延迟后重试：iOS 的并发上限是瞬时的，隔一帧可能就空出来
        setTimeout(() => { if (v.state === 1) tryPlayVap(v, seekSec) }, 80)
      } else {
        v.state = 3
        console.warn('VAP play() 失败，跳过该特效', e)
      }
    })
  }

  // 页面切出后 baseVideo 会暂停、rAF 也降到 1Hz，合成会僵住。手机上
  // 尤其常见。直接中止并让上层提示用户保持前台。
  let abortedByVisibility = false
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') abortedByVisibility = true
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  // Hoisted per-composition constants — don't recompute these every frame.
  const FADE = 0.4
  const CARD_MAX_ALPHA = 0.85
  const SMALL_DUR = 13
  const MAIN_DUR = Math.max(0, (baseVideo.duration || Infinity) - cardStart)
  // Main card geometry is constant across frames (cardCanvas doesn't resize).
  let mainTargetW = 0, mainTargetH = 0, mainFinalX = 0, mainY = 0
  if (cardCanvas) {
    mainTargetW = Math.round(OUT_W * 0.65)
    mainTargetH = Math.round(cardCanvas.height * (mainTargetW / cardCanvas.width))
    mainFinalX = Math.round(OUT_W * 0.03)
    // Landscape source: card in the gutter below the base video.
    // Portrait: 10% below center on top of the video.
    mainY = fitMode === 'contain'
      ? baseDy + baseDh + 8
      : Math.round((OUT_H - mainTargetH) / 2 + OUT_H * 0.10)
  }
  // Small pill geometry is also constant (text/avatar widths fixed).
  let pillW = 0, pillH = 0, pillX = 0, pillY = 0, avatarSlot = 0
  if (smallCardSpec) {
    avatarSlot = smallCardSpec.avatarSize + smallCardSpec.avatarGap
    const natural = smallCardSpec.textW + smallCardSpec.padX * 2 + avatarSlot
    pillW = Math.min(natural, Math.round(OUT_W * 0.7))
    pillH = smallCardSpec.h
    pillX = Math.round((OUT_W - pillW) / 2)
    pillY = OUT_H - pillH - 60
  }

  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }

    // Belt-and-braces termination: rVFC stops firing at EOF, decoder may
    // stall on a bad frame. Listen for ended/error and hard-cap wall-clock.
    baseVideo.addEventListener('ended', finish, { once: true })
    baseVideo.addEventListener('error', finish, { once: true })
    const wallCap = ((baseVideo.duration || meta.duration_sec || 60) + 5) * 1000
    setTimeout(finish, wallCap)

    const draw = () => {
      if (done) return
      if (abortedByVisibility) { finish(); return }
      if (fitMode === 'contain') ctx.drawImage(bgCanvas, 0, 0)
      ctx.drawImage(baseVideo, baseDx, baseDy, baseDw, baseDh)
      const t = baseVideo.currentTime
      const cardElapsed = t - cardStart

      // Main card — slide in from off-screen left during FADE, hold until
      // video end, fade out last FADE seconds. Drawn BEFORE the VAP so
      // particles visibly burst over it.
      if (cardCanvas && cardElapsed >= 0 && cardElapsed < MAIN_DUR) {
        const slideEase = 1 - Math.pow(1 - Math.min(1, cardElapsed / FADE), 3)
        const x = Math.round(-mainTargetW + (mainFinalX + mainTargetW) * slideEase)
        const fadeAlpha = cardElapsed > MAIN_DUR - FADE
          ? (MAIN_DUR - cardElapsed) / FADE
          : 1
        ctx.save()
        ctx.globalAlpha = Math.max(0, Math.min(1, fadeAlpha)) * CARD_MAX_ALPHA
        ctx.drawImage(cardCanvas, x, mainY, mainTargetW, mainTargetH)
        ctx.restore()
      }

      // Bottom pill — independent 13s lifetime. Scroll-unfurl entrance,
      // marquee-scroll text if it overflows the 70%-of-viewport cap.
      if (smallCardSpec && cardElapsed >= 0 && cardElapsed < SMALL_DUR) {
        const revealEase = 1 - Math.pow(1 - Math.min(1, cardElapsed / FADE), 3)
        const revealW = Math.round(pillW * revealEase)
        const smallAlpha = cardElapsed > SMALL_DUR - FADE
          ? (SMALL_DUR - cardElapsed) / FADE
          : 1
        ctx.save()
        ctx.globalAlpha = Math.max(0, Math.min(1, smallAlpha)) * CARD_MAX_ALPHA
        // Outer clip: unfurl rect. Caps how much of the pill is visible.
        ctx.beginPath()
        ctx.rect(pillX, pillY, revealW, pillH)
        ctx.clip()

        // Pill background: sample a 1px-tall middle strip of the gradient
        // PNG and stretch it into the pill. Squishing the tall card image
        // vertically distorts the gradient across the rounded caps;
        // sampling a thin strip keeps verticals uniform so the semicircles
        // look clean. Solid tier colour is the fallback.
        ctx.save()
        drawPillPath(ctx, pillX, pillY, pillW, pillH)
        ctx.clip()
        if (smallCardSpec.bgImage) {
          const img = smallCardSpec.bgImage
          const midY = Math.floor(img.naturalHeight / 2)
          ctx.drawImage(img, 0, midY, img.naturalWidth, 1, pillX, pillY, pillW, pillH)
        } else {
          ctx.fillStyle = smallCardSpec.bgColor
          ctx.fillRect(pillX, pillY, pillW, pillH)
        }
        ctx.restore()

        // Avatar — circular, inset so the whole disc lives inside the
        // pill's left semicircle with visible padding. Falls back to a
        // placeholder disc with the user's first initial.
        {
          const as = smallCardSpec.avatarSize
          const ax = pillX + (pillH - as) / 2 + 2
          const ay = pillY + (pillH - as) / 2
          ctx.save()
          ctx.beginPath()
          ctx.arc(ax + as / 2, ay + as / 2, as / 2, 0, Math.PI * 2)
          ctx.clip()
          if (smallCardSpec.avatar) {
            ctx.drawImage(smallCardSpec.avatar, ax, ay, as, as)
          } else {
            ctx.fillStyle = 'rgba(255,255,255,0.25)'
            ctx.fillRect(ax, ay, as, as)
            const firstChar = (event?.user_name || '?').trim().charAt(0) || '?'
            ctx.fillStyle = '#fff'
            ctx.font = `700 ${Math.round(as * 0.55)}px -apple-system, "PingFang SC", sans-serif`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(firstChar, ax + as / 2, ay + as / 2 + 1)
            ctx.textAlign = 'start'
          }
          ctx.restore()
        }

        // Text. Single line, multi-coloured segments. Wait until the
        // unfurl finishes before the marquee kicks in so entrance stays clean.
        ctx.font = smallCardSpec.font
        ctx.textBaseline = 'middle'
        const textInnerLeft = pillX + smallCardSpec.padX + avatarSlot
        const textInnerRight = pillX + pillW - smallCardSpec.padX
        const textBaselineY = pillY + pillH / 2
        const drawSegments = (startX: number) => {
          let cursor = startX
          for (const s of smallCardSpec!.segments) {
            ctx.fillStyle = s.color
            ctx.fillText(s.text, cursor, textBaselineY)
            cursor += ctx.measureText(s.text).width
          }
        }
        if (smallCardSpec.textW <= textInnerRight - textInnerLeft) {
          drawSegments(textInnerLeft)
        } else {
          ctx.save()
          ctx.beginPath()
          ctx.rect(textInnerLeft, pillY, textInnerRight - textInnerLeft, pillH)
          ctx.clip()
          const cycleW = smallCardSpec.textW + 40  // text + gap
          const scrollT = Math.max(0, cardElapsed - FADE)
          const offset = (scrollT * 30) % cycleW   // 30 px/sec
          drawSegments(textInnerLeft - offset)
          drawSegments(textInnerLeft - offset + cycleW)
          ctx.restore()
        }
        ctx.restore()
      }

      for (let i = 0; i < vaps.length; i++) {
        const v = vaps[i]
        if (t >= v.offset && t < v.offset + v.durSec + 0.1) {
          if (v.state === 0) {
            // 同一 combo 里多份 VAP 共享一个 <video>；前一份还在 playing 时
            // 别打断它（0.1s 的时间窗重叠容忍度导致）。等它自然结束再启动。
            // 只看窗口还没结束的 sibling。超过 offset+durSec 的已经自然播完了，
            // state 虽还停在 2 但 video 已到 ended，不会再占用。
            const siblingBusy = vaps.some((w) => (
              w !== v && w.video === v.video
              && (w.state === 1 || w.state === 2)
              && t < w.offset + w.durSec
            ))
            if (!siblingBusy) tryPlayVap(v, Math.max(0, t - v.offset))
          }
          // 只有 play() 真正进入 playing 状态（state=2）才画 —— state=1 期间
          // video 还是暂停的，画出来是冻结帧；state=3 是放弃，跳过。
          if (v.state === 2 && !v.video.paused) {
            drawVapFrame(ctx, v)
          }
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
  document.removeEventListener('visibilitychange', onVisibilityChange)
  URL.revokeObjectURL(baseUrl)
  // videoCache 里每个 blob 对应一个 url；vaps 里的 url 是去重前的副本。
  for (const { url } of videoCache.values()) URL.revokeObjectURL(url)

  if (abortedByVisibility) {
    throw new Error('页面切到后台导致合成中断，请保持前台再试一次')
  }
  return new Blob(chunks, { type: recorder.mimeType || 'video/webm' })
}

// Composite one VAP frame: alpha half masks the RGB half. We read both
// pixel regions, copy the alpha channel (as luminance) onto the RGB half,
// and draw the result anchored to the OUT canvas at a fixed position.
function drawVapFrame(mainCtx: CanvasRenderingContext2D, v: LoadedVap) {
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

  // Anchor to the OUT canvas so the effect appears in the same spot no
  // matter the base fit mode. ~15% down from the top, full output width.
  const targetW = OUT_W
  const targetH = Math.round((info.h * targetW) / info.w)
  const targetY = Math.round(OUT_H * 0.15)
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
