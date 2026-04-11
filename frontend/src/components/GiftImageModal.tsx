import { useRef, useImperativeHandle, forwardRef, useState, useEffect } from 'react'
import { fetchGiftSummary } from '../api/client'
import { generateGiftCard } from '../lib/giftCard'
import type { GiftUser } from '../types'

export interface GiftImageModalRef {
  showGiftImage: (userName: string) => void
}

export const GiftImageModal = forwardRef<GiftImageModalRef>(function GiftImageModal(_, ref) {
  const [isOpen, setIsOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [pendingUser, setPendingUser] = useState<GiftUser | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (isOpen && pendingUser && canvasRef.current) {
      generateGiftCard(canvasRef.current, pendingUser).catch(() => {})
      setPendingUser(null)
    }
  }, [isOpen, pendingUser])

  useImperativeHandle(ref, () => ({
    async showGiftImage(userName: string) {
      try { await document.fonts.load('italic 800 30px "Baloo 2"') } catch { /* ok */ }
      const tz = new Date().getTimezoneOffset()
      const data = await fetchGiftSummary(userName, tz)
      const u = data.users?.[0]
      if (!u) { alert('该用户今日暂无礼物记录'); return }

      setTitle(`${u.user_name} - ${data.date} 礼物`)
      setPendingUser(u)
      setIsOpen(true)
    },
  }))

  function download() {
    if (!canvasRef.current) return
    // canvas 可能被污染（CDN 图片无 CORS），用 try-catch
    try {
      const a = document.createElement('a')
      a.download = `gift-summary-${new Date().toISOString().slice(0, 10)}.png`
      a.href = canvasRef.current.toDataURL('image/png')
      a.click()
    } catch {
      alert('图片保存失败（跨域限制），请截图保存')
    }
  }

  if (!isOpen) return null

  return (
    <div className="img-modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) setIsOpen(false) }}>
      <div className="img-modal">
        <h2>{title}</h2>
        <canvas ref={canvasRef} style={{ borderRadius: 8, maxWidth: '100%' }} />
        <div className="actions">
          <button className="dl-btn" onClick={download}>保存图片</button>
          <button className="cl-btn" onClick={() => setIsOpen(false)}>关闭</button>
        </div>
      </div>
    </div>
  )
})
