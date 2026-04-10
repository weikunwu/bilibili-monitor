import type { Room } from '../types'

interface Props {
  rooms: Room[]
  value: number | null
  onChange: (roomId: number) => void
}

export function RoomSelector({ rooms, value, onChange }: Props) {
  if (rooms.length <= 1) return null

  return (
    <div className="room-switch">
      <select
        value={value ?? ''}
        onChange={(e) => onChange(parseInt(e.target.value))}
      >
        {rooms.map((r) => (
          <option key={r.room_id} value={r.room_id}>
            {r.streamer_name || r.room_id}
          </option>
        ))}
      </select>
    </div>
  )
}
