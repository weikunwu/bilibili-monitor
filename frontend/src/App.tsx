import { useState, useEffect, useCallback, useRef } from 'react'
import type { LiveEvent, TabType, Room, Stats } from './types'
import { fetchRooms, fetchStats, fetchEvents, fetchBotStatus, botLogout, authLogout, fetchMe, type CurrentUser } from './api/client'
import { useWebSocket } from './hooks/useWebSocket'
import { useLocalStorage } from './hooks/useLocalStorage'
import { localToUTC, fmtDate } from './lib/formatters'
import { MAX_EVENTS } from './lib/constants'
import { Header } from './components/Header'
import { StatsGrid } from './components/StatsGrid'
import { TabBar } from './components/TabBar'
import { Controls } from './components/Controls'
import { EventList } from './components/EventList'
import { ToolsPanel } from './components/ToolsPanel'
import { AdminPanel } from './components/AdminPanel'
import { QrLoginModal } from './components/QrLoginModal'
import { GiftImageModal, type GiftImageModalRef } from './components/GiftImageModal'
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
    fetchRooms().then((r) => {
      setRooms(r)
      if (r.length > 0) setCurrentRoomId(r[0].room_id)
    })
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

    // Default: load today's events
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

  function handleRoomChange(roomId: number) {
    setCurrentRoomId(roomId)
    setEvents([])
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

  function renderContent() {
    if (activeTab === 'admin' && isAdmin) {
      return <AdminPanel rooms={rooms} onRoomsChanged={() => fetchRooms().then((r) => { setRooms(r) })} />
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
      <Header
        rooms={rooms}
        currentRoomId={currentRoomId}
        onRoomChange={handleRoomChange}
        connectionStatus={connectionStatus}
        botUid={botUid}
        onBotClick={handleBotClick}
        onLogout={() => authLogout().then(() => location.reload())}
        currentUser={currentUser}
      />

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
