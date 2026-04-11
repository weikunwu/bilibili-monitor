import type { Room } from '../types'

interface Props {
  rooms: Room[]
  onSelectRoom: (roomId: number) => void
}

export function RoomList({ rooms, onSelectRoom }: Props) {
  return (
    <div className="room-list">
      <h2>选择直播间</h2>
      <div className="room-cards">
        {rooms.map((r) => (
          <div
            key={r.room_id}
            className="room-card"
            onClick={() => onSelectRoom(r.room_id)}
          >
            <div className="room-card-header">
              <div className="room-card-name">{r.streamer_name || `房间 ${r.room_id}`}</div>
              <span className={`room-card-bot ${r.bot_uid ? 'active' : ''}`}>
                {r.bot_uid ? `机器人 (${r.bot_uid})` : '未绑定机器人'}
              </span>
            </div>
            <div className="room-card-meta">
              <span>UID: {r.ruid}</span>
              <span>房间: {r.room_id}</span>
            </div>
            <div className="room-card-stats">
              <span>粉丝 {r.followers?.toLocaleString() ?? 0}</span>
              <span>舰长 {r.guard_count ?? 0}</span>
            </div>
            {r.area_name && <div className="room-card-area">{r.area_name}</div>}
            {r.room_title && <div className="room-card-title">{r.room_title}</div>}
            {r.announcement && <div className="room-card-announce">{r.announcement}</div>}
          </div>
        ))}
        {rooms.length === 0 && <div className="empty">暂无可用房间</div>}
      </div>
    </div>
  )
}
