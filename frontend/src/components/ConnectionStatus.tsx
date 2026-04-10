import type { ConnectionStatus as Status } from '../types'

const labels: Record<Status, string> = {
  connected: '已连接',
  disconnected: '已断开',
  connecting: '连接中',
}

export function ConnectionStatus({ status }: { status: Status }) {
  return (
    <span className="status">
      <span className={`dot ${status}`} />
      <span>{labels[status]}</span>
    </span>
  )
}
