import type { TabType } from '../types'

const TABS: { type: TabType; label: string; adminOnly?: boolean }[] = [
  { type: 'all', label: '全部' },
  { type: 'danmaku', label: '弹幕' },
  { type: 'gift', label: '礼物' },
  { type: 'superchat', label: '醒目留言' },
  { type: 'guard', label: '上舰' },
  { type: 'tools', label: '工具' },
  { type: 'admin', label: '管理', adminOnly: true },
]

interface Props {
  active: TabType
  onChange: (tab: TabType) => void
  isAdmin: boolean
}

export function TabBar({ active, onChange, isAdmin }: Props) {
  return (
    <div className="tabs">
      {TABS.filter((t) => !t.adminOnly || isAdmin).map((t) => (
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
