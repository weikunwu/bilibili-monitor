import { Tabs } from 'rsuite'
import type { TabType } from '../types'
import { TAB_ALL, EVENT_DANMAKU, EVENT_GIFT, EVENT_SUPERCHAT, EVENT_GUARD, TAB_BLINDBOX, TAB_TOOLS } from '../lib/constants'

const TAB_LIST: { type: TabType; label: string }[] = [
  { type: TAB_ALL, label: '全部' },
  { type: EVENT_DANMAKU, label: '弹幕' },
  { type: EVENT_GIFT, label: '礼物' },
  { type: EVENT_SUPERCHAT, label: '醒目留言' },
  { type: EVENT_GUARD, label: '上舰' },
  { type: TAB_BLINDBOX, label: '盲盒' },
  { type: TAB_TOOLS, label: '工具' },
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
