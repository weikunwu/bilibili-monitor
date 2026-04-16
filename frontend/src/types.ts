export interface LiveEvent {
  event_type: 'danmu' | 'gift' | 'superchat' | 'guard' | 'info'
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

  price?: number
  guard_name?: string
  guard_level?: number
  op_type?: number  // guard: 2=续费 3=新开
  gift_id?: number
  gift_name?: string
  gift_img?: string
  gift_gif?: string
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
  streamer_uid: number
  followers: number

  area_name: string
  parent_area_name: string
  announcement: string
  bot_uid: number
  bot_name: string
  active: boolean
  save_danmu: boolean
}

export interface Stats {
  total: number
  danmu: number
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

export type TabType = 'all' | 'danmu' | 'gift' | 'superchat' | 'guard' | 'blindbox' | 'tools' | 'nicknames' | 'realtime_gifts' | 'admin'

export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting'

export interface GiftGifItem {
  u: GiftUser
  giftName: string
}

export interface BlindBoxGift {
  name: string
  count: number
  value: number
  img: string
}

export interface BlindBoxType {
  name: string
  count: number
  cost: number
  value: number
  profit: number
  gifts: BlindBoxGift[]
}

export interface BlindBoxUser {
  user_name: string
  user_id: number
  avatar: string
  total_boxes: number
  total_cost: number
  total_value: number
  profit: number
  boxes: BlindBoxType[]
}

export interface CurrentUser {
  user_id: number
  email: string
  role: 'admin' | 'user'
}

export interface UserInfo {
  id: number
  email: string
  role: string
  created_at: string
  rooms: number[]
}

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
