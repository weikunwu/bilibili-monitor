import { useState } from 'react'
import { Button, Message, useToaster } from 'rsuite'
import type { LiveEvent } from '../types'
import { matchClip } from '../api/client'
import { composeClipInBrowser, downloadBlob } from '../lib/clipCompose'
import { confirmDialog } from '../lib/confirm'

// 是否显示"下载录屏"按钮完全看服务端打的 has_clip flag：
//   • 写入事件时若 (gift/guard + 单价 ≥ ¥1000 + 当时 auto_clip 开) → true
//   • 72h 定时清盘时，磁盘文件删掉的同时 db 层把对应事件的 flag 翻回 false
// 前端不再二次判断单价 / 类型 / 房间 auto_clip / 事件年龄。
export function isClippable(ev: LiveEvent): boolean {
  return ev.extra?.has_clip === true
}

// On-demand lookup — clip download is a rare event and the anchor could
// swap their background mid-stream, so hit the backend fresh each click.
async function fetchRoomBackground(roomId: number): Promise<string | undefined> {
  try {
    const d = await fetch(`/api/rooms/${roomId}/background`).then((r) => r.json())
    return d?.url || undefined
  } catch {
    return undefined
  }
}

interface Props {
  event: LiveEvent
  size?: 'xs' | 'sm' | 'md' | 'lg'
}

export function ClipDownloadButton({ event, size = 'sm' }: Props) {
  const toaster = useToaster()
  const [busy, setBusy] = useState(false)
  const [missing, setMissing] = useState(false)
  const [progress, setProgress] = useState('')

  if (!isClippable(event)) return null

  async function handleClick() {
    if (!event.room_id || !event.user_name || !event.timestamp) return
    const ok = await confirmDialog({
      title: '下载录屏',
      message: (
        <>
          <div>刚送出的礼物，请等待 10 分钟后再下载。</div>
          <div style={{ marginTop: 8 }}>
            下载录屏占用资源较高，如果下载的录屏没有特效或特效卡顿，建议下播之后再试。
          </div>
        </>
      ),
      okText: '继续下载',
    })
    if (!ok) return
    setBusy(true)
    setMissing(false)
    setProgress('匹配中...')
    try {
      const [m, cover] = await Promise.all([
        matchClip(event.room_id, event.user_name, event.timestamp),
        fetchRoomBackground(event.room_id),
      ])
      if (!m) { setMissing(true); return }
      const blob = await composeClipInBrowser(event.room_id, m.name, event, cover, (p) => {
        if (p.stage === 'downloading') setProgress('下载中...')
        else if (p.stage === 'loading') setProgress('加载中...')
        else if (p.stage === 'recording') setProgress(`合成 ${Math.round((p.ratio || 0) * 100)}%`)
        else if (p.stage === 'finalizing') setProgress('收尾...')
      })
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm'
      downloadBlob(blob, `${m.name}.${ext}`)
    } catch (err) {
      toaster.push(
        <Message type="error" showIcon closable>{(err as Error).message || '合成失败'}</Message>,
        { duration: 5000, placement: 'topCenter' },
      )
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  return (
    <Button size={size} loading={busy} disabled={missing} onClick={handleClick}>
      {missing ? '已失效' : (busy && progress ? progress : '下载录屏')}
    </Button>
  )
}
