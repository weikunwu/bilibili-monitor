import { useState, useEffect } from 'react'
import { Sidenav, Nav } from 'rsuite'
import ListIcon from '@rsuite/icons/List'
import MessageIcon from '@rsuite/icons/Message'
import DashboardIcon from '@rsuite/icons/Dashboard'
import ShieldIcon from '@rsuite/icons/Shield'
import SpeakerIcon from '@rsuite/icons/Speaker'
import ArchiveIcon from '@rsuite/icons/Archive'
import ToolsIcon from '@rsuite/icons/Tools'
import type { TabType } from '../types'
import { TAB_ALL, EVENT_DANMAKU, EVENT_GIFT, EVENT_SUPERCHAT, EVENT_GUARD, TAB_BLINDBOX, TAB_TOOLS } from '../lib/constants'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TAB_LIST: { type: TabType; label: string; icon: any }[] = [
  { type: TAB_ALL, label: '全部', icon: <ListIcon /> },
  { type: EVENT_DANMAKU, label: '弹幕', icon: <MessageIcon /> },
  { type: EVENT_GIFT, label: '礼物', icon: <DashboardIcon /> },
  { type: EVENT_GUARD, label: '上舰', icon: <ShieldIcon /> },
  { type: EVENT_SUPERCHAT, label: 'SC', icon: <SpeakerIcon /> },
  { type: TAB_BLINDBOX, label: '盲盒统计', icon: <ArchiveIcon /> },
  { type: TAB_TOOLS, label: '主播工具', icon: <ToolsIcon /> },
]

function useIsMobile(breakpoint = 768) {
  const [mobile, setMobile] = useState(() => window.innerWidth <= breakpoint)
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [breakpoint])
  return mobile
}

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
