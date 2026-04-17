import { useImperativeHandle, forwardRef, useState } from 'react'
import { Modal, Button, ButtonGroup } from 'rsuite'
import { fetchGiftSummary } from '../api/client'
import { generateGiftCard } from '../lib/giftCard'
import { generateGiftGif, type GiftGifItem } from '../lib/giftGif'
import { generateSuperChatCard } from '../lib/superchatCard'
import type { LiveEvent } from '../types'

export interface GiftImageModalRef {
  showGiftImage: (roomId: number, userName: string, blindOnly?: boolean) => void
  showPreview: (imgUrl: string, ext?: 'png' | 'gif') => void
  showGiftGif: (items: GiftGifItem[]) => void
  showSuperChatImage: (event: LiveEvent) => void
}

export const GiftImageModal = forwardRef<GiftImageModalRef>(function GiftImageModal(_, ref) {
  const [isOpen, setIsOpen] = useState(false)
  const [imgUrl, setImgUrl] = useState('')
  const [ext, setExt] = useState<'png' | 'gif'>('png')

  useImperativeHandle(ref, () => ({
    async showGiftImage(roomId: number, userName: string, blindOnly?: boolean) {
      try { await document.fonts.load('italic 800 30px "Baloo 2"') } catch { /* ok */ }
      const data = await fetchGiftSummary(roomId, userName, blindOnly)
      const u = data.users?.[0]
      if (!u) { alert(blindOnly ? '该用户今日暂无盲盒记录' : '该用户今日暂无礼物记录'); return }

      const offscreen = document.createElement('canvas')
      await generateGiftCard(offscreen, u)
      setImgUrl(offscreen.toDataURL('image/png'))
      setExt('png')
      setIsOpen(true)
    },
    showPreview(imgUrl: string, ext: 'png' | 'gif' = 'png') {
      setImgUrl(imgUrl)
      setExt(ext)
      setIsOpen(true)
    },
    async showGiftGif(items: GiftGifItem[]) {
      const blob = await generateGiftGif(items)
      if (!blob) { alert('所选礼物均无动态图'); return }
      setImgUrl(URL.createObjectURL(blob))
      setExt('gif')
      setIsOpen(true)
    },
    async showSuperChatImage(event: LiveEvent) {
      const offscreen = document.createElement('canvas')
      await generateSuperChatCard(offscreen, event)
      setImgUrl(offscreen.toDataURL('image/png'))
      setExt('png')
      setIsOpen(true)
    },
  }))

  function download() {
    if (!imgUrl) return
    const a = document.createElement('a')
    a.download = `gift-${new Date().toISOString().slice(0, 10)}.${ext}`
    a.href = imgUrl
    a.click()
  }

  return (
    <Modal open={isOpen} onClose={() => setIsOpen(false)} size="sm">
      <Modal.Header closeButton={false} />
      <Modal.Body style={{ textAlign: 'center' }}>
        {imgUrl && <img src={imgUrl} alt="" style={{ borderRadius: 8, maxWidth: '100%' }} />}
      </Modal.Body>
      <Modal.Footer>
        <ButtonGroup>
          <Button size="sm" appearance="primary" onClick={download} style={{ minWidth: 80 }}>保存图片</Button>
          <Button size="sm" appearance="subtle" onClick={() => setIsOpen(false)} style={{ minWidth: 80 }}>关闭</Button>
        </ButtonGroup>
      </Modal.Footer>
    </Modal>
  )
})
