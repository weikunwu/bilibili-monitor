import { parseGIF, decompressFrames } from 'gifuct-js'
import { quantize } from 'gifenc'
import { GifWriter } from 'omggif'

// Floyd–Steinberg dither: returns indexed pixels matched to `palette`.
function ditherFS(rgba: Uint8ClampedArray, w: number, h: number, palette: number[][], transparentIndex = -1): Uint8Array {
  // Work on a mutable float buffer so error diffusion can push values out of [0,255].
  const buf = new Float32Array(rgba.length)
  for (let i = 0; i < rgba.length; i++) buf[i] = rgba[i]
  const out = new Uint8Array(w * h)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      // Use the ORIGINAL alpha (not the error-diffused one) to decide transparency.
      if (transparentIndex >= 0 && rgba[i + 3] < 128) {
        out[y * w + x] = transparentIndex
        continue
      }
      const r = buf[i], g = buf[i + 1], b = buf[i + 2]
      // Find nearest palette entry, skipping the reserved transparent slot.
      let bestIdx = transparentIndex === 0 ? 1 : 0, bestD = Infinity
      for (let p = 0; p < palette.length; p++) {
        if (p === transparentIndex) continue
        const pr = palette[p][0], pg = palette[p][1], pb = palette[p][2]
        const dr = r - pr, dg = g - pg, db = b - pb
        const d = dr * dr + dg * dg + db * db
        if (d < bestD) { bestD = d; bestIdx = p }
      }
      out[y * w + x] = bestIdx
      const er = r - palette[bestIdx][0]
      const eg = g - palette[bestIdx][1]
      const eb = b - palette[bestIdx][2]
      // Distribute error: 7/16 right, 3/16 bottom-left, 5/16 bottom, 1/16 bottom-right.
      if (x + 1 < w) {
        const j = i + 4
        buf[j] += er * 7 / 16; buf[j + 1] += eg * 7 / 16; buf[j + 2] += eb * 7 / 16
      }
      if (y + 1 < h) {
        if (x > 0) {
          const j = i + (w - 1) * 4
          buf[j] += er * 3 / 16; buf[j + 1] += eg * 3 / 16; buf[j + 2] += eb * 3 / 16
        }
        const j = i + w * 4
        buf[j] += er * 5 / 16; buf[j + 1] += eg * 5 / 16; buf[j + 2] += eb * 5 / 16
        if (x + 1 < w) {
          const k = i + (w + 1) * 4
          buf[k] += er / 16; buf[k + 1] += eg / 16; buf[k + 2] += eb / 16
        }
      }
    }
  }
  return out
}
import type { GiftUser, GiftGifItem } from '../types'
import { GUARD_FRAME_URLS, CARD_TPL_URLS } from './constants'
import { getProxyImageUrl } from './formatters'

export type { GiftGifItem }

function loadImage(src: string, proxy = false): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return }
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = proxy ? getProxyImageUrl(src) : src
  })
}

