import type {
  Room, Stats, LiveEvent, Command, GiftUser,
  CurrentUser, UserInfo, BlindBoxUser,
} from '../types'
import { toast } from '../lib/toast'

export type { CurrentUser, UserInfo, BlindBoxUser, BlindBoxGift, BlindBoxType } from '../types'

export async function fetchRooms(): Promise<Room[]> {
  const res = await fetch('/api/rooms')
  // 生产环境未登录时后端返回 LOGIN_HTML 替换页面，dev 下 Vite 接管了
  // SPA 路由走不到那一步，这里显式跳一下。
  if (res.status === 401) {
    window.location.href = '/login'
    return []
  }
  return res.json()
}

export async function fetchStats(roomId: number): Promise<Stats> {
  const res = await fetch(`/api/stats?room_id=${roomId}`)
  return res.json()
}

/** 后端 ORDER BY id DESC；reverse=true 转成老→新（直播流需要按时间追加），false 保持新→老（历史查询默认）。 */
async function _fetchEventsUrl(url: string, reverse: boolean): Promise<LiveEvent[]> {
  const res = await fetch(url)
  if (!res.ok) {
    const d = await res.json().catch(() => ({} as { detail?: string }))
    toast(d.detail || '查询失败', 'error')
    return []
  }
  const data: LiveEvent[] = await res.json()
  const arr = reverse ? data.reverse() : data
  return arr.map((e) => {
    if (typeof e.extra_json === 'string') {
      try { e.extra = JSON.parse(e.extra_json) } catch { e.extra = {} as never }
    }
    if (!e.extra) e.extra = {} as never
    return e
  })
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
  return _fetchEventsUrl(url, true)
}

export async function fetchEventsByType(
  roomId: number,
  type: 'danmu' | 'gift' | 'guard' | 'superchat',
  opts?: { timeFrom?: string; timeTo?: string; limit?: number },
): Promise<LiveEvent[]> {
  const { timeFrom, timeTo, limit = 5000 } = opts || {}
  let url = `/api/events/${type}?limit=${limit}&room_id=${roomId}`
  if (timeFrom) url += `&time_from=${encodeURIComponent(timeFrom)}`
  if (timeTo) url += `&time_to=${encodeURIComponent(timeTo)}`
  return _fetchEventsUrl(url, false)
}

function _decorateEvents(arr: LiveEvent[]): LiveEvent[] {
  return arr.map((e) => {
    if (typeof e.extra_json === 'string') {
      try { e.extra = JSON.parse(e.extra_json) } catch { e.extra = {} as never }
    }
    if (!e.extra) e.extra = {} as never
    return e
  })
}

export async function fetchEventsPage(
  roomId: number,
  type: 'danmu' | 'gift' | 'guard' | 'superchat',
  opts: {
    timeFrom?: string; timeTo?: string;
    userNames?: string[]; offset?: number; limit?: number;
  },
): Promise<{ events: LiveEvent[]; total: number }> {
  const { timeFrom, timeTo, userNames, offset = 0, limit = 50 } = opts
  const qs = new URLSearchParams()
  qs.set('room_id', String(roomId))
  qs.set('limit', String(limit))
  qs.set('offset', String(offset))
  if (timeFrom) qs.set('time_from', timeFrom)
  if (timeTo) qs.set('time_to', timeTo)
  for (const u of userNames || []) qs.append('user_name', u)
  const res = await fetch(`/api/events/${type}/page?${qs.toString()}`)
  if (!res.ok) {
    const d = await res.json().catch(() => ({} as { detail?: string }))
    toast(d.detail || '查询失败', 'error')
    return { events: [], total: 0 }
  }
  const data = await res.json() as { events: LiveEvent[]; total: number }
  return { events: _decorateEvents(data.events), total: data.total }
}

export async function fetchEventUsers(
  roomId: number,
  type: 'danmu' | 'gift' | 'guard' | 'superchat',
  opts: { timeFrom?: string; timeTo?: string },
): Promise<{ name: string; count: number }[]> {
  const { timeFrom, timeTo } = opts
  const qs = new URLSearchParams()
  qs.set('room_id', String(roomId))
  if (timeFrom) qs.set('time_from', timeFrom)
  if (timeTo) qs.set('time_to', timeTo)
  const res = await fetch(`/api/events/${type}/users?${qs.toString()}`)
  if (!res.ok) return []
  return res.json()
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

export async function sendRegisterCode(
  email: string, turnstileToken: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/register/send-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, turnstile_token: turnstileToken }),
  })
  return res.json()
}

