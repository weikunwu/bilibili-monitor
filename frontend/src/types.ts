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

export interface MedalInfo {
  medal_name: string
  medal_level: number
  medal_color?: number
  medal_color_start?: number
  medal_color_end?: number
  medal_color_border?: number
  guard_level?: number
  anchor_uname?: string
  is_lighted?: number
}

// uinfo.medal — 新版粉丝牌（v2 带 alpha 的 RGBA hex 字符串）
export interface MedalV2 {
  name: string
  level: number
  is_light?: number
  guard_level?: number
  guard_icon?: string
  honor_icon?: string
  v2_medal_color_start?: string
  v2_medal_color_end?: string
  v2_medal_color_border?: string
  v2_medal_color_level?: string
  v2_medal_color_text?: string
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

  // Superchat render fields (all optional; B站 returns per price tier)
  duration?: number
  face_frame?: string
  name_color?: string
  user_level?: number
  level_color?: string
  background_color?: string
  background_bottom_color?: string
  background_color_start?: string
  background_color_end?: string
  background_price_color?: string
  message_font_color?: string
  background_image?: string
  background_icon?: string
  color_point?: number
  medal_info?: MedalInfo | null
  medal_v2?: MedalV2 | null
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
  needs_relogin?: boolean  // SESSDATA/csrf 失效，需要用户重新扫码
  active: boolean
  save_danmu: boolean
  expires_at: string | null  // UTC 'YYYY-MM-DD HH:MM:SS'，null 表示永不过期
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

export type TabType = 'live' | 'realtime' | 'events' | 'blindbox' | 'danmu_history' | 'reactive' | 'automation' | 'nicknames' | 'effects' | 'weekly' | 'admin'
/** 事件查询内的类型切换 chip（不走路由，不是 TabType） */
export type EventsKind = 'danmu' | 'gift' | 'guard' | 'superchat'

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
  role: 'admin' | 'staff' | 'user'
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
