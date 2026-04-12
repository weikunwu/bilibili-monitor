import { Sidenav, Nav, Dropdown, IconButton } from 'rsuite'
import MenuIcon from '@rsuite/icons/Menu'
import type { TabType } from '../types'
import { TAB_ALL, EVENT_DANMAKU, EVENT_GIFT, EVENT_SUPERCHAT, EVENT_GUARD, TAB_BLINDBOX, TAB_TOOLS } from '../lib/constants'

const TAB_LIST: { type: TabType; label: string }[] = [
  { type: TAB_ALL, label: '全部' },
  { type: EVENT_DANMAKU, label: '弹幕' },
  { type: EVENT_GIFT, label: '礼物' },
  { type: EVENT_GUARD, label: '上舰' },
  { type: EVENT_SUPERCHAT, label: 'SC' },
  { type: TAB_BLINDBOX, label: '盲盒' },
  { type: TAB_TOOLS, label: '工具' },
]

interface Props {
  active: TabType
  onChange: (tab: TabType) => void
}

export function TabMenu({ active, onChange }: Props) {
  const activeLabel = TAB_LIST.find((t) => t.type === active)?.label || '全部'
  return (
    <Dropdown
      title={activeLabel}
      className="tab-menu"
      renderToggle={(props, ref) => (
        <IconButton {...props} ref={ref} icon={<MenuIcon />} size="sm" appearance="subtle">
          {activeLabel}
        </IconButton>
      )}
    >
      {TAB_LIST.map((t) => (
        <Dropdown.Item
          key={t.type}
          active={t.type === active}
          onSelect={() => onChange(t.type)}
        >
          {t.label}
        </Dropdown.Item>
      ))}
    </Dropdown>
  )
}

export function TabSidebar({ active, onChange }: Props) {
  return (
    <Sidenav appearance="subtle" className="room-sidebar">
      <Sidenav.Body>
        <Nav activeKey={active} onSelect={(key) => key && onChange(key as TabType)}>
          {TAB_LIST.map((t) => (
            <Nav.Item key={t.type} eventKey={t.type}>
              {t.label}
            </Nav.Item>
          ))}
        </Nav>
      </Sidenav.Body>
    </Sidenav>
  )
}