export async function registerWithCode(
  email: string, code: string, password: string,
): Promise<{ ok: boolean; role?: string; error?: string }> {
  const res = await fetch('/api/register/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code, password }),
  })
  return res.json()
}

export async function sendPasswordResetCode(
  email: string, turnstileToken: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/password-reset/send-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, turnstile_token: turnstileToken }),
  })
  return res.json()
}

export async function fetchPublicConfig(): Promise<{ turnstile_site_key: string }> {
  const res = await fetch('/api/public-config')
  if (!res.ok) return { turnstile_site_key: '' }
  return res.json()
}

export async function resetPassword(
  email: string, code: string, password: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/password-reset/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code, password }),
  })
  return res.json()
}

export async function changePassword(
  oldPassword: string,
  newPassword: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
  })
  return res.json()
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

export async function updateUserRole(userId: number, role: string): Promise<void> {
  const res = await fetch(`/api/admin/users/${userId}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.detail || '修改角色失败')
  }
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

export async function bindRoomSelf(roomId: number): Promise<{ ok: boolean; room_id: number }> {
  const res = await fetch(`/api/rooms/${roomId}/bind`, { method: 'POST' })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.detail || '绑定失败')
  }
  return res.json()
}

export async function unbindRoomSelf(roomId: number): Promise<void> {
  const res = await fetch(`/api/rooms/${roomId}/unbind`, { method: 'POST' })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.detail || '解绑失败')
  }
}

export async function removeRoom(roomId: number): Promise<void> {
  const res = await fetch(`/api/admin/rooms/${roomId}`, { method: 'DELETE' })
  if (!res.ok) {
    const d = await res.json()
    throw new Error(d.detail || '删除失败')
  }
}

export async function fetchPopularityQuota(
  roomId: number,
): Promise<{ remaining: number; per_bot_limit: number; available_bot_count: number }> {
  const res = await fetch(`/api/admin/rooms/${roomId}/popularity-vote/quota`)
  if (!res.ok) return { remaining: 0, per_bot_limit: 200, available_bot_count: 0 }
  return res.json()
}

export async function sendPopularityVote(
  roomId: number, count: number,
): Promise<{
  ok: boolean
  requested: number
  sent: number
  aborted_by_cooling: boolean
  gift_id: number
  gift_price: number
  bots: { uid: number; name: string; sent: number }[]
  failures: { uid: number; name: string; tried: number; sent: number; error: string; cooling: boolean }[]
  total_remaining_this_hour: number
}> {
  const res = await fetch(`/api/admin/rooms/${roomId}/popularity-vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.detail || '送人气票失败')
  }
  return res.json()
}

export async function popularityLikes(
  roomId: number, count: number,
): Promise<{
  ok: boolean
  room_id: number
  real_room_id: number
  room_title: string
  streamer_name: string
  scheduled: number
  eta_seconds: number
  bot_count: number
  bots: { uid: number; name: string; plan: number }[]
}> {
  const res = await fetch('/api/admin/popularity/likes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room_id: roomId, count }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.detail || '触发点赞失败')
  }
  return res.json()
}

export async function popularityVote(
  roomId: number, count: number,
): Promise<{
  ok: boolean
  room_id: number
  real_room_id: number
  room_title: string
  streamer_name: string
  requested: number
  sent: number
  aborted_by_cooling: boolean
  gift_id: number
  gift_price: number
  bots: { uid: number; name: string; sent: number }[]
  failures: { uid: number; name: string; tried: number; sent: number; error: string; cooling: boolean }[]
  total_remaining_this_hour: number
}> {
  const res = await fetch('/api/admin/popularity/vote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room_id: roomId, count }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.detail || '送人气票失败')
  }
  return res.json()
}

