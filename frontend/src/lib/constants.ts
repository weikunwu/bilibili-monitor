export const MAX_EVENTS = 1000

// Event types
export const EVENT_DANMU = 'danmu' as const
export const EVENT_GIFT = 'gift' as const
export const EVENT_SUPERCHAT = 'superchat' as const
export const EVENT_GUARD = 'guard' as const
export const EVENT_INFO = 'info' as const

// Tab types
export const TAB_LIVE = 'live' as const           // 直播流（原 TAB_ALL）
export const TAB_REALTIME = 'realtime' as const   // 实时礼物榜
export const TAB_EVENTS = 'events' as const       // 事件查询（合并 danmu/gift/guard/superchat）
export const TAB_BLINDBOX = 'blindbox' as const
export const TAB_REACTIVE = 'reactive' as const   // 互动回复（AI/欢迎/感谢/潜水）
export const TAB_AUTOMATION = 'automation' as const // 主动 & 高级（定时/打个有效/自动剪辑）
export const TAB_NICKNAMES = 'nicknames' as const
export const TAB_ADMIN = 'admin' as const

export const BADGE_NAMES: Record<string, string> = {
  danmu: '弹幕',
  gift: '礼物',
  superchat: '醒目留言',
  guard: '大航海',
  info: '信息',
}

export const GUARD_FRAME_URLS: Record<number, string> = {
  1: '/static/guard_frame_1.png',
  2: '/static/guard_frame_2.png',
  3: '/static/guard_frame_3.png',
}

export const CARD_TPL_URLS: Record<string, string> = {
  gold: '/static/card_tpl_gold.png',
  pink: '/static/card_tpl_pink.png',
  purple: '/static/card_tpl_purple.png',
  blue: '/static/card_tpl_blue.png',
}

export const PERIODS = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: 'this_month', label: '今月' },
  { key: 'last_month', label: '上月' },
] as const
