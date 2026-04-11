import { useState, useEffect, useCallback, useRef } from 'react'
import { Routes, Route, useParams, useNavigate, Navigate } from 'react-router-dom'
import type { LiveEvent, TabType, Room, Stats } from './types'
import { fetchRooms, fetchStats, fetchEvents, fetchBotStatus, botLogout, authLogout, fetchMe, type CurrentUser } from './api/client'
import { useWebSocket } from './hooks/useWebSocket'
import { useLocalStorage } from './hooks/useLocalStorage'
import { localToUTC, fmtDate } from './lib/formatters'
import { MAX_EVENTS } from './lib/constants'
import { StatsGrid } from './components/StatsGrid'
import { TabBar } from './components/TabBar'
import { Controls } from './components/Controls'
import { EventList } from './components/EventList'
import { ToolsPanel } from './components/ToolsPanel'
import { AdminPanel } from './components/AdminPanel'
import { QrLoginModal } from './components/QrLoginModal'
import { GiftImageModal, type GiftImageModalRef } from './components/GiftImageModal'
import { RoomList } from './components/RoomList'
import { Dropdown } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'

function todayRange(): DateRange {
  const now = new Date()
  return [
    new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0),
    new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59),
  ]
}

const VALID_TABS: TabType[] = ['all', 'danmaku', 'gift', 'superchat', 'guard', 'tools', 'admin']

