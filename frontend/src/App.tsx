import { useState, useEffect, useCallback, useRef } from 'react'
import { Routes, Route, useParams, useNavigate, Navigate } from 'react-router-dom'
import type { LiveEvent, TabType, Room, Stats } from './types'
import { fetchRooms, fetchStats, fetchEvents, fetchMe, type CurrentUser } from './api/client'
import { useWebSocket } from './hooks/useWebSocket'
import { useLocalStorage } from './hooks/useLocalStorage'
import { localToUTC, fmtDate } from './lib/formatters'
import { MAX_EVENTS, TAB_ALL, TAB_BLINDBOX, TAB_TOOLS, EVENT_DANMAKU, EVENT_GIFT, EVENT_SUPERCHAT, EVENT_GUARD } from './lib/constants'
import { StatsGrid } from './components/StatsGrid'
import { TabBar } from './components/TabBar'

import { EventList } from './components/EventList'
import { GiftPanel } from './components/GiftPanel'
import { GuardPanel } from './components/GuardPanel'
import { ToolsPanel } from './components/ToolsPanel'
import { BlindBoxPanel } from './components/BlindBoxPanel'
import { AdminPanel } from './components/AdminPanel'
import { QrLoginModal } from './components/QrLoginModal'
import { GiftImageModal, type GiftImageModalRef } from './components/GiftImageModal'
import { RoomList } from './components/RoomList'
import { Button } from 'rsuite'
import { ProfileMenu } from './components/ProfileMenu'
import type { DateRange } from 'rsuite/DateRangePicker'

function todayRange(): DateRange {
  const now = new Date()
  return [
    new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0),
    new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59),
  ]
}

const VALID_TABS: TabType[] = [TAB_ALL, EVENT_DANMAKU, EVENT_GIFT, EVENT_SUPERCHAT, EVENT_GUARD, TAB_BLINDBOX, TAB_TOOLS]

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
        />
      } />
      <Route path="/admin" element={
        currentUser?.role === 'admin'
          ? <AdminPage rooms={rooms} currentUser={currentUser} onRoomsChanged={() => fetchRooms().then(setRooms)} />
          : <Navigate to="/" replace />
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
        {currentUser && <ProfileMenu user={currentUser} />}
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

function AdminPage({ rooms, currentUser, onRoomsChanged }: { rooms: Room[]; currentUser: CurrentUser | null; onRoomsChanged: () => void }) {
  const navigate = useNavigate()
  return (
    <div>
      <div className="header">
        <Button appearance="subtle" size="xs" onClick={() => navigate('/')}>← 房间</Button>
        <h1>管理后台</h1>
        <span style={{ flex: 1 }} />
        {currentUser && <ProfileMenu user={currentUser} />}
      </div>
      <AdminPanel rooms={rooms} onRoomsChanged={onRoomsChanged} />
    </div>
  )
}

function RoomPage({ rooms, currentUser }: {
  rooms: Room[]
  currentUser: CurrentUser | null
}) {
  const { roomId: roomIdStr, tab: tabStr } = useParams()
  const navigate = useNavigate()
  const roomId = Number(roomIdStr)
  const activeTab = (VALID_TABS.includes(tabStr as TabType) ? tabStr : TAB_ALL) as TabType

  const [stats, setStats] = useState<Stats | null>(null)
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [autoScroll, setAutoScroll] = useLocalStorage('autoScroll', true)
  const [dateRange, setDateRange] = useState<DateRange>(todayRange())

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

    const now = new Date()
    const from = fmtDate(now) + ' 00:00:00'
    const to = fmtDate(now) + ' 23:59:59'
    fetchEvents(roomId, localToUTC(from), localToUTC(to)).then(setEvents)

    return () => clearInterval(interval)
  }, [roomId])

  function handleQueryRange(from: string, to: string, range: DateRange) {
    setDateRange(range)
    fetchEvents(roomId, localToUTC(from), localToUTC(to)).then(setEvents)
  }

  function handleTabChange(tab: TabType) {
    navigate(`/room/${roomId}/${tab}`, { replace: true })
  }

  const currentRoom = rooms.find((r) => r.room_id === roomId)

  // rooms already filtered by backend permissions — if not found, no access
  if (rooms.length > 0 && !currentRoom) {
    return <Navigate to="/" replace />
  }

  function renderContent() {
    if (activeTab === 'blindbox') {
      return <BlindBoxPanel roomId={roomId} />
    }
    if (activeTab === 'tools') {
      return <ToolsPanel roomId={roomId} />
    }
    if (activeTab === EVENT_GUARD) {
      return (
        <GuardPanel
          events={events}
          dateRange={dateRange}
          onQueryRange={handleQueryRange}
          onShowCardPreview={(title, url) => giftModalRef.current?.showPreview(title, url)}
        />
      )
    }
    if (activeTab === EVENT_GIFT) {
      return (
        <GiftPanel
          events={events}
          dateRange={dateRange}
          onQueryRange={handleQueryRange}
          onGenerateGiftImage={(userName) => giftModalRef.current?.showGiftImage(roomId, userName)}
          onGenerateBlindBoxImage={(userName) => giftModalRef.current?.showGiftImage(roomId, userName, true)}
          onShowCardPreview={(title, url) => giftModalRef.current?.showPreview(title, url)}
        />
      )
    }
    return (
      <EventList
        events={events}
        activeTab={activeTab}
        autoScroll={autoScroll}
        showAutoScroll={activeTab === TAB_ALL || activeTab === EVENT_DANMAKU}
        onAutoScrollChange={setAutoScroll}
        dateRange={dateRange}
        onQueryRange={handleQueryRange}
      />
    )
  }

  return (
    <>
      <div className="header">
        <Button appearance="subtle" size="xs" onClick={() => navigate('/')}>← 房间</Button>
        <a className="room-link" href={`https://live.bilibili.com/${roomId}`} target="_blank" rel="noopener noreferrer">
          <h1>{currentRoom?.streamer_name || roomId}</h1>
        </a>
        <span className="room-info">({roomId})</span>
        <span className="status">
          <span className={`dot ${connectionStatus}`} />
          {connectionStatus === 'connected' ? '已连接' : connectionStatus === 'connecting' ? '连接中' : '未连接'}
        </span>
        <span style={{ flex: 1 }} />
        {currentUser && <ProfileMenu user={currentUser} />}
      </div>

      <StatsGrid stats={stats} />
      <TabBar active={activeTab} onChange={handleTabChange} />

      {renderContent()}

      <GiftImageModal ref={giftModalRef} />
    </>
  )
}