async function fetchGifFrames(gifUrl: string) {
  const resp = await fetch(getProxyImageUrl(gifUrl))
  const buf = await resp.arrayBuffer()
  const gif = parseGIF(buf)
  const frames = decompressFrames(gif, true)
  if (!frames.length) return null

  const W = frames[0].dims.width as number
  const H = frames[0].dims.height as number
  // Compose frames accounting for GIF disposal.
  const full = document.createElement('canvas')
  full.width = W
  full.height = H
  const fctx = full.getContext('2d')!

  const patchCanvas = document.createElement('canvas')
  const pctx = patchCanvas.getContext('2d')!

  const composed: { canvas: HTMLCanvasElement; delay: number }[] = []
  let prev: ImageData | null = null

  for (const fr of frames) {
    const { top, left, width, height } = fr.dims
    const saved = fctx.getImageData(0, 0, W, H)

    patchCanvas.width = width
    patchCanvas.height = height
    const imgData = new ImageData(new Uint8ClampedArray(fr.patch), width, height)
    pctx.putImageData(imgData, 0, 0)
    fctx.drawImage(patchCanvas, left, top)

    const out = document.createElement('canvas')
    out.width = W
    out.height = H
    out.getContext('2d')!.drawImage(full, 0, 0)
    composed.push({ canvas: out, delay: fr.delay || 100 })

    if (fr.disposalType === 2) {
      fctx.clearRect(left, top, width, height)
    } else if (fr.disposalType === 3 && prev) {
      fctx.putImageData(prev, 0, 0)
    } else {
      prev = saved
    }
  }
  return composed
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  u: GiftUser,
  giftName: string,
  tpl: HTMLImageElement | null,
  avatar: HTMLImageElement | null,
  guardFrame: HTMLImageElement | null,
  giftFrame: HTMLCanvasElement,
  W: number,
  H: number,
  numScale: number = 1,
) {
  ctx.clearRect(0, 0, W, H)
  if (tpl) ctx.drawImage(tpl, 0, 0, W, H)

  const acx = 36
  const acy = H / 2
  const ar = 28
  const frameSize = 78

  if (avatar) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(acx, acy, ar, 0, Math.PI * 2)
    ctx.clip()
    ctx.drawImage(avatar, acx - ar, acy - ar, ar * 2, ar * 2)
    ctx.restore()
  } else {
    ctx.fillStyle = '#2a4a7a'
    ctx.beginPath()
    ctx.arc(acx, acy, ar, 0, Math.PI * 2)
    ctx.fill()
  }

  if (guardFrame) {
    ctx.drawImage(guardFrame, acx - frameSize / 2, acy - frameSize / 2, frameSize, frameSize)
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(acx, acy, ar + 2, 0, Math.PI * 2)
    ctx.stroke()
  }

  ctx.shadowColor = 'rgba(0,0,0,0.4)'
  ctx.shadowOffsetX = 1
  ctx.shadowOffsetY = 1
  ctx.shadowBlur = 3

  const tx = guardFrame ? acx + 46 : acx + ar + 14
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 20px -apple-system, "PingFang SC", sans-serif'
  ctx.fillText(u.user_name, tx, 29)

  const action = (u.gift_actions || {})[giftName] || '投喂'
  const isBlind = action.includes('爆出')
  let drawX = tx

  if (isBlind) {
    const parts = action.split(' 爆出')
    ctx.fillStyle = '#ffe066'
    ctx.font = 'bold 15px -apple-system, "PingFang SC", sans-serif'
    ctx.fillText(parts[0], drawX, 52)
    drawX += ctx.measureText(parts[0]).width
    ctx.fillStyle = '#ffffff'
    ctx.font = '15px -apple-system, "PingFang SC", sans-serif'
    ctx.fillText(' 爆出 ', drawX, 52)
    drawX += ctx.measureText(' 爆出 ').width
  } else {
    ctx.fillStyle = '#ffffff'
    ctx.font = '15px -apple-system, "PingFang SC", sans-serif'
    ctx.fillText(action + ' ', drawX, 52)
    drawX += ctx.measureText(action + ' ').width
  }

  ctx.fillStyle = '#ffe066'
  ctx.font = 'bold 16px -apple-system, "PingFang SC", sans-serif'
  ctx.fillText(giftName, drawX, 52)

  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0

  const gSize = 72
  const rightStart = W * 0.59
  ctx.drawImage(giftFrame, rightStart, (H - gSize) / 2, gSize, gSize)

  const num = u.gifts[giftName] || 0
  const numY = H * 0.5 + 11
  const numStartX = rightStart + gSize

  ctx.font = 'italic 800 30px "Baloo 2", -apple-system, sans-serif'
  ctx.strokeStyle = '#bc6e2d'
  ctx.lineJoin = 'round'

  // Pulse the whole "x N" by scaling around the left anchor.
  ctx.save()
  ctx.translate(numStartX, numY)
  ctx.scale(numScale, numScale)
  ctx.lineWidth = 3
  ctx.strokeText('x ', 0, 0)
  ctx.fillStyle = '#fff505'
  ctx.fillText('x ', 0, 0)
  const xW = ctx.measureText('x ').width
  ctx.lineWidth = 5
  ctx.strokeText(String(num), xW, 0)
  ctx.fillStyle = '#fff505'
  ctx.fillText(String(num), xW, 0)
  ctx.fillText(String(num), xW + 0.5, 0)
  ctx.fillText(String(num), xW - 0.5, 0)
  ctx.restore()
}


type RowRes = {
  u: GiftUser
  giftName: string
  tpl: HTMLImageElement | null
  avatar: HTMLImageElement | null
  guardFrame: HTMLImageElement | null
  frames: { canvas: HTMLCanvasElement; delay: number }[]
}

