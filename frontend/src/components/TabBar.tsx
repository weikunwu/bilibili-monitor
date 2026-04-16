import { Sidenav, Nav } from 'rsuite'
import { LayoutList, MessageSquareText, Gift, Anchor, Megaphone, Box, Wrench, Tag, Radio } from 'lucide-react'
import type { TabType } from '../types'
import { TAB_ALL, EVENT_DANMU, EVENT_GIFT, EVENT_SUPERCHAT, EVENT_GUARD, TAB_BLINDBOX, TAB_TOOLS, TAB_NICKNAMES, TAB_REALTIME_GIFTS } from '../lib/constants'
import { useIsMobile } from '../hooks/useIsMobile'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TAB_LIST: { type: TabType; label: string; icon: any }[] = [
  { type: TAB_ALL, label: '全部', icon: <LayoutList size={16} /> },
  { type: EVENT_DANMU, label: '弹幕', icon: <MessageSquareText size={16} /> },
  { type: EVENT_GIFT, label: '礼物', icon: <Gift size={16} /> },
  { type: EVENT_GUARD, label: '大航海', icon: <Anchor size={16} /> },
  { type: EVENT_SUPERCHAT, label: '醒目留言', icon: <Megaphone size={16} /> },
  { type: TAB_BLINDBOX, label: '盲盒统计', icon: <Box size={16} /> },
  { type: TAB_NICKNAMES, label: '昵称管理', icon: <Tag size={16} /> },
  { type: TAB_REALTIME_GIFTS, label: '实时礼物', icon: <Radio size={16} /> },
  { type: TAB_TOOLS, label: '主播工具', icon: <Wrench size={16} /> },
]

interface Props {
  active: TabType
  onChange: (tab: TabType) => void
}

export function TabSidebar({ active, onChange }: Props) {
  const isMobile = useIsMobile()
  return (
    <Sidenav appearance="subtle" expanded={!isMobile} className="room-sidebar">
      <Sidenav.Body>
        <Nav activeKey={active} onSelect={(key) => key && onChange(key as TabType)}>
          {TAB_LIST.map((t) => (
            <Nav.Item key={t.type} eventKey={t.type} icon={t.icon}>
              {t.label}
            </Nav.Item>
          ))}
        </Nav>
      </Sidenav.Body>
    </Sidenav>
  )
}