export default function App() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [rooms, setRooms] = useState<Room[]>([])

  useEffect(() => {
    fetchMe().then(setCurrentUser)
    fetchRooms().then(setRooms)
  }, [])

  return (
    <Routes>
      <Route path="/" element={
        <HomePage
          rooms={rooms}
          currentUser={currentUser}
          onRoomsChanged={() => fetchRooms().then(setRooms)}
        />
      } />
      <Route path="/room/:roomId" element={
        <Navigate to="all" replace />
      } />
      <Route path="/room/:roomId/:tab" element={
        <RoomPage
          rooms={rooms}
          currentUser={currentUser}
          onRoomsChanged={() => fetchRooms().then(setRooms)}
        />
      } />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function HomePage({ rooms, currentUser, onRoomsChanged }: { rooms: Room[]; currentUser: CurrentUser | null; onRoomsChanged: () => void }) {
  const navigate = useNavigate()
  const [bindRoomId, setBindRoomId] = useState<number | null>(null)

  return (
    <div>
      <div className="header">
        <h1>B站直播监控</h1>
        <span style={{ flex: 1 }} />
        {currentUser && (
          <Dropdown title={currentUser.email} placement="bottomEnd" size="xs">
            <Dropdown.Item onSelect={() => authLogout().then(() => location.reload())}>退出登录</Dropdown.Item>
          </Dropdown>
        )}
      </div>
      <RoomList
        rooms={rooms}
        onSelectRoom={(id) => navigate(`/room/${id}/all`)}
        onRoomsChanged={onRoomsChanged}
        onBindBot={(id) => setBindRoomId(id)}
      />
      {bindRoomId && (
        <QrLoginModal
          isOpen={true}
          roomId={bindRoomId}
          onClose={() => setBindRoomId(null)}
          onSuccess={() => { setBindRoomId(null); onRoomsChanged() }}
        />
      )}
    </div>
  )
}

function RoomPage({ rooms, currentUser, onRoomsChanged }: {
  rooms: Room[]
  currentUser: CurrentUser | null
  onRoomsChanged: () => void
}) {
  const { roomId: roomIdStr, tab: tabStr } = useParams()
  const navigate = useNavigate()
  const roomId = Number(roomIdStr)
  const activeTab = (VALID_TABS.includes(tabStr as TabType) ? tabStr : 'all') as TabType

  const [stats, setStats] = useState<Stats | null>(null)
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [botUid, setBotUid] = useState<number | null>(null)
  const [qrModalOpen, setQrModalOpen] = useState(false)
  const [autoScroll, setAutoScroll] = useLocalStorage('autoScroll', true)

  const giftModalRef = useRef<GiftImageModalRef>(null)
  const roomIdRef = useRef(roomId)
  roomIdRef.current = roomId

  const onWsEvent = useCallback((ev: LiveEvent) => {
    if (ev.room_id && ev.room_id !== roomIdRef.current) return
    setEvents((prev) => {
      const next = [...prev, ev]
      return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next
    })
  }, [])

  const connectionStatus = useWebSocket(onWsEvent)

  useEffect(() => {
    setEvents([])
    setStats(null)

    fetchStats(roomId).then(setStats).catch(() => {})
    const interval = setInterval(() => {
      fetchStats(roomId).then(setStats).catch(() => {})
    }, 10000)

    fetchBotStatus(roomId).then((d) => {
      setBotUid(d.logged_in ? d.uid : null)
    }).catch(() => {})

    const now = new Date()
    const from = fmtDate(now) + ' 00:00:00'
    const to = fmtDate(now) + ' 23:59:59'
    fetchEvents(roomId, localToUTC(from), localToUTC(to)).then(setEvents)

    return () => clearInterval(interval)
  }, [roomId])

  function handleQueryRange(from: string, to: string) {
    fetchEvents(roomId, localToUTC(from), localToUTC(to)).then(setEvents)
  }

  function handleTabChange(tab: TabType) {
    navigate(`/room/${roomId}/${tab}`, { replace: true })
  }

  function handleBotClick() {
    if (botUid) {
      if (!confirm('确定解绑机器人？解绑后将无法显示完整用户名和自动送礼')) return
      botLogout(roomId).then(() => setBotUid(null))
    } else {
      setQrModalOpen(true)
    }
  }

  const isAdmin = currentUser?.role === 'admin'
  const currentRoom = rooms.find((r) => r.room_id === roomId)

  // rooms already filtered by backend permissions — if not found, no access
  if (rooms.length > 0 && !currentRoom) {
    return <Navigate to="/" replace />
  }

  function renderContent() {
    if (activeTab === 'admin' && isAdmin) {
      return <AdminPanel rooms={rooms} onRoomsChanged={onRoomsChanged} />
    }
    if (activeTab === 'tools') {
      return <ToolsPanel roomId={roomId} />
    }
    return (
      <>
        <Controls
          autoScroll={autoScroll}
          defaultRange={todayRange()}
          onAutoScrollChange={setAutoScroll}
          onQueryRange={handleQueryRange}
        />
        <EventList
          events={events}
          activeTab={activeTab}
          autoScroll={autoScroll}
          onGenerateGiftImage={(userName) => giftModalRef.current?.showGiftImage(userName)}
        />
      </>
    )
  }

  return (
    <>
      <div className="header">
        <button className="back-btn" onClick={() => navigate('/')}>← 房间</button>
        <h1>{currentRoom?.streamer_name || roomId}</h1>
        <span className="room-info">({roomId})</span>
        <button
          className={`login-btn ${botUid ? 'logged-in' : ''}`}
          onClick={handleBotClick}
        >
          {botUid ? `机器人已绑定 (${botUid})` : '绑定机器人'}
        </button>
        <span className="status">
          <span className={`dot ${connectionStatus}`} />
          {connectionStatus === 'connected' ? '已连接' : connectionStatus === 'connecting' ? '连接中' : '未连接'}
        </span>
        <span style={{ flex: 1 }} />
        {currentUser && (
          <Dropdown title={currentUser.email} placement="bottomEnd" size="xs">
            <Dropdown.Item onSelect={() => authLogout().then(() => location.reload())}>退出登录</Dropdown.Item>
          </Dropdown>
        )}
      </div>

      <StatsGrid stats={stats} />
      <TabBar active={activeTab} onChange={handleTabChange} isAdmin={isAdmin} />

      {renderContent()}

      <QrLoginModal
        isOpen={qrModalOpen}
        roomId={roomId}
        onClose={() => setQrModalOpen(false)}
        onSuccess={(uid) => setBotUid(uid)}
      />

      <GiftImageModal ref={giftModalRef} />
    </>
  )
}
