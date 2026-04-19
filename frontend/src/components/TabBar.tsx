import { Sidenav, Nav } from 'rsuite'
import { Radio, Gift, Search, BarChart3, MessageCircle, Wrench, Tag, Sparkles } from 'lucide-react'
import type { TabType } from '../types'
import {
  TAB_LIVE, TAB_REALTIME, TAB_EVENTS, TAB_BLINDBOX,
  TAB_REACTIVE, TAB_AUTOMATION, TAB_NICKNAMES, TAB_EFFECTS,
} from '../lib/constants'
import { useIsMobile } from '../hooks/useIsMobile'

interface TabSpec {
  type: TabType
  label: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: any
}

interface Group {
  label: string
  items: TabSpec[]
}

const GROUPS: Group[] = [
  {
    label: '实时',
    items: [
      { type: TAB_LIVE, label: '直播流', icon: <Radio size={16} /> },
      { type: TAB_REALTIME, label: '实时礼物流', icon: <Gift size={16} /> },
      { type: TAB_EFFECTS, label: '进场&礼物特效', icon: <Sparkles size={16} /> },
    ],
  },
  {
    label: '数据',
    items: [
      { type: TAB_EVENTS, label: '事件查询', icon: <Search size={16} /> },
      { type: TAB_BLINDBOX, label: '盲盒统计', icon: <BarChart3 size={16} /> },
    ],
  },
  {
    label: '配置',
    items: [
      { type: TAB_REACTIVE, label: '互动回复', icon: <MessageCircle size={16} /> },
      { type: TAB_AUTOMATION, label: '指令 & 高级', icon: <Wrench size={16} /> },
      { type: TAB_NICKNAMES, label: '昵称管理', icon: <Tag size={16} /> },
    ],
  },
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
        {GROUPS.map((g, gi) => (
          <div key={g.label} className={`room-sidebar-group${gi > 0 ? ' room-sidebar-group-sep' : ''}`}>
            {!isMobile && <div className="room-sidebar-group-label">{g.label}</div>}
            <Nav activeKey={active} onSelect={(key) => key && onChange(key as TabType)}>
              {g.items.map((t) => (
                <Nav.Item key={t.type} eventKey={t.type} icon={t.icon}>
                  {t.label}
                </Nav.Item>
              ))}
            </Nav>
          </div>
        ))}
      </Sidenav.Body>
    </Sidenav>
  )
}
