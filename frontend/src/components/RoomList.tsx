import { MdCircle, MdPlayArrow, MdStop, MdSwapHoriz } from 'react-icons/md'
import { Button, ButtonGroup } from 'rsuite'
import type { Room } from '../types'

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

export function RoomList({ rooms, onSelectRoom, onRoomsChanged, onBindBot }: Props) {
  const handleToggle = async (e: React.MouseEvent, room: Room) => {
    e.stopPropagation()
    const action = room.active ? 'stop' : 'start'
    await fetch(`/api/rooms/${room.room_id}/${action}`, { method: 'POST' })
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
              <div className="rc-streamer">
                {r.streamer_avatar ? (
                  <img className="rc-avatar" src={r.streamer_avatar} referrerPolicy="no-referrer" alt="" />
                ) : (
                  <div className="rc-avatar rc-avatar-placeholder" />
                )}
                <div className="rc-streamer-info">
                  <div className="rc-streamer-name">{r.streamer_name}</div>
                  <div className="rc-streamer-meta">
                    粉丝: {formatFans(r.followers)} · UID: {r.ruid} · 舰长: {r.guard_count}
                  </div>
                </div>
              </div>
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
              <div className="rc-footer-section">
                <div className="rc-footer-item">
                  <span className="rc-detail-label">机器人</span>
                  {r.bot_uid ? (
                    <span className="rc-bot-status active">{r.bot_name || 'Unknown'} (UID: {r.bot_uid})</span>
                  ) : (
                    <span className="rc-bot-status">未绑定</span>
                  )}
                </div>
                <ButtonGroup size="xs">
                  {r.active ? (
                    <Button appearance="primary" color="green" onClick={(e) => handleToggle(e as unknown as React.MouseEvent, r)} title="点击停止监控"><MdStop size={12} /> 运行中</Button>
                  ) : (
                    <Button appearance="ghost" onClick={(e) => handleToggle(e as unknown as React.MouseEvent, r)} title="点击启动监控"><MdPlayArrow size={12} /> 已停止</Button>
                  )}
                  <Button appearance="ghost" onClick={(e) => { e.stopPropagation(); onBindBot?.(r.room_id) }} title={r.bot_uid ? '更换机器人' : '绑定机器人'}>
                    <MdSwapHoriz size={12} /> {r.bot_uid ? '更换' : '绑定'}
                  </Button>
                </ButtonGroup>
              </div>
            </div>
          </div>
        ))}
        {rooms.length === 0 && <div className="empty">暂无可用房间</div>}
      </div>
    </div>
  )
}
