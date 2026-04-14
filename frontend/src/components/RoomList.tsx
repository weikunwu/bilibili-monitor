import { useEffect, useState } from 'react'
import { MdCircle } from 'react-icons/md'
import { Button, ButtonToolbar, useToaster, Message } from 'rsuite'
import PlayOutlineIcon from '@rsuite/icons/PlayOutline'
import CloseOutlineIcon from '@rsuite/icons/CloseOutline'
import ChangeListIcon from '@rsuite/icons/ChangeList'
import type { Room } from '../types'

// Per-tab cache of fresh streamer-info so we re-hit B站 once per room,
// not once per card remount. Server caches the client-side value forever
// so the bulk /api/rooms response can be stale for renamed anchors.
interface StreamerInfo { streamer_name: string; streamer_avatar: string; followers: number }
const streamerInfoCache = new Map<number, Promise<StreamerInfo>>()
function fetchStreamerInfo(roomId: number): Promise<StreamerInfo> {
  let p = streamerInfoCache.get(roomId)
  if (!p) {
    p = fetch(`/api/rooms/${roomId}/streamer-info`)
      .then((r) => (r.ok ? r.json() : { streamer_name: '', streamer_avatar: '', followers: 0 }))
      .catch(() => ({ streamer_name: '', streamer_avatar: '', followers: 0 }))
    streamerInfoCache.set(roomId, p)
  }
  return p
}

interface Props {
  rooms: Room[]
  onSelectRoom: (roomId: number) => void
  onRoomsChanged?: () => void
  onBindBot?: (roomId: number) => void
}

function formatFans(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万'
  return n.toLocaleString()
}

function StreamerBlock({ room }: { room: Room }) {
  const [fresh, setFresh] = useState<StreamerInfo | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchStreamerInfo(room.room_id).then((v) => {
      if (!cancelled && (v.streamer_avatar || v.streamer_name)) setFresh(v)
    })
    return () => { cancelled = true }
  }, [room.room_id])
  const avatar = fresh?.streamer_avatar || room.streamer_avatar
  const name = fresh?.streamer_name || room.streamer_name
  const followers = fresh?.followers ?? room.followers
  return (
    <div className="rc-streamer">
      {avatar ? (
        <img className="rc-avatar" src={avatar} referrerPolicy="no-referrer" alt="" />
      ) : (
        <div className="rc-avatar rc-avatar-placeholder" />
      )}
      <div className="rc-streamer-info">
        <div className="rc-streamer-name">{name}</div>
        <div className="rc-streamer-meta">
          粉丝: {formatFans(followers)} · UID: {room.streamer_uid}
        </div>
      </div>
    </div>
  )
}

export function RoomList({ rooms, onSelectRoom, onRoomsChanged, onBindBot }: Props) {
  const toaster = useToaster()

  const handleToggle = async (e: React.MouseEvent, room: Room) => {
    e.stopPropagation()
    const action = room.active ? 'stop' : 'start'
    const res = await fetch(`/api/rooms/${room.room_id}/${action}`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toaster.push(<Message type="error" showIcon closable>{data.detail || '操作失败'}</Message>, { duration: 3000 })
      return
    }
    onRoomsChanged?.()
  }

  return (
    <div className="room-list">
      <h2>房间列表</h2>
      <div className="room-cards">
        {rooms.map((r) => (
          <div
            key={r.room_id}
            className="room-card"
            onClick={() => onSelectRoom(r.room_id)}
          >
            {/* Header: room title + room id + status badges */}
            <div className="rc-header">
              <div className="rc-header-left">
                <span className="rc-name">{r.room_title || `房间 ${r.room_id}`}</span>
                <span className="rc-room-id">房间 {r.room_id}</span>
              </div>
              <div className="rc-header-badges">
                {r.live_status === 1 && <span className="rc-badge rc-badge-live"><MdCircle size={8} /> 直播中</span>}
              </div>
            </div>

            {/* Streamer info + area/announcement */}
            <div className="rc-body">
              <StreamerBlock room={r} />
              <div className="rc-details">
                {(r.parent_area_name || r.area_name) && (
                  <div className="rc-detail-row">
                    <span className="rc-detail-label">分区</span>
                    <div className="rc-detail-tags">
                      {r.parent_area_name && <span className="rc-tag">{r.parent_area_name}</span>}
                      {r.area_name && <span className="rc-tag">{r.area_name}</span>}
                    </div>
                  </div>
                )}
                {r.announcement && (
                  <div className="rc-detail-row">
                    <span className="rc-detail-label">公告</span>
                    <span className="rc-detail-text">{r.announcement}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Footer: bot + monitor status */}
            <div className="rc-footer">
              <div className="rc-footer-info">
                <span className="rc-detail-label">机器人</span>
                {r.bot_uid ? (
                  <span className="rc-bot-status active">{r.bot_name || 'Unknown'} (UID: {r.bot_uid})</span>
                ) : (
                  <span className="rc-bot-status">未绑定</span>
                )}
              </div>
              <div className="rc-footer-actions">
                <ButtonToolbar>
                  {r.active ? (
                    <Button size="sm" color="red" appearance="ghost" startIcon={<CloseOutlineIcon />} onClick={(e) => { e.stopPropagation(); handleToggle(e, r) }}>
                      停止
                    </Button>
                  ) : (
                    <Button size="sm" color="green" appearance="ghost" startIcon={<PlayOutlineIcon />} onClick={(e) => { e.stopPropagation(); handleToggle(e, r) }}>
                      启动
                    </Button>
                  )}
                  <Button size="sm" appearance="ghost" startIcon={<ChangeListIcon />} onClick={(e) => { e.stopPropagation(); onBindBot?.(r.room_id) }}>
                    {r.bot_uid ? '更换' : '绑定'}
                  </Button>
                </ButtonToolbar>
              </div>
            </div>
          </div>
        ))}
        {rooms.length === 0 && <div className="empty">暂无可用房间</div>}
      </div>
    </div>
  )
}
