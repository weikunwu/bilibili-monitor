import type { Stats } from '../types'

export function StatsGrid({ stats }: { stats: Stats | null }) {
  const s = stats
  return (
    <div className="stats">
      <div className="stat-card danmu">
        <div className="label">弹幕</div>
        <div className="value">{s?.danmu?.toLocaleString() ?? '0'}</div>
      </div>
      <div className="stat-card gift">
        <div className="label">礼物</div>
        <div className="value">{s?.gift?.toLocaleString() ?? '0'}</div>
      </div>
      <div className="stat-card sc">
        <div className="label">醒目留言</div>
        <div className="value">{s?.superchat?.toLocaleString() ?? '0'}</div>
      </div>
      <div className="stat-card guard">
        <div className="label">大航海</div>
        <div className="value">{s?.guard?.toLocaleString() ?? '0'}</div>
      </div>
      <div className="stat-card sc-total">
        <div className="label">醒目留言总额</div>
        <div className="value">¥{((s?.sc_total_price ?? 0) / 10).toFixed(1).replace(/\.0$/, '')}</div>
      </div>
    </div>
  )
}
