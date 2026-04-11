import { useState } from 'react'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs'
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import dayjs, { type Dayjs } from 'dayjs'
import 'dayjs/locale/zh-cn'

const darkTheme = createTheme({
  palette: { mode: 'dark' },
  components: {
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiInputBase-root': {
            fontSize: 12,
            height: 32,
            background: '#1a1a2e',
            borderRadius: 6,
          },
          '& .MuiInputBase-input': {
            padding: '4px 8px',
            color: '#ccc',
          },
          '& .MuiOutlinedInput-notchedOutline': {
            borderColor: '#2a2a4a',
          },
          '&:hover .MuiOutlinedInput-notchedOutline': {
            borderColor: '#fb7299',
          },
          width: 180,
        },
      },
    },
  },
})

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

function formatDayjs(d: Dayjs): string {
  return d.format('YYYY-MM-DD HH:mm:ss')
}

export function Controls({
  autoScroll, showEnter, showLike, activePreset,
  onAutoScrollChange, onShowEnterChange, onShowLikeChange,
  onPresetChange, onQueryRange,
}: Props) {
  const [fromVal, setFromVal] = useState<Dayjs | null>(null)
  const [toVal, setToVal] = useState<Dayjs | null>(null)

  const presets = ['live', 'today', 'week', 'month']
  const presetLabels: Record<string, string> = {
    live: '实时', today: '今日', week: '本周', month: '本月',
  }

  function handleQuery() {
    const from = fromVal ? formatDayjs(fromVal) : ''
    const to = toVal ? formatDayjs(toVal) : ''
    if (!from && !to) return
    onQueryRange(from, to)
  }

  return (
    <ThemeProvider theme={darkTheme}>
      <LocalizationProvider dateAdapter={AdapterDayjs} adapterLocale="zh-cn">
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
                  setFromVal(null)
                  setToVal(null)
                  onPresetChange(p)
                }}
              >
                {presetLabels[p]}
              </button>
            ))}
            <span className="sep">|</span>
            <DateTimePicker
              value={fromVal}
              onChange={setFromVal}
              ampm={false}
              format="YYYY-MM-DD HH:mm:ss"
              slotProps={{ textField: { size: 'small' } }}
              label="开始时间"
            />
            <span className="sep">~</span>
            <DateTimePicker
              value={toVal}
              onChange={setToVal}
              ampm={false}
              format="YYYY-MM-DD HH:mm:ss"
              defaultValue={dayjs().hour(23).minute(59).second(59)}
              slotProps={{ textField: { size: 'small' } }}
              label="结束时间"
            />
            <button className="btn btn-primary" onClick={handleQuery}>查询</button>
          </div>
        </div>
      </LocalizationProvider>
    </ThemeProvider>
  )
}
