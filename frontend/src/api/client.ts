import type { Room, Stats, LiveEvent, Command, GiftUser } from '../types'

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
  timeFrom?: string,
  timeTo?: string,
  limit = 2000,
): Promise<LiveEvent[]> {
  let url = `/api/events?limit=${limit}&room_id=${roomId}`
  if (timeFrom) url += `&time_from=${encodeURIComponent(timeFrom)}`
  if (timeTo) url += `&time_to=${encodeURIComponent(timeTo)}`
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

export async function authLogin(password: string): Promise<{ ok: boolean }> {
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  return res.json()
}

export async function authLogout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' })
}

export async function fetchCommands(roomId: number): Promise<Command[]> {
  const res = await fetch(`/api/commands?room_id=${roomId}`)
  return res.json()
}

export async function toggleCommand(roomId: number, cmdId: string): Promise<void> {
  await fetch(`/api/commands/${cmdId}/toggle?room_id=${roomId}`, { method: 'POST' })
}

export async function fetchGiftSummary(
  userName: string,
  tzOffset: number,
): Promise<{ date: string; users: GiftUser[] }> {
  const res = await fetch(
    `/api/gift-summary?user_name=${encodeURIComponent(userName)}&tz_offset=${tzOffset}`,
  )
  return res.json()
}

export async function fetchGiftGif(giftId: number): Promise<{ gif: string }> {
  const res = await fetch(`/api/gift-gif?gift_id=${giftId}`)
  return res.json()
}

export async function fetchGiftGifCard(userName: string, giftName: string, tzOffset: number): Promise<Blob | null> {
  const res = await fetch(
    `/api/gift-gif-card?user_name=${encodeURIComponent(userName)}&gift_name=${encodeURIComponent(giftName)}&tz_offset=${tzOffset}`,
  )
  if (!res.ok || res.headers.get('content-type')?.includes('json')) {
    return null
  }
  return res.blob()
}
