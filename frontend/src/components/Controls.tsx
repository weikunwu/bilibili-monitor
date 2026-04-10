import { useEffect, useRef } from 'react'
import flatpickr from 'flatpickr'
import type { Instance } from 'flatpickr/dist/types/instance'
import 'flatpickr/dist/flatpickr.min.css'
import 'flatpickr/dist/themes/dark.css'
import 'flatpickr/dist/l10n/zh'

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

const fpOpts = {
  enableTime: true,
  enableSeconds: true,
  time_24hr: true,
  dateFormat: 'Y-m-d H:i:S',
  locale: 'zh' as const,
  theme: 'dark' as const,
}

export function Controls({
  autoScroll, showEnter, showLike, activePreset,
  onAutoScrollChange, onShowEnterChange, onShowLikeChange,
  onPresetChange, onQueryRange,
}: Props) {
  const fromRef = useRef<HTMLInputElement>(null)
  const toRef = useRef<HTMLInputElement>(null)
  const fpFromRef = useRef<Instance | null>(null)
  const fpToRef = useRef<Instance | null>(null)

  useEffect(() => {
    if (fromRef.current) {
      fpFromRef.current = flatpickr(fromRef.current as unknown as string, {
        ...fpOpts,
        defaultHour: 0, defaultMinute: 0, defaultSeconds: 0,
      }) as unknown as Instance
    }
    if (toRef.current) {
      fpToRef.current = flatpickr(toRef.current as unknown as string, {
        ...fpOpts,
        defaultHour: 23, defaultMinute: 59, defaultSeconds: 59,
      }) as unknown as Instance
    }
    return () => {
      fpFromRef.current?.destroy()
      fpToRef.current?.destroy()
    }
  }, [])

  const presets = ['live', 'today', 'week', 'month']
  const presetLabels: Record<string, string> = {
    live: '实时', today: '今日', week: '本周', month: '本月',
  }

  function handleQuery() {
    const from = fromRef.current?.value || ''
    const to = toRef.current?.value || ''
    if (!from && !to) return
    onQueryRange(from, to)
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
            onClick={() => {
              fpFromRef.current?.clear()
              fpToRef.current?.clear()
              onPresetChange(p)
            }}
          >
            {presetLabels[p]}
          </button>
        ))}
        <span className="sep">|</span>
        <input type="text" ref={fromRef} placeholder="开始时间" />
        <span className="sep">~</span>
        <input type="text" ref={toRef} placeholder="结束时间" />
        <button className="btn btn-primary" onClick={handleQuery}>查询</button>
      </div>
    </div>
  )
}
