import type { Stats } from '../types'

export function StatsGrid({ stats }: { stats: Stats | null }) {
  const s = stats
  return (
    <div className="stats">
      <div className="stat-card popularity">
        <div className="label">人气值</div>
        <div className="value">{s?.popularity?.toLocaleString() ?? '0'}</div>
      </div>
      <div className="stat-card danmaku">
        <div className="label">弹幕</div>
        <div className="value">{s?.danmaku?.toLocaleString() ?? '0'}</div>
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
        <div className="label">上舰</div>
        <div className="value">{s?.guard?.toLocaleString() ?? '0'}</div>
      </div>
      <div className="stat-card sc-total">
        <div className="label">SC 总额</div>
        <div className="value">¥{s?.sc_total_price ?? 0}</div>
      </div>
    </div>
  )
}
