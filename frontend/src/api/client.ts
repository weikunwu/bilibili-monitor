import type {
  Room, Stats, LiveEvent, Command, GiftUser,
  CurrentUser, UserInfo, BlindBoxUser,
} from '../types'

export type { CurrentUser, UserInfo, BlindBoxUser, BlindBoxGift, BlindBoxType } from '../types'

export async function fetchRooms(): Promise<Room[]> {
  const res = await fetch('/api/rooms')
  return res.json()
}

export async function fetchStats(roomId: number): Promise<Stats> {
  const res = await fetch(`/api/stats?room_id=${roomId}`)
  return res.json()
}

export async function fetchEvents(
  roomId: number,
  opts?: { timeFrom?: string; timeTo?: string; type?: string; userName?: string; limit?: number },
): Promise<LiveEvent[]> {
  const { timeFrom, timeTo, type, userName, limit = 2000 } = opts || {}
  let url = `/api/events?limit=${limit}&room_id=${roomId}`
  if (timeFrom) url += `&time_from=${encodeURIComponent(timeFrom)}`
  if (timeTo) url += `&time_to=${encodeURIComponent(timeTo)}`
  if (type) url += `&type=${encodeURIComponent(type)}`
  if (userName) url += `&user_name=${encodeURIComponent(userName)}`
  const res = await fetch(url)
  const data: LiveEvent[] = await res.json()
  return data.reverse().map((e) => {
    if (typeof e.extra_json === 'string') {
      try { e.extra = JSON.parse(e.extra_json) } catch { e.extra = {} as never }
    }
    if (!e.extra) e.extra = {} as never
    return e
  })
}

export async function fetchBotStatus(roomId: number): Promise<{ logged_in: boolean; uid: number }> {
  const res = await fetch(`/api/bot/status?room_id=${roomId}`)
  return res.json()
}

export async function botLogout(roomId: number): Promise<void> {
  await fetch(`/api/bot/logout?room_id=${roomId}`, { method: 'POST' })
}

export async function fetchQrCode(roomId: number): Promise<{ url: string; qrcode_key: string; error?: string }> {
  const res = await fetch(`/api/bot/qrcode?room_id=${roomId}`)
  return res.json()
}

export async function pollQrLogin(qrcodeKey: string): Promise<{ code: number; message: string; uid?: number }> {
  const res = await fetch(`/api/bot/poll?qrcode_key=${qrcodeKey}`)
  return res.json()
}

export async function authLogin(email: string, password: string): Promise<{ ok: boolean; role?: string; error?: string }> {
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return res.json()
}

export async function authLogout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' })
}

export async function fetchMe(): Promise<CurrentUser | null> {
  const res = await fetch('/api/me')
  if (!res.ok) return null
  return res.json()
}

export async function fetchUsers(): Promise<UserInfo[]> {
  const res = await fetch('/api/admin/users')
  return res.json()
}

export async function createUser(email: string, password: string, role: string): Promise<{ id: number; email: string; role: string }> {
  const res = await fetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, role }),
  })
  if (!res.ok) {
    const d = await res.json()
    throw new Error(d.detail || '创建失败')
  }
  return res.json()
}

export async function deleteUser(userId: number): Promise<void> {
  await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' })
}

export async function assignUserRooms(userId: number, roomIds: number[]): Promise<void> {
  await fetch(`/api/admin/users/${userId}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room_ids: roomIds }),
  })
}

export async function addRoom(roomId: number): Promise<{ ok: boolean; room_id: number; streamer_name: string }> {
  const res = await fetch('/api/admin/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room_id: roomId }),
  })
  if (!res.ok) {
    const d = await res.json()
    throw new Error(d.detail || '添加失败')
  }
  return res.json()
}

export async function removeRoom(roomId: number): Promise<void> {
  const res = await fetch(`/api/admin/rooms/${roomId}`, { method: 'DELETE' })
  if (!res.ok) {
    const d = await res.json()
    throw new Error(d.detail || '删除失败')
  }
}

export async function toggleSaveDanmu(roomId: number, enabled: boolean): Promise<void> {
  await fetch(`/api/rooms/${roomId}/save-danmu`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}

export async function fetchAutoClip(roomId: number): Promise<boolean> {
  const res = await fetch(`/api/rooms/${roomId}/auto-clip`)
  const data = await res.json()
  return !!data.enabled
}

export async function toggleAutoClip(roomId: number, enabled: boolean): Promise<void> {
  await fetch(`/api/rooms/${roomId}/auto-clip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}

export async function fetchCommands(roomId: number): Promise<Command[]> {
  const res = await fetch(`/api/commands?room_id=${roomId}`)
  return res.json()
}

export async function toggleCommand(roomId: number, cmdId: string): Promise<void> {
  await fetch(`/api/commands/${cmdId}/toggle?room_id=${roomId}`, { method: 'POST' })
}

export async function fetchGiftSummary(
  roomId: number,
  userName: string,
  blindOnly?: boolean,
): Promise<{ date: string; users: GiftUser[] }> {
  let url = `/api/gift-summary?room_id=${roomId}&user_name=${encodeURIComponent(userName)}&sort=tier`
  if (blindOnly) url += '&blind_only=true'
  const res = await fetch(url)
  return res.json()
}

export async function fetchBlindBoxSummary(
  roomId: number,
  timeFrom: string,
  timeTo: string,
  userName?: string,
): Promise<{ period: string; users: BlindBoxUser[] }> {
  const url = `/api/blind-box-summary?room_id=${roomId}`
    + `&time_from=${encodeURIComponent(timeFrom)}`
    + `&time_to=${encodeURIComponent(timeTo)}`
    + (userName ? `&user_name=${encodeURIComponent(userName)}` : '')
  const res = await fetch(url)
  return res.json()
}

export async function fetchGiftGif(giftId: number): Promise<{ gif: string }> {
  const res = await fetch(`/api/gift-gif?gift_id=${giftId}`)
  return res.json()
}

export interface ClipMatch {
  name: string
  meta: { base_mp4: string; clip_start_ts: string; duration_sec: number; overlays: unknown[] }
  overlay: { offset_sec: number; trigger_ts: string; label: string; gift_id: number }
  delta_sec: number
}

export async function matchClip(
  roomId: number,
  userName: string,
  ts: string,
): Promise<ClipMatch | null> {
  const res = await fetch(
    `/api/rooms/${roomId}/clips/match?user_name=${encodeURIComponent(userName)}&ts=${encodeURIComponent(ts)}`,
  )
  if (!res.ok) return null
  return res.json()
}

export function clipComposeUrl(roomId: number, name: string): string {
  return `/api/rooms/${roomId}/clips/${encodeURIComponent(name)}/compose`
}

