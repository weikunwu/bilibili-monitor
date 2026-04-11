import { DateRangePicker, Checkbox } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'
import 'rsuite/DateRangePicker/styles/index.css'

interface Props {
  autoScroll: boolean
  defaultRange: DateRange | null
  onAutoScrollChange: (v: boolean) => void
  onQueryRange: (from: string, to: string) => void
}

function fmt(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const predefinedRanges = [
  {
    label: '今日',
    value: () => {
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)
      return [start, end] as DateRange
    },
  },
  {
    label: '昨日',
    value: () => {
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0)
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59)
      return [start, end] as DateRange
    },
  },
  {
    label: '本周',
    value: () => {
      const now = new Date()
      const day = now.getDay() || 7
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1, 0, 0, 0)
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)
      return [start, end] as DateRange
    },
  },
  {
    label: '本月',
    value: () => {
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0)
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)
      return [start, end] as DateRange
    },
  },
]

export function Controls({
  autoScroll, defaultRange,
  onAutoScrollChange, onQueryRange,
}: Props) {

  function handleRangeChange(range: DateRange | null) {
    if (!range) return
    const [from, to] = range
    onQueryRange(fmt(from), fmt(to))
  }

  return (
    <div className="controls">
      <Checkbox
        checked={autoScroll}
        onChange={(_, checked) => onAutoScrollChange(checked)}
      >
        自动滚动
      </Checkbox>
      <div className="time-range">
        <DateRangePicker
          format="yyyy-MM-dd HH:mm:ss"
          character=" ~ "
          placeholder="选择时间范围"
          size="sm"
          appearance="subtle"
          ranges={predefinedRanges}
          defaultValue={defaultRange}
          onChange={handleRangeChange}
          placement="bottomEnd"
          style={{ width: 340 }}
        />
      </div>
    </div>
  )
}
