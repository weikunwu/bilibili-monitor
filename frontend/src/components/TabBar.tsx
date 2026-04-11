import { Tabs } from 'rsuite'
import type { TabType } from '../types'

const TAB_LIST: { type: TabType; label: string }[] = [
  { type: 'all', label: '全部' },
  { type: 'danmaku', label: '弹幕' },
  { type: 'gift', label: '礼物' },
  { type: 'superchat', label: '醒目留言' },
  { type: 'guard', label: '上舰' },
  { type: 'tools', label: '工具' },
]

interface Props {
  active: TabType
  onChange: (tab: TabType) => void
}

export function TabBar({ active, onChange }: Props) {
  return (
    <Tabs activeKey={active} onSelect={(key) => key && onChange(key as TabType)}>
      {TAB_LIST.map((t) => (
        <Tabs.Tab key={t.type} eventKey={t.type} title={t.label} />
      ))}
    </Tabs>
  )
}
