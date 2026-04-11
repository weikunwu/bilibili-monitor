export const MAX_EVENTS = 1000

export const BADGE_NAMES: Record<string, string> = {
  danmaku: '弹幕',
  gift: '礼物',
  superchat: 'SC',
  guard: '上舰',
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
  { key: 'this_month', label: '本月' },
  { key: 'last_month', label: '上月' },
] as const
