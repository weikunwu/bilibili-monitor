import type { Room } from '../types'

interface Props {
  rooms: Room[]
  onSelectRoom: (roomId: number) => void
}

function formatFans(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万'
  return n.toLocaleString()
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
            {/* Header: name + room id + status badges */}
            <div className="rc-header">
              <span className="rc-name">{r.streamer_name || `房间 ${r.room_id}`}</span>
              <span className="rc-room-id">房间 {r.room_id}</span>
              <span className="rc-badge rc-badge-running">运行中</span>
              {r.live_status === 1 && <span className="rc-badge rc-badge-live">直播中</span>}
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

            {/* Bot status */}
            <div className="rc-footer">
              <span className="rc-detail-label">机器人</span>
              {r.bot_uid ? (
                <span className="rc-bot-status active">已绑定 (UID: {r.bot_uid})</span>
              ) : (
                <span className="rc-bot-status">未绑定</span>
              )}
            </div>
          </div>
        ))}
        {rooms.length === 0 && <div className="empty">暂无可用房间</div>}
      </div>
    </div>
  )
}
