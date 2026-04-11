import { DateRangePicker } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'
import 'rsuite/DateRangePicker/styles/index.css'

interface Props {
  autoScroll: boolean
  showEnter: boolean
  showLike: boolean
  activePreset: string
  onAutoScrollChange: (v: boolean) => void
  onShowEnterChange: (v: boolean) => void
  onShowLikeChange: (v: boolean) => void
  onPresetChange: (preset: string) => void
  onQueryRange: (from: string, to: string) => void
}

function fmt(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function Controls({
  autoScroll, showEnter, showLike, activePreset,
  onAutoScrollChange, onShowEnterChange, onShowLikeChange,
  onPresetChange, onQueryRange,
}: Props) {

  const presets = ['live', 'today', 'week', 'month']
  const presetLabels: Record<string, string> = {
    live: '实时', today: '今日', week: '本周', month: '本月',
  }

  function handleRangeOk(range: DateRange | null) {
    if (!range) return
    const [from, to] = range
    onQueryRange(fmt(from), fmt(to))
  }

  return (
    <div className="controls">
      <label>
        <input type="checkbox" checked={autoScroll} onChange={(e) => onAutoScrollChange(e.target.checked)} />
        {' '}自动滚动
      </label>
      <label>
        <input type="checkbox" checked={showEnter} onChange={(e) => onShowEnterChange(e.target.checked)} />
        {' '}显示进场
      </label>
      <label>
        <input type="checkbox" checked={showLike} onChange={(e) => onShowLikeChange(e.target.checked)} />
        {' '}显示点赞
      </label>
      <div className="time-range">
        {presets.map((p) => (
          <button
            key={p}
            className={`btn preset ${activePreset === p ? 'active' : ''}`}
            onClick={() => onPresetChange(p)}
          >
            {presetLabels[p]}
          </button>
        ))}
        <span className="sep">|</span>
        <DateRangePicker
          format="yyyy-MM-dd HH:mm:ss"
          showMeridian={false}
          character=" ~ "
          placeholder="选择时间范围"
          size="sm"
          appearance="subtle"
          onOk={handleRangeOk}
          style={{ width: 340 }}
        />
      </div>
    </div>
  )
}
