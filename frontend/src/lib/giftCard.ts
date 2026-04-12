import type { GiftUser } from '../types'
import { GUARD_FRAME_URLS, CARD_TPL_URLS } from './constants'
import { getProxyImageUrl } from './formatters'

function loadImage(src: string, proxy = false): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return }
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    // B站 CDN 图片通过后端代理加载，解决 CORS 问题
    img.src = proxy ? getProxyImageUrl(src) : src
  })
}

export async function generateGiftCard(canvas: HTMLCanvasElement, u: GiftUser) {
  const ctx = canvas.getContext('2d')!
  const dpr = 2
  const gifts = Object.entries(u.gifts)
  const giftImgs = u.gift_imgs || {}
  const giftActions = u.gift_actions || {}
  const giftCoins = u.gift_coins || {}

  const W = 480
  const CARD_H = 74
  const GAP = 6
  const PAD_TOP = 6
  const H = PAD_TOP + gifts.length * (CARD_H + GAP) - GAP + 2

  canvas.width = W * dpr
  canvas.height = H * dpr
  canvas.style.width = W + 'px'
  canvas.style.height = H + 'px'
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)

  const [avatar, guardFrame, ...giftImgObjs] = await Promise.all([
    loadImage(u.avatar || '', true),
    u.guard_level > 0 ? loadImage(GUARD_FRAME_URLS[u.guard_level]) : Promise.resolve(null),
    ...gifts.map(([name]) => loadImage(giftImgs[name] || '', true)),
  ])

  const cardTpls: Record<string, HTMLImageElement | null> = {}
  await Promise.all(
    Object.entries(CARD_TPL_URLS).map(async ([k, url]) => {
      cardTpls[k] = await loadImage(url)
    }),
  )

  for (let i = 0; i < gifts.length; i++) {
    const [giftName, num] = gifts[i]
    const y = PAD_TOP + i * (CARD_H + GAP)

    const battery = giftCoins[giftName] || 0
    const tplKey = battery >= 10000 ? 'gold' : battery >= 5000 ? 'pink' : battery >= 1000 ? 'purple' : 'blue'
    const tpl = cardTpls[tplKey]
    if (tpl) ctx.drawImage(tpl, 0, y, W, CARD_H)

    const acx = 36
    const acy = y + CARD_H / 2
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
    ctx.fillText(u.user_name, tx, y + 29)

    const action = giftActions[giftName] || '投喂'
    const isBlind = action.includes('爆出')
    let drawX = tx

    if (isBlind) {
      const blindParts = action.split(' 爆出')
      ctx.fillStyle = '#ffe066'
      ctx.font = 'bold 15px -apple-system, "PingFang SC", sans-serif'
      ctx.fillText(blindParts[0], drawX, y + 52)
      drawX += ctx.measureText(blindParts[0]).width
      ctx.fillStyle = '#ffffff'
      ctx.font = '15px -apple-system, "PingFang SC", sans-serif'
      ctx.fillText(' 爆出 ', drawX, y + 52)
      drawX += ctx.measureText(' 爆出 ').width
    } else {
      ctx.fillStyle = '#ffffff'
      ctx.font = '15px -apple-system, "PingFang SC", sans-serif'
      ctx.fillText(action + ' ', drawX, y + 52)
      drawX += ctx.measureText(action + ' ').width
    }

    ctx.fillStyle = '#ffe066'
    ctx.font = 'bold 16px -apple-system, "PingFang SC", sans-serif'
    ctx.fillText(giftName, drawX, y + 52)

    ctx.shadowBlur = 0
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0

    const gSize = 72
    const rightStart = W * 0.6
    if (giftImgObjs[i]) {
      ctx.drawImage(giftImgObjs[i]!, rightStart, y + (CARD_H - gSize) / 2, gSize, gSize)
    }

    const numY = y + CARD_H * 0.5 + 11
    const numStartX = rightStart + gSize + 8

    ctx.font = 'italic 800 30px "Baloo 2", -apple-system, sans-serif'
    ctx.strokeStyle = '#bc6e2d'
    ctx.lineWidth = 3
    ctx.lineJoin = 'round'
    ctx.strokeText('x ', numStartX, numY)
    ctx.fillStyle = '#fff505'
    ctx.fillText('x ', numStartX, numY)
    const xW = ctx.measureText('x ').width

    ctx.lineWidth = 5
    ctx.strokeText(String(num), numStartX + xW, numY)
    ctx.fillStyle = '#fff505'
    ctx.fillText(String(num), numStartX + xW, numY)
    ctx.fillText(String(num), numStartX + xW + 0.5, numY)
    ctx.fillText(String(num), numStartX + xW - 0.5, numY)
  }
}
