import { useState, useEffect, useCallback, useRef } from 'react'
import { Routes, Route, useParams, useNavigate, Navigate } from 'react-router-dom'
import type { LiveEvent, TabType, Room } from './types'
import { fetchRooms, fetchEvents, fetchMe, toggleSaveDanmu, type CurrentUser } from './api/client'
import { useWebSocket } from './hooks/useWebSocket'
import { useLocalStorage } from './hooks/useLocalStorage'
import { localToUTC, fmtDate } from './lib/formatters'
import { confirmDialog } from './lib/confirm'
import { MAX_EVENTS, TAB_LIVE, TAB_REALTIME, TAB_EVENTS, TAB_BLINDBOX, TAB_REACTIVE, TAB_AUTOMATION, TAB_NICKNAMES, TAB_ENTRY_EFFECTS } from './lib/constants'
import { TabSidebar } from './components/TabBar'

import { EventList } from './components/EventList'
import { EventsPanel } from './components/EventsPanel'
import { ReactiveToolsPanel, AutomationToolsPanel } from './components/ToolsPanel'
import { BlindBoxPanel } from './components/BlindBoxPanel'
import { NicknamesPanel } from './components/NicknamesPanel'
import { EntryEffectsPanel } from './components/EntryEffectsPanel'
import { RealtimeGiftsPanel } from './components/RealtimeGiftsPanel'
import { AdminPanel } from './components/AdminPanel'
import { OverlayGiftsPage } from './pages/OverlayGiftsPage'
import { OverlayEntryEffectsPage } from './pages/OverlayEntryEffectsPage'
import { RegisterPage } from './pages/RegisterPage'
import { LoginPage } from './pages/LoginPage'
import { ForgotPasswordPage } from './pages/ForgotPasswordPage'
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

const VALID_TABS: TabType[] = [TAB_LIVE, TAB_REALTIME, TAB_EVENTS, TAB_BLINDBOX, TAB_REACTIVE, TAB_AUTOMATION, TAB_NICKNAMES, TAB_ENTRY_EFFECTS]

