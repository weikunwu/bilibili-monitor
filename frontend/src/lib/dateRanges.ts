import type { DateRange } from 'rsuite/DateRangePicker'

function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0)
}

function dayEnd(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59)
}

export const PREDEFINED_RANGES = [
  {
    label: '今日',
    value: (): DateRange => {
      const now = new Date()
      return [dayStart(now), dayEnd(now)]
    },
  },
  {
    label: '昨日',
    value: (): DateRange => {
      const now = new Date()
      const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      return [dayStart(y), dayEnd(y)]
    },
  },
  {
    label: '本周',
    value: (): DateRange => {
      const now = new Date()
      const day = now.getDay() || 7
      const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1)
      return [dayStart(mon), dayEnd(now)]
    },
  },
  {
    label: '本月',
    value: (): DateRange => {
      const now = new Date()
      const first = new Date(now.getFullYear(), now.getMonth(), 1)
      return [dayStart(first), dayEnd(now)]
    },
  },
]
