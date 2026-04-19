import type { LiveEvent } from '../types'
import { GUARD_FRAME_URLS } from './constants'
import { fixUrl } from './formatters'

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return }
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.referrerPolicy = 'no-referrer'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = fixUrl(src)
  })
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = []
  let cur = ''
  for (const ch of Array.from(text)) {
    if (ch === '\n') { lines.push(cur); cur = ''; continue }
    const probe = cur + ch
    if (ctx.measureText(probe).width > maxWidth && cur) {
      lines.push(cur)
      cur = ch
    } else {
      cur = probe
    }
  }
  if (cur) lines.push(cur)
  return lines
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

export async function generateSuperChatCard(
  canvas: HTMLCanvasElement,
  event: LiveEvent,
  opts?: { showPrice?: boolean },
): Promise<void> {
  const showPrice = opts?.showPrice ?? true
  const ctx = canvas.getContext('2d')!
  const e = event.extra || {}

  // OBS overlay / 大 SC 挂件样式：顶部主区（头像+名字+电池+倒计时+装饰图）用
  // background_color（浅色）；底部留言条用 background_color_start→end（渐变深色）。
  const mainBg = e.background_color || '#EDF5FF'
  const msgBgStart = e.background_color_start || '#3171D2'
  const msgBgEnd = e.background_color_end || msgBgStart
  const nameColor = e.name_color || '#333333'
  const priceColor = e.background_price_color || '#7497CD'
  const msgColor = e.message_font_color || '#FFFFFF'
  const colorPoint = e.color_point && e.color_point > 0 ? e.color_point : 0.7

  const dpr = 2
  const W = 460
  const MAIN_H = 90
  const PAD = 16
  const MSG_FONT = 22
  const MSG_LINE_H = 32

  const MSG_MAX_W = W - PAD * 2
  ctx.font = `500 ${MSG_FONT}px -apple-system, "PingFang SC", sans-serif`
  const lines = wrapText(ctx, event.content || '', MSG_MAX_W)
  const msgH = Math.max(54, lines.length * MSG_LINE_H + PAD)
  const H = MAIN_H + msgH

  canvas.width = W * dpr
  canvas.height = H * dpr
  canvas.style.width = W + 'px'
  canvas.style.height = H + 'px'
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)

  const [avatar, guardFrame, decoImg] = await Promise.all([
    loadImage(e.avatar || ''),
    e.guard_level && e.guard_level > 0
      ? loadImage(GUARD_FRAME_URLS[e.guard_level])
      : Promise.resolve(null),
    e.background_image ? loadImage(e.background_image) : Promise.resolve(null),
  ])

  const RADIUS = 8
  ctx.save()
  roundRect(ctx, 0, 0, W, H, RADIUS)
  ctx.clip()

  // ── 主区背景 ──
  ctx.fillStyle = mainBg
  ctx.fillRect(0, 0, W, MAIN_H)

  // ── 装饰图贴在主区右侧。PNG 本身常带右侧透明 padding，多偏移一点让
  // 视觉中心更贴近卡片右缘，溢出部分由外层 clip 自动裁掉。──
  if (decoImg) {
    const ih = MAIN_H
    const iw = (decoImg.width / decoImg.height) * ih
    const DECO_OFFSET = 40
    ctx.globalAlpha = 0.95
    ctx.drawImage(decoImg, W - iw + DECO_OFFSET, 0, iw, ih)
    ctx.globalAlpha = 1
  }

  // ── 头像 + 舰长框 ──
  const acx = PAD + 34
  const acy = MAIN_H / 2
  const ar = 24
  const frameSize = 76 // 舰长框含"舰长"文字，比头像直径大

  if (avatar) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(acx, acy, ar, 0, Math.PI * 2)
    ctx.clip()
    ctx.drawImage(avatar, acx - ar, acy - ar, ar * 2, ar * 2)
    ctx.restore()
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    ctx.beginPath()
    ctx.arc(acx, acy, ar, 0, Math.PI * 2)
    ctx.fill()
  }
  if (guardFrame) {
    ctx.drawImage(guardFrame, acx - frameSize / 2, acy - frameSize / 2, frameSize, frameSize)
  }

  // ── 用户名（+ 电池数，可选）──
  const textX = acx + ar + 16
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = nameColor
  ctx.font = '600 18px -apple-system, "PingFang SC", sans-serif'
  if (showPrice) {
    ctx.fillText(event.user_name || '', textX, acy - 3)
    ctx.fillStyle = priceColor
    ctx.font = '500 15px -apple-system, "PingFang SC", sans-serif'
    ctx.fillText(`${e.price || 0} 电池`, textX, acy + 18)
  } else {
    // 不显示电池时用户名垂直居中
    ctx.textBaseline = 'middle'
    ctx.fillText(event.user_name || '', textX, acy)
  }

  // ── 底部留言条（background_color_start → end 横向渐变）──
  const msgGrad = ctx.createLinearGradient(0, MAIN_H, W, MAIN_H)
  msgGrad.addColorStop(0, msgBgStart)
  msgGrad.addColorStop(colorPoint, msgBgStart)
  msgGrad.addColorStop(1, msgBgEnd)
  ctx.fillStyle = msgGrad
  ctx.fillRect(0, MAIN_H, W, msgH)

  ctx.fillStyle = msgColor
  ctx.font = `500 ${MSG_FONT}px -apple-system, "PingFang SC", sans-serif`
  ctx.textBaseline = 'alphabetic'
  const textStartY = MAIN_H + PAD / 2 + MSG_FONT
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], PAD, textStartY + i * MSG_LINE_H)
  }

  ctx.restore()
}