export default function App() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [rooms, setRooms] = useState<Room[]>([])

  useEffect(() => {
    // 公开的 OBS 叠加页：没有登录 cookie，跳过初始用户/房间拉取，
    // 否则 fetchRooms 401 会把观众强跳到登录页。
    if (window.location.pathname.startsWith('/overlay/')) { setAuthLoading(false); return }
    // 登录/注册/忘记密码页同理：尚未登录，别去拉保护接口
    if (window.location.pathname.startsWith('/register')) { setAuthLoading(false); return }
    if (window.location.pathname.startsWith('/login')) { setAuthLoading(false); return }
    if (window.location.pathname.startsWith('/forgot-password')) { setAuthLoading(false); return }
    // fetchMe 是判定登录的真相源：null 直接跳登录，避免靠 fetchRooms 的 401 兜底
    // （fetchRooms 已有 redirect，但如果调用顺序/竞态变化就不保险，这里加一道）。
    fetchMe().then((user) => {
      if (!user) {
        window.location.href = '/login'
        return
      }
      setCurrentUser(user)
      setAuthLoading(false)
    })
    fetchRooms().then(setRooms)
  }, [])

  // 刷新 /admin 时 currentUser 初始为 null，不能让保护路由立刻跳转；
  // 等 fetchMe 回来之后再挂 Routes，避免 `role === 'admin'` 在 null 阶段误判跳走。
  if (authLoading) return null

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
        <Navigate to="live" replace />
      } />
      <Route path="/room/:roomId/:tab" element={
        <RoomPage
          rooms={rooms}
          currentUser={currentUser}
          onRoomsChanged={() => fetchRooms().then(setRooms)}
        />
      } />
      <Route path="/admin" element={
        (currentUser?.role === 'admin' || currentUser?.role === 'staff')
          ? <AdminPage rooms={rooms} currentUser={currentUser} onRoomsChanged={() => fetchRooms().then(setRooms)} />
          : <Navigate to="/" replace />
      } />
      <Route path="/overlay/:roomId/gifts" element={<OverlayGiftsPage />} />
      <Route path="/overlay/:roomId/entry-effects" element={<OverlayEntryEffectsPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function HomePage({ rooms, currentUser, onRoomsChanged }: { rooms: Room[]; currentUser: CurrentUser | null; onRoomsChanged: () => void }) {
  const navigate = useNavigate()
  const [bindRoomId, setBindRoomId] = useState<number | null>(null)

  return (
    <>
      <div className="header">
        <h1>布布机器人</h1>
        <span style={{ flex: 1 }} />
        {currentUser && <ProfileMenu user={currentUser} />}
      </div>
      <div className="page-scroll">
      <RoomList
        rooms={rooms}
        onSelectRoom={(id) => navigate(`/room/${id}/all`)}
        onRoomsChanged={onRoomsChanged}
        onBindBot={(id) => setBindRoomId(id)}
        isAdmin={currentUser?.role === 'admin'}
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
    </>
  )
}

function AdminPage({ rooms, currentUser, onRoomsChanged }: { rooms: Room[]; currentUser: CurrentUser | null; onRoomsChanged: () => void }) {
  const navigate = useNavigate()
  return (
    <>
      <div className="header">
        <Button appearance="subtle" size="xs" onClick={() => navigate('/')}>← 房间</Button>
        <h1>管理后台</h1>
        <span style={{ flex: 1 }} />
        {currentUser && <ProfileMenu user={currentUser} />}
      </div>
      <div className="page-scroll">
        <AdminPanel rooms={rooms} onRoomsChanged={onRoomsChanged} role={currentUser?.role || 'user'} />
      </div>
    </>
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
  const activeTab = (VALID_TABS.includes(tabStr as TabType) ? tabStr : TAB_LIVE) as TabType

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

    const now = new Date()
    const from = fmtDate(now) + ' 00:00:00'
    const to = fmtDate(now) + ' 23:59:59'
    fetchEvents(roomId, { timeFrom: localToUTC(from), timeTo: localToUTC(to) }).then(setEvents)
  }, [roomId])

  function handleQueryRange(from: string, to: string, range: DateRange) {
    setDateRange(range)
    fetchEvents(roomId, { timeFrom: localToUTC(from), timeTo: localToUTC(to) }).then(setEvents)
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
    if (activeTab === TAB_BLINDBOX) {
      return <BlindBoxPanel roomId={roomId} />
    }
    if (activeTab === TAB_REACTIVE) {
      return <ReactiveToolsPanel roomId={roomId} />
    }
    if (activeTab === TAB_AUTOMATION) {
      return <AutomationToolsPanel roomId={roomId} />
    }
    if (activeTab === TAB_NICKNAMES) {
      return <NicknamesPanel roomId={roomId} />
    }
    if (activeTab === TAB_ENTRY_EFFECTS) {
      return <EntryEffectsPanel roomId={roomId} />
    }
    if (activeTab === TAB_REALTIME) {
      return <RealtimeGiftsPanel roomId={roomId} />
    }
    if (activeTab === TAB_EVENTS) {
      return (
        <EventsPanel
          roomId={roomId}
          onGenerateGiftImage={(userName) => giftModalRef.current?.showGiftImage(roomId, userName)}
          onGenerateBlindBoxImage={(userName) => giftModalRef.current?.showGiftImage(roomId, userName, true)}
          onGenerateGiftGif={(items) => giftModalRef.current?.showGiftGif(items)}
          onShowCardPreview={(url, ext) => giftModalRef.current?.showPreview(url, ext)}
          onGenerateSuperChatImage={(event, options) => giftModalRef.current?.showSuperChatImage(event, options)}
        />
      )
    }
    // TAB_LIVE: 直播实时流（含所有事件类型 + 记录弹幕开关）
    return (
      <EventList
        events={events}
        activeTab={TAB_LIVE}
        autoScroll={autoScroll}
        showAutoScroll={true}
        saveDanmu={currentRoom?.save_danmu}
        onToggleSaveDanmu={async (checked) => {
          await toggleSaveDanmu(roomId, checked)
          onRoomsChanged()
        }}
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
        <a className="room-link" href={`https://live.bilibili.com/${roomId}`} target="_blank" rel="noopener noreferrer"
          onClick={async (e) => {
            e.preventDefault()
            if (await confirmDialog({ message: '前往直播间？', okText: '前往' })) {
              window.open(`https://live.bilibili.com/${roomId}`, '_blank', 'noopener,noreferrer')
            }
          }}>
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

      <div className="room-layout">
        <TabSidebar active={activeTab} onChange={handleTabChange} />
        <div className="room-content">{renderContent()}</div>
      </div>

      <GiftImageModal ref={giftModalRef} />
    </>
  )
}
