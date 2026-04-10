import { useState, useEffect, useRef } from 'react'
import { fetchQrCode, pollQrLogin } from '../api/client'

interface Props {
  isOpen: boolean
  roomId: number | null
  onClose: () => void
  onSuccess: (uid: number) => void
}

export function QrLoginModal({ isOpen, roomId, onClose, onSuccess }: Props) {
  const [qrUrl, setQrUrl] = useState('')
  const [status, setStatus] = useState('加载中...')
  const [statusClass, setStatusClass] = useState('')
  const qrKeyRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!isOpen || !roomId) return

    setStatus('加载中...')
    setStatusClass('')
    setQrUrl('')
    qrKeyRef.current = null

    fetchQrCode(roomId).then((d) => {
      if (d.error) {
        setStatus(d.error)
        setStatusClass('error')
        return
      }
      qrKeyRef.current = d.qrcode_key
      setQrUrl(`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(d.url)}`)
      setStatus('请使用哔哩哔哩 APP 扫码')

      timerRef.current = setInterval(async () => {
        if (!qrKeyRef.current) return
        try {
          const r = await pollQrLogin(qrKeyRef.current)
          if (r.code === 0) {
            setStatus(`绑定成功! UID: ${r.uid}`)
            setStatusClass('success')
            if (timerRef.current) clearInterval(timerRef.current)
            onSuccess(r.uid!)
            setTimeout(onClose, 1500)
          } else if (r.code === 86090) {
            setStatus('已扫码，请在手机上确认...')
          } else if (r.code === 86038) {
            setStatus('二维码已过期，请重新打开')
            setStatusClass('error')
            if (timerRef.current) clearInterval(timerRef.current)
          }
        } catch { /* ignore */ }
      }, 2000)
    }).catch(() => {
      setStatus('获取二维码失败')
      setStatusClass('error')
    })

    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [isOpen, roomId, onClose, onSuccess])

  if (!isOpen) return null

  return (
    <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <h2>绑定机器人</h2>
        <p>使用哔哩哔哩 APP 扫描二维码</p>
        <div className="qr-container">
          {qrUrl && <img src={qrUrl} alt="二维码" />}
        </div>
        <div className={`qr-status ${statusClass}`}>{status}</div>
        <br />
        <button className="close-btn" onClick={onClose}>关闭</button>
      </div>
    </div>
  )
}
