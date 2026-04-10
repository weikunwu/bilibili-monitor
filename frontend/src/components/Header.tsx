import type { Room, ConnectionStatus as Status } from '../types'
import { RoomSelector } from './RoomSelector'
import { ConnectionStatus } from './ConnectionStatus'

interface Props {
  rooms: Room[]
  currentRoomId: number | null
  onRoomChange: (roomId: number) => void
  connectionStatus: Status
  botUid: number | null
  onBotClick: () => void
  onLogout: () => void
}

export function Header({
  rooms, currentRoomId, onRoomChange, connectionStatus,
  botUid, onBotClick, onLogout,
}: Props) {
  const room = rooms.find((r) => r.room_id === currentRoomId)
  const roomInfo = room ? `${room.streamer_name || room.room_id} (${room.room_id})` : ''

  return (
    <div className="header">
      <h1>B站直播监控</h1>
      <span className="room-info">{roomInfo || '连接中...'}</span>
      <RoomSelector rooms={rooms} value={currentRoomId} onChange={onRoomChange} />
      <button
        className={`login-btn ${botUid ? 'logged-in' : ''}`}
        onClick={onBotClick}
      >
        {botUid ? `机器人已绑定 (${botUid})` : '绑定机器人'}
      </button>
      <ConnectionStatus status={connectionStatus} />
      <span style={{ flex: 1 }} />
      <button
        className="login-btn"
        style={{ background: '#555', marginLeft: 'auto' }}
        onClick={onLogout}
      >
        退出登录
      </button>
    </div>
  )
}
