import { useImperativeHandle, forwardRef, useState } from 'react'
import { Modal, Button, ButtonGroup } from 'rsuite'
import { fetchGiftSummary } from '../api/client'
import { generateGiftCard } from '../lib/giftCard'
import { generateGiftGif, type GiftGifItem } from '../lib/giftGif'

export interface GiftImageModalRef {
  showGiftImage: (roomId: number, userName: string, blindOnly?: boolean) => void
  showPreview: (title: string, imgUrl: string) => void
  showGiftGif: (roomId: number, userName: string, giftName: string) => void
  showGiftGifBatch: (items: GiftGifItem[], title: string) => void
}

export const GiftImageModal = forwardRef<GiftImageModalRef>(function GiftImageModal(_, ref) {
  const [isOpen, setIsOpen] = useState(false)
  const [title, setTitle] = useState('')
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
      const url = offscreen.toDataURL('image/png')

      setTitle(`${u.user_name} - ${data.date} ${blindOnly ? '盲盒' : '礼物'}`)
      setImgUrl(url)
      setExt('png')
      setIsOpen(true)
    },
    showPreview(title: string, imgUrl: string) {
      setTitle(title)
      setImgUrl(imgUrl)
      setExt('png')
      setIsOpen(true)
    },
    async showGiftGif(roomId: number, userName: string, giftName: string) {
      try { await document.fonts.load('italic 800 30px "Baloo 2"') } catch { /* ok */ }
      const data = await fetchGiftSummary(roomId, userName)
      const u = data.users?.[0]
      if (!u) { alert('该用户今日暂无礼物记录'); return }
      const blob = await generateGiftGif([{ u, giftName }])
      if (!blob) { alert('暂无该礼物的动态图'); return }
      setTitle(`${userName} - ${giftName}`)
      setImgUrl(URL.createObjectURL(blob))
      setExt('gif')
      setIsOpen(true)
    },
    async showGiftGifBatch(items: GiftGifItem[], t: string) {
      const blob = await generateGiftGif(items)
      if (!blob) { alert('所选礼物均无动态图'); return }
      setTitle(t)
      setImgUrl(URL.createObjectURL(blob))
      setExt('gif')
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
        {imgUrl && <img src={imgUrl} alt={title} style={{ borderRadius: 8, maxWidth: '100%' }} />}
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
