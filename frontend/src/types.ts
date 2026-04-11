export interface LiveEvent {
  event_type: 'danmaku' | 'gift' | 'superchat' | 'guard' | 'info'
  timestamp: string
  user_name?: string
  user_id?: number
  content?: string
  room_id?: number
  extra: EventExtra
  extra_json?: string
}

export interface EventExtra {
  avatar?: string
  total_coin?: number
  coin_type?: string
  price?: number
  guard_name?: string
  guard_level?: number
  gift_id?: number
  gift_name?: string
  gift_img?: string
  num?: number
  action?: string
  blind_name?: string
  combo?: boolean
  emoticon?: { url: string; width?: number; height?: number }
  emots?: Record<string, { url: string }>
  msg_type?: number
}

export interface Room {
  room_id: number
  real_room_id: number
  streamer_name: string
  streamer_avatar: string
  room_title: string
  live_status: number
  ruid: number
  followers: number
  guard_count: number
  area_name: string
  parent_area_name: string
  announcement: string
  bot_uid: number
  bot_name: string
  active: boolean
}

export interface Stats {
  total: number
  danmaku: number
  gift: number
  superchat: number
  guard: number
  sc_total_price: number
}

export interface Command {
  id: string
  name: string
  type: string
  description: string
  enabled: boolean
  config: Record<string, unknown>
}

export type TabType = 'all' | 'danmaku' | 'gift' | 'superchat' | 'guard' | 'tools' | 'admin'

export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting'

export interface GiftUser {
  user_name: string
  avatar: string
  gifts: Record<string, number>
  gift_imgs: Record<string, string>
  gift_actions: Record<string, string>
  gift_coins: Record<string, number>
  gift_ids: Record<string, number>
  gift_gifs?: Record<string, string>
  guard_level: number
  total_coin: number
}
