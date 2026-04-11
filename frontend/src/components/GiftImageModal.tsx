import { useImperativeHandle, forwardRef, useState } from 'react'
import { fetchGiftSummary } from '../api/client'
import { generateGiftCard } from '../lib/giftCard'

export interface GiftImageModalRef {
  showGiftImage: (userName: string) => void
}

export const GiftImageModal = forwardRef<GiftImageModalRef>(function GiftImageModal(_, ref) {
  const [isOpen, setIsOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [imgUrl, setImgUrl] = useState('')

  useImperativeHandle(ref, () => ({
    async showGiftImage(userName: string) {
      try { await document.fonts.load('italic 800 30px "Baloo 2"') } catch { /* ok */ }
      const tz = new Date().getTimezoneOffset()
      const data = await fetchGiftSummary(userName, tz)
      const u = data.users?.[0]
      if (!u) { alert('该用户今日暂无礼物记录'); return }

      // Render to offscreen canvas before opening modal
      const offscreen = document.createElement('canvas')
      await generateGiftCard(offscreen, u)
      const url = offscreen.toDataURL('image/png')

      setTitle(`${u.user_name} - ${data.date} 礼物`)
      setImgUrl(url)
      setIsOpen(true)
    },
  }))

  function download() {
    if (!imgUrl) return
    const a = document.createElement('a')
    a.download = `gift-summary-${new Date().toISOString().slice(0, 10)}.png`
    a.href = imgUrl
    a.click()
  }

  if (!isOpen) return null

  return (
    <div className="img-modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) setIsOpen(false) }}>
      <div className="img-modal">
        <h2>{title}</h2>
        <img src={imgUrl} alt={title} style={{ borderRadius: 8, maxWidth: '100%' }} />
        <div className="actions">
          <button className="dl-btn" onClick={download}>保存图片</button>
          <button className="cl-btn" onClick={() => setIsOpen(false)}>关闭</button>
        </div>
      </div>
    </div>
  )
})
