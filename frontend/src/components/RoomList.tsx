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
            <div className="room-card-name">{r.streamer_name || `房间 ${r.room_id}`}</div>
            <div className="room-card-id">房间号: {r.room_id}</div>
            <div className="room-card-title">{r.room_title || '暂无标题'}</div>
            <div className="room-card-pop">人气: {r.popularity?.toLocaleString() ?? 0}</div>
          </div>
        ))}
        {rooms.length === 0 && <div className="empty">暂无可用房间</div>}
      </div>
    </div>
  )
}
