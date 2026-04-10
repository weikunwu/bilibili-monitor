import type { TabType } from '../types'

const TABS: { type: TabType; label: string }[] = [
  { type: 'all', label: '全部' },
  { type: 'danmaku', label: '弹幕' },
  { type: 'gift', label: '礼物' },
  { type: 'superchat', label: '醒目留言' },
  { type: 'guard', label: '上舰' },
  { type: 'enter', label: '进场' },
  { type: 'tools', label: '工具' },
]

interface Props {
  active: TabType
  onChange: (tab: TabType) => void
}

export function TabBar({ active, onChange }: Props) {
  return (
    <div className="tabs">
      {TABS.map((t) => (
        <div
          key={t.type}
          className={`tab ${active === t.type ? 'active' : ''}`}
          onClick={() => onChange(t.type)}
        >
          {t.label}
        </div>
      ))}
    </div>
  )
}