export async function createRenewalTokens(count = 1, months = 1): Promise<string[]> {
  const res = await fetch('/api/admin/renewal-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count, months }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.detail || '生成续费码失败')
  }
  const data = await res.json()
  return data.tokens || []
}

export interface RenewalToken {
  token: string
  months: number
  created_at: string
  used_at: string | null
  used_by_user_id: number | null
  used_for_room_id: number | null
}

export async function listRenewalTokens(): Promise<RenewalToken[]> {
  const res = await fetch('/api/admin/renewal-tokens')
  if (!res.ok) return []
  return await res.json()
}

export interface DefaultBot {
  uid: number
  name: string
  has_cookie: boolean
  created_at: string
  in_memory: boolean
  needs_relogin: boolean
  cooling: boolean
  battery: number | null   // 电池总数（B 币 × 10 + 金瓜子 / 100）；null 表示拉取失败
}

export async function listDefaultBots(force = false): Promise<DefaultBot[]> {
  // force=true 绕过后端 60s 钱包缓存重拉所有 bot 的电池数。
  const res = await fetch(`/api/admin/default-bots${force ? '?force=1' : ''}`)
  if (!res.ok) return []
  return await res.json()
}

export async function fetchDefaultBotQrCode(): Promise<{
  url: string; qrcode_key: string; error?: string
}> {
  const res = await fetch('/api/admin/default-bots/qrcode')
  return res.json()
}

export async function pollDefaultBotQrLogin(
  qrcodeKey: string,
): Promise<{ code: number; message: string; uid?: number; name?: string }> {
  const res = await fetch(`/api/admin/default-bots/poll?qrcode_key=${qrcodeKey}`)
  return res.json()
}

export async function deleteDefaultBot(uid: number): Promise<void> {
  const res = await fetch(`/api/admin/default-bots/${uid}`, { method: 'DELETE' })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.detail || '删除失败')
  }
}

export interface RechargeOrder {
  order_id: string
  code_url: string                                 // QR 渠道下 B 站给的扫码页 url
  pay_center_params: Record<string, unknown> | null // cash 渠道下要 POST 给收银台的参数
  expire: number
}

export async function rechargeDefaultBot(
  uid: number, yuan: number, channel: 'qr' | 'cash',
): Promise<RechargeOrder> {
  const res = await fetch(`/api/admin/default-bots/${uid}/recharge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yuan, channel }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.detail || '下单失败')
  }
  return res.json()
}

export async function queryRechargeStatus(
  uid: number, orderId: string,
): Promise<{ status: number; order_id?: string }> {
  const res = await fetch(
    `/api/admin/default-bots/${uid}/recharge/status?order_id=${encodeURIComponent(orderId)}`,
  )
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.detail || '查单失败')
  }
  return res.json()
}

export interface RenewalPlan {
  id: string
  months: number
  yuan: number
  label: string
}

export interface PaymentPlansInfo {
  plans: RenewalPlan[]
  channels: { alipay: boolean }
}

export async function fetchPaymentPlans(): Promise<PaymentPlansInfo> {
  const res = await fetch('/api/payments/plans')
  if (!res.ok) return { plans: [], channels: { alipay: false } }
  return res.json()
}

export interface PaymentOrder {
  out_trade_no: string
  code_url: string
  channel: 'alipay'
  expire: number
  yuan: number
  months: number
}

export async function createPaymentOrder(
  roomId: number, planId: string, channel: 'alipay',
): Promise<PaymentOrder> {
  const res = await fetch(`/api/rooms/${roomId}/payments/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: planId, channel }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.detail || '下单失败')
  }
  return res.json()
}

export interface PaymentStatus {
  status: 'pending' | 'paid' | 'expired' | 'rejected'
  expires_at?: string
}

export async function fetchPaymentStatus(outTradeNo: string): Promise<PaymentStatus> {
  const res = await fetch(`/api/payments/order/${encodeURIComponent(outTradeNo)}/status`)
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.detail || '查单失败')
  }
  return res.json()
}