export async function generateGiftGif(items: GiftGifItem[]): Promise<Blob | null> {
  if (!items.length) return null
  try { await document.fonts.load('italic 800 30px "Baloo 2"') } catch { /* ok */ }

  // Load assets + decode gifs for every row in parallel.
  const loaded = await Promise.all(items.map(async ({ u, giftName }): Promise<RowRes | null> => {
    const gifUrl = (u.gift_gifs || {})[giftName]
    if (!gifUrl) return null
    const battery = (u.gift_coins || {})[giftName] || 0
    const tplKey = battery >= 10000 ? 'gold' : battery >= 5000 ? 'pink' : battery >= 1000 ? 'purple' : 'blue'
    const [tpl, avatar, guardFrame, frames] = await Promise.all([
      loadImage(CARD_TPL_URLS[tplKey]),
      loadImage(u.avatar || '', true),
      u.guard_level > 0 ? loadImage(GUARD_FRAME_URLS[u.guard_level]) : Promise.resolve(null),
      fetchGifFrames(gifUrl),
    ])
    if (!frames || !frames.length) return null
    return { u, giftName, tpl, avatar, guardFrame, frames }
  }))
  const rows = loaded.filter((r): r is RowRes => r !== null)
  if (!rows.length) return null

  const W = 480
  const H = 74
  const GAP = 6
  const dpr = 2
  const N = rows.length
  const rowY: number[] = []
  for (let i = 0; i < N; i++) rowY.push(i * (H + GAP))
  const totalH = N * H + (N - 1) * GAP
  const canvas = document.createElement('canvas')
  canvas.width = W * dpr
  canvas.height = totalH * dpr
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)

  // Right-half region (gift image + "x N" count) across all stacked rows.
  const gx = Math.round(W * 0.6) * dpr
  const gy = 0
  const gw = (W * dpr) - gx
  const gh = totalH * dpr

  const FW = canvas.width
  const FH = canvas.height

  // Unified frame count: whatever the longest row needs. Each row loops
  // independently by mapping output index → src index via proportional floor.
  const F = Math.max(...rows.map((r) => r.frames.length))

  const renderedFrames: { full: ImageData; patch: ImageData; delay: number }[] = []
  for (let i = 0; i < F; i++) {
    const t = i / Math.max(1, F - 1)
    const numScale = 1 + 0.35 * Math.sin(Math.PI * t)
    for (let r = 0; r < N; r++) {
      const row = rows[r]
      const srcIdx = Math.floor((i * row.frames.length) / F)
      ctx.save()
      ctx.translate(0, rowY[r])
      drawCard(ctx, row.u, row.giftName, row.tpl, row.avatar, row.guardFrame, row.frames[srcIdx].canvas, W, H, numScale)
      ctx.restore()
    }
    // Delay: use row 0's current source frame delay.
    const r0 = rows[0]
    const r0Idx = Math.floor((i * r0.frames.length) / F)
    const delay = r0.frames[r0Idx].delay || 100
    renderedFrames.push({
      full: ctx.getImageData(0, 0, FW, FH),
      patch: ctx.getImageData(gx, gy, gw, gh),
      delay,
    })
  }

  // Collect only OPAQUE pixels for palette sampling — transparent pixels would
  // waste palette slots on black and also pull the gradient palette darker.
  const fullPx = renderedFrames[0].full.data
  const patchTotalPx = gw * gh * (renderedFrames.length - 1)
  const sample = new Uint8ClampedArray((FW * FH + patchTotalPx) * 4)
  let o = 0
  for (let i = 0; i < fullPx.length; i += 4) {
    if (fullPx[i + 3] >= 128) {
      sample[o++] = fullPx[i]; sample[o++] = fullPx[i + 1]; sample[o++] = fullPx[i + 2]; sample[o++] = 255
    }
  }
  for (let f = 1; f < renderedFrames.length; f++) {
    const p = renderedFrames[f].patch.data
    for (let i = 0; i < p.length; i += 4) {
      if (p[i + 3] >= 128) {
        sample[o++] = p[i]; sample[o++] = p[i + 1]; sample[o++] = p[i + 2]; sample[o++] = 255
      }
    }
  }
  const opaqueSample = sample.slice(0, o)

  // Reserve palette[0] for the transparent color; quantize the rest to 255.
  const rawPalette = quantize(opaqueSample, 255, { format: 'rgb565' })
  const palette: number[][] = [[0, 0, 0], ...rawPalette]
  let palSize = 2
  while (palSize < palette.length) palSize *= 2
  while (palette.length < palSize) palette.push([0, 0, 0])
  const TRANSPARENT = 0

  const bufSize = FW * FH + gw * gh * (renderedFrames.length - 1) + 16384
  const buf = new Uint8Array(bufSize)
  const writer = new GifWriter(buf, FW, FH, {
    loop: 0,
    palette: palette.map((c) => (c[0] << 16) | (c[1] << 8) | c[2]),
  })

  for (let i = 0; i < renderedFrames.length; i++) {
    const { full, patch, delay } = renderedFrames[i]
    const ds = Math.max(1, Math.round(delay / 10))
    if (i === 0) {
      const idx = ditherFS(full.data, FW, FH, palette, TRANSPARENT)
      writer.addFrame(0, 0, FW, FH, idx, { delay: ds, disposal: 1, transparent: TRANSPARENT })
    } else {
      const idx = ditherFS(patch.data, gw, gh, palette, TRANSPARENT)
      writer.addFrame(gx, gy, gw, gh, idx, { delay: ds, disposal: 1, transparent: TRANSPARENT })
    }
  }
  const end = writer.end()
  return new Blob([buf.slice(0, end).buffer as ArrayBuffer], { type: 'image/gif' })
}
