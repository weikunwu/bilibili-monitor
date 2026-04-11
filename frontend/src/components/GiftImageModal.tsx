import { useImperativeHandle, forwardRef, useState } from 'react'
import { Modal, Button, ButtonGroup } from 'rsuite'
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

  return (
    <Modal open={isOpen} onClose={() => setIsOpen(false)} size="sm">
      <Modal.Header>
        <Modal.Title>{title}</Modal.Title>
      </Modal.Header>
      <Modal.Body style={{ textAlign: 'center' }}>
        {imgUrl && <img src={imgUrl} alt={title} style={{ borderRadius: 8, maxWidth: '100%' }} />}
      </Modal.Body>
      <Modal.Footer>
        <ButtonGroup>
          <Button appearance="primary" onClick={download}>保存图片</Button>
          <Button appearance="subtle" onClick={() => setIsOpen(false)}>关闭</Button>
        </ButtonGroup>
      </Modal.Footer>
    </Modal>
  )
})