export async function redeemRoomToken(roomId: number, token: string): Promise<{ expires_at: string }> {
  const res = await fetch(`/api/rooms/${roomId}/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.detail || '兑换失败')
  }
  return await res.json()
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

export async function fetchOverlayToken(roomId: number): Promise<string> {
  const r = await fetch(`/api/rooms/${roomId}/overlay-token`)
  const d = await r.json()
  return String(d.token || '')
}

export async function rotateOverlayToken(roomId: number): Promise<string> {
  const r = await fetch(`/api/rooms/${roomId}/overlay-token/rotate`, { method: 'POST' })
  const d = await r.json()
  return String(d.token || '')
}

export interface OverlaySettings {
  max_events: number
  min_price: number
  max_price: number
  price_mode: 'total' | 'unit'
  show_gift: boolean
  show_blind: boolean
  show_guard: boolean
  show_superchat: boolean
  time_range: 'today' | 'week' | 'live'
  scroll_enabled: boolean  // 是否开启溢出循环滚动
  scroll_speed: number     // 百分比 0–100，scroll_enabled=true 时生效
  cleared_at: string
}

export async function fetchOverlaySettings(roomId: number): Promise<OverlaySettings> {
  const r = await fetch(`/api/rooms/${roomId}/overlay-settings`)
  if (!r.ok) throw new Error('读取 overlay 设置失败')
  return r.json()
}

export async function updateOverlaySettings(
  roomId: number, patch: Partial<OverlaySettings>,
): Promise<OverlaySettings> {
  const r = await fetch(`/api/rooms/${roomId}/overlay-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!r.ok) {
    const d = await r.json().catch(() => ({}))
    throw new Error(d.detail || '保存失败')
  }
  return r.json()
}

export async function clearOverlayHistory(roomId: number): Promise<OverlaySettings> {
  const r = await fetch(`/api/rooms/${roomId}/overlay-settings/clear`, { method: 'POST' })
  if (!r.ok) {
    const d = await r.json().catch(() => ({}))
    throw new Error(d.detail || '清除失败')
  }
  return r.json()
}

export async function fetchCommands(roomId: number): Promise<Command[]> {
  const res = await fetch(`/api/commands?room_id=${roomId}`)
  return res.json()
}

export async function toggleCommand(roomId: number, cmdId: string): Promise<void> {
  await fetch(`/api/commands/${cmdId}/toggle?room_id=${roomId}`, { method: 'POST' })
}

export async function saveCommandConfig(roomId: number, cmdId: string, config: Record<string, unknown>): Promise<void> {
  await fetch(`/api/commands/${cmdId}/config?room_id=${roomId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  })
}

export interface CheapGift { gift_id: number; name: string; price: number; img: string }
export async function fetchCheapGifts(roomId: number): Promise<CheapGift[]> {
  const res = await fetch(`/api/rooms/${roomId}/cheap-gifts`)
  if (!res.ok) return []
  return res.json()
}

export async function fetchAllGifts(roomId: number): Promise<CheapGift[]> {
  const res = await fetch(`/api/rooms/${roomId}/all-gifts`)
  if (!res.ok) return []
  return res.json()
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
  if (!res.ok) {
    const d = await res.json().catch(() => ({} as { detail?: string }))
    toast(d.detail || '查询失败', 'error')
    return { period: '', users: [] }
  }
  return res.json()
}

export interface Nickname {
  user_id: number
  user_name: string
  nickname: string
  updated_at: string
}

export async function fetchNicknames(roomId: number): Promise<Nickname[]> {
  const res = await fetch(`/api/rooms/${roomId}/nicknames`)
  return res.json()
}

export async function saveNickname(
  roomId: number, userId: number, userName: string, nickname: string,
): Promise<void> {
  await fetch(`/api/rooms/${roomId}/nicknames/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: userName, nickname }),
  })
}

export async function deleteNickname(roomId: number, userId: number): Promise<void> {
  await fetch(`/api/rooms/${roomId}/nicknames/${userId}`, { method: 'DELETE' })
}

export async function fetchRoomUsers(
  roomId: number, search: string,
): Promise<{ user_id: number; user_name: string }[]> {
  const res = await fetch(`/api/rooms/${roomId}/users?search=${encodeURIComponent(search)}`)
  return res.json()
}

export interface BannedNicknameWord {
  id: number
  word: string
  created_at: string
}

