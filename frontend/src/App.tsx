import { useState, useEffect, useCallback, useRef } from 'react'
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
import type { DateRange } from 'rsuite/DateRangePicker'

function todayRange(): DateRange {
  const now = new Date()
  return [
    new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0),
    new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59),
  ]
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [rooms, setRooms] = useState<Room[]>([])
  const [currentRoomId, setCurrentRoomId] = useState<number | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [activeTab, setActiveTab] = useState<TabType>('all')
  const [botUid, setBotUid] = useState<number | null>(null)
  const [qrModalOpen, setQrModalOpen] = useState(false)

  const [autoScroll, setAutoScroll] = useLocalStorage('autoScroll', true)

  const giftModalRef = useRef<GiftImageModalRef>(null)
  const currentRoomIdRef = useRef(currentRoomId)
  currentRoomIdRef.current = currentRoomId

  const onWsEvent = useCallback((ev: LiveEvent) => {
    const roomId = currentRoomIdRef.current
    if (roomId && ev.room_id && ev.room_id !== roomId) return
    setEvents((prev) => {
      const next = [...prev, ev]
      return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next
    })
  }, [])

  const connectionStatus = useWebSocket(onWsEvent)

  useEffect(() => {
    fetchMe().then(setCurrentUser)
    fetchRooms().then(setRooms)
  }, [])

  useEffect(() => {
    if (!currentRoomId) return

    fetchStats(currentRoomId).then(setStats).catch(() => {})
    const interval = setInterval(() => {
      fetchStats(currentRoomId).then(setStats).catch(() => {})
    }, 10000)

    fetchBotStatus(currentRoomId).then((d) => {
      setBotUid(d.logged_in ? d.uid : null)
    }).catch(() => {})

    loadTodayEvents(currentRoomId)

    return () => clearInterval(interval)
  }, [currentRoomId])

  async function loadTodayEvents(roomId: number) {
    const now = new Date()
    const from = fmtDate(now) + ' 00:00:00'
    const to = fmtDate(now) + ' 23:59:59'
    const data = await fetchEvents(roomId, localToUTC(from), localToUTC(to))
    setEvents(data)
  }

  function handleQueryRange(from: string, to: string) {
    if (!currentRoomId) return
    fetchEvents(currentRoomId, localToUTC(from), localToUTC(to)).then(setEvents)
  }

  function handleSelectRoom(roomId: number) {
    setCurrentRoomId(roomId)
    setEvents([])
    setActiveTab('all')
  }

  function handleBackToRooms() {
    setCurrentRoomId(null)
    setEvents([])
    setStats(null)
  }

  function handleBotClick() {
    if (botUid) {
      if (!confirm('确定解绑机器人？解绑后将无法显示完整用户名和自动送礼')) return
      if (currentRoomId) botLogout(currentRoomId).then(() => setBotUid(null))
    } else {
      setQrModalOpen(true)
    }
  }

  const isAdmin = currentUser?.role === 'admin'
  const currentRoom = rooms.find((r) => r.room_id === currentRoomId)

  // Room selection page
  if (!currentRoomId) {
    return (
      <div>
        <div className="header">
          <h1>B站直播监控</h1>
          <span style={{ flex: 1 }} />
          {currentUser && (
            <span style={{ fontSize: 12, color: '#888' }}>{currentUser.email}</span>
          )}
          <button className="login-btn" style={{ background: '#555' }} onClick={() => authLogout().then(() => location.reload())}>
            退出登录
          </button>
        </div>
        <RoomList rooms={rooms} onSelectRoom={handleSelectRoom} />
      </div>
    )
  }

  // Room detail page
  function renderContent() {
    if (activeTab === 'admin' && isAdmin) {
      return <AdminPanel rooms={rooms} onRoomsChanged={() => fetchRooms().then(setRooms)} />
    }
    if (activeTab === 'tools') {
      return <ToolsPanel roomId={currentRoomId} />
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
        <button className="back-btn" onClick={handleBackToRooms}>← 房间</button>
        <h1>{currentRoom?.streamer_name || currentRoomId}</h1>
        <span className="room-info">({currentRoomId})</span>
        <button
          className={`login-btn ${botUid ? 'logged-in' : ''}`}
          onClick={handleBotClick}
        >
          {botUid ? `机器人已绑定 (${botUid})` : '绑定机器人'}
        </button>
        <span className={`status`}>
          <span className={`dot ${connectionStatus}`} />
          {connectionStatus === 'connected' ? '已连接' : connectionStatus === 'connecting' ? '连接中' : '未连接'}
        </span>
        <span style={{ flex: 1 }} />
        {currentUser && (
          <span style={{ fontSize: 12, color: '#888' }}>{currentUser.email}</span>
        )}
        <button className="login-btn" style={{ background: '#555' }} onClick={() => authLogout().then(() => location.reload())}>
          退出登录
        </button>
      </div>

      <StatsGrid stats={stats} />
      <TabBar active={activeTab} onChange={setActiveTab} isAdmin={isAdmin} />

      {renderContent()}

      <QrLoginModal
        isOpen={qrModalOpen}
        roomId={currentRoomId}
        onClose={() => setQrModalOpen(false)}
        onSuccess={(uid) => setBotUid(uid)}
      />

      <GiftImageModal ref={giftModalRef} />
    </>
  )
}