export async function fetchBannedNicknameWords(roomId: number): Promise<BannedNicknameWord[]> {
  const res = await fetch(`/api/rooms/${roomId}/banned-nickname-words`)
  if (!res.ok) return []
  return res.json()
}

export async function addBannedNicknameWord(
  roomId: number, word: string,
): Promise<BannedNicknameWord | null> {
  const res = await fetch(`/api/rooms/${roomId}/banned-nickname-words`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({} as { detail?: string }))
    toast(d.detail || '添加失败', 'error')
    return null
  }
  return res.json()
}

export async function deleteBannedNicknameWord(roomId: number, wordId: number): Promise<void> {
  await fetch(`/api/rooms/${roomId}/banned-nickname-words/${wordId}`, { method: 'DELETE' })
}

export interface EntryEffect {
  id: number
  room_id: number
  uid: number
  user_name: string
  video_filename: string
  preset_key: string
  size_bytes: number
  created_at: string
}

export async function fetchEntryEffects(roomId: number): Promise<EntryEffect[]> {
  const res = await fetch(`/api/rooms/${roomId}/effects/entries`)
  if (!res.ok) return []
  return res.json()
}

export async function uploadEntryEffect(
  roomId: number, uid: number, userName: string, file: File,
): Promise<EntryEffect> {
  const fd = new FormData()
  fd.append('uid', String(uid))
  fd.append('user_name', userName)
  fd.append('file', file)
  const res = await fetch(`/api/rooms/${roomId}/effects/entries`, { method: 'POST', body: fd })
  if (!res.ok) {
    const d = await res.json().catch(() => ({} as { detail?: string }))
    throw new Error(d.detail || '上传失败')
  }
  return res.json()
}

export async function bindEntryEffectPreset(
  roomId: number, uid: number, userName: string, presetKey: string,
): Promise<EntryEffect> {
  const res = await fetch(`/api/rooms/${roomId}/effects/entries/preset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, user_name: userName, preset_key: presetKey }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({} as { detail?: string }))
    throw new Error(d.detail || '保存失败')
  }
  return res.json()
}

export async function deleteEntryEffect(roomId: number, effectId: number): Promise<void> {
  const res = await fetch(`/api/rooms/${roomId}/effects/entries/${effectId}`, { method: 'DELETE' })
  if (!res.ok) {
    const d = await res.json().catch(() => ({} as { detail?: string }))
    throw new Error(d.detail || '删除失败')
  }
}

export interface GiftEffect {
  id: number
  room_id: number
  gift_id: number
  gift_name: string
  video_filename: string
  size_bytes: number
  created_at: string
}

export async function fetchGiftEffects(roomId: number): Promise<GiftEffect[]> {
  const res = await fetch(`/api/rooms/${roomId}/effects/gifts`)
  if (!res.ok) return []
  return res.json()
}

export async function uploadGiftEffect(
  roomId: number, giftId: number, giftName: string, file: File,
): Promise<GiftEffect> {
  const fd = new FormData()
  fd.append('gift_id', String(giftId))
  fd.append('gift_name', giftName)
  fd.append('file', file)
  const res = await fetch(`/api/rooms/${roomId}/effects/gifts`, { method: 'POST', body: fd })
  if (!res.ok) {
    const d = await res.json().catch(() => ({} as { detail?: string }))
    throw new Error(d.detail || '上传失败')
  }
  return res.json()
}

export async function deleteGiftEffect(roomId: number, effectId: number): Promise<void> {
  const res = await fetch(`/api/rooms/${roomId}/effects/gifts/${effectId}`, { method: 'DELETE' })
  if (!res.ok) {
    const d = await res.json().catch(() => ({} as { detail?: string }))
    throw new Error(d.detail || '删除失败')
  }
}

export interface EffectSettings {
  sound_on: boolean
  gift_effect_test_enabled: boolean
}

export async function fetchEffectSettings(roomId: number): Promise<EffectSettings> {
  const res = await fetch(`/api/rooms/${roomId}/effects/settings`)
  if (!res.ok) return { sound_on: false, gift_effect_test_enabled: true }
  return res.json()
}

export async function updateEffectSettings(
  roomId: number, patch: Partial<EffectSettings>,
): Promise<void> {
  await fetch(`/api/rooms/${roomId}/effects/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
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


