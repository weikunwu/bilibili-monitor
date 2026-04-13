import { useState, useMemo } from 'react'
import { CheckPicker, DateRangePicker, Tag, Divider, Whisper, Tooltip } from 'rsuite'
import type { DateRange } from 'rsuite/DateRangePicker'
import { fetchBlindBoxSummary, type BlindBoxUser } from '../api/client'
import { formatBattery, fmtUTC } from '../lib/formatters'

function dayStart(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0) }
function dayEnd(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59) }

const BLIND_RANGES = [
  { label: '今日', value: (): DateRange => { const n = new Date(); return [dayStart(n), dayEnd(n)] } },
  { label: '昨日', value: (): DateRange => { const n = new Date(); const y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1); return [dayStart(y), dayEnd(y)] } },
  { label: '今月', value: (): DateRange => { const n = new Date(); return [dayStart(new Date(n.getFullYear(), n.getMonth(), 1)), dayEnd(n)] } },
  { label: '上月', value: (): DateRange => { const n = new Date(); const first = new Date(n.getFullYear(), n.getMonth() - 1, 1); const last = new Date(n.getFullYear(), n.getMonth(), 0); return [dayStart(first), dayEnd(last)] } },
]

interface Props {
  roomId: number
}

export function BlindBoxPanel({ roomId }: Props) {
  const [dateRange, setDateRange] = useState<DateRange | null>(() => BLIND_RANGES[0].value())
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [selectedBoxes, setSelectedBoxes] = useState<string[]>([])
  const [allUsers, setAllUsers] = useState<BlindBoxUser[]>([])
  const [periodLabel, setPeriodLabel] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleQuery(range: DateRange) {
    setLoading(true)
    try {
      const data = await fetchBlindBoxSummary(roomId, fmtUTC(range[0]), fmtUTC(range[1]))
      setAllUsers(data.users)
      setPeriodLabel(data.period)
      setSelectedUsers([])
      setSelectedBoxes([])
    } finally {
      setLoading(false)
    }
  }

  const userOptions = useMemo(
    () => allUsers.map((u) => ({ label: u.user_name, value: u.user_name })),
    [allUsers],
  )

  const boxOptions = useMemo(() => {
    const names = new Set<string>()
    for (const u of allUsers) for (const b of u.boxes) names.add(b.name)
    return Array.from(names).map((n) => ({ label: n, value: n }))
  }, [allUsers])

  const users = useMemo(() => {
    let list = selectedUsers.length > 0
      ? allUsers.filter((u) => selectedUsers.includes(u.user_name))
      : allUsers
    if (selectedBoxes.length > 0) {
      list = list
        .map((u) => {
          const boxes = u.boxes.filter((b) => selectedBoxes.includes(b.name))
          if (boxes.length === 0) return null
          const total_boxes = boxes.reduce((s, b) => s + b.count, 0)
          const total_cost = boxes.reduce((s, b) => s + b.cost, 0)
          const total_value = boxes.reduce((s, b) => s + b.value, 0)
          return { ...u, boxes, total_boxes, total_cost, total_value, profit: total_value - total_cost }
        })
        .filter((u): u is BlindBoxUser => u !== null)
    }
    return list
  }, [allUsers, selectedUsers, selectedBoxes])

  return (
    <div className="blind-box-panel">
      <div className="panel-title">盲盒统计</div>
      <div className="event-filter">
        {userOptions.length > 0 && (
          <CheckPicker
            data={userOptions}
            value={selectedUsers}
            onChange={setSelectedUsers}
            placeholder="筛选用户"
            size="sm"
            searchable
            countable
            w={200}
          />
        )}
        {boxOptions.length > 0 && (
          <CheckPicker
            data={boxOptions}
            value={selectedBoxes}
            onChange={setSelectedBoxes}
            placeholder="筛选盲盒"
            size="sm"
            searchable
            countable
            w={200}
          />
        )}
        <span style={{ flex: 1 }} />
        <DateRangePicker
          format="yyyy-MM-dd HH:mm:ss"
          character=" ~ "
          placeholder="选择时间范围"
          size="sm"
          appearance="subtle"
          ranges={BLIND_RANGES}
          value={dateRange}
          loading={loading}
          placement="bottomEnd"
          onChange={(range) => {
            if (!range) return
            setDateRange(range)
            handleQuery(range)
          }}
          style={{ width: 340 }}
        />
      </div>

      {periodLabel && (
        <div className="blind-box-period-label">{periodLabel} 盲盒汇总</div>
      )}

      {users.length > 0 && (() => {
        const totalBoxes = users.reduce((s, u) => s + u.total_boxes, 0)
        const totalCost = users.reduce((s, u) => s + u.total_cost, 0) / 10
        const totalValue = users.reduce((s, u) => s + u.total_value, 0) / 10
        const totalProfit = totalValue - totalCost
        const fmt = (v: number) => v.toFixed(2).replace(/\.?0+$/, '')
        return (
          <div className="blind-box-summary">
            <div className="summary-card">
              <div className="summary-card-label">总盲盒数</div>
              <div className="summary-card-value">{totalBoxes}</div>
            </div>
            <div className="summary-card">
              <div className="summary-card-label">总成本 (元)</div>
              <div className="summary-card-value">{fmt(totalCost)}</div>
            </div>
            <div className="summary-card">
              <div className="summary-card-label">总收入 (元)</div>
              <div className="summary-card-value">{fmt(totalValue)}</div>
            </div>
            <div className="summary-card">
              <div className="summary-card-label">总盈亏 (元)</div>
              <div className={`summary-card-value ${totalProfit >= 0 ? 'profit-pos' : 'profit-neg'}`}>
                {totalProfit >= 0 ? '+' : ''}{fmt(totalProfit)}
              </div>
            </div>
          </div>
        )
      })()}

      {users.length === 0 && periodLabel && (
        <div className="empty">暂无盲盒记录</div>
      )}

      {users.map((u) => (
        <div key={`${u.user_id}_${u.user_name}`} className="blind-box-user">
          <div className="blind-box-user-header">
            {u.avatar && <img className="blind-box-avatar" src={u.avatar} referrerPolicy="no-referrer" alt="" />}
            <div className="blind-box-user-info">
              <span className="blind-box-username">{u.user_name}</span>
              <span className="blind-box-stats">
                开盒 {u.total_boxes} 次 · 花费 {formatBattery(u.total_cost)} · 价值 {formatBattery(u.total_value)}
              </span>
            </div>
            <Tag color={u.profit >= 0 ? 'green' : 'red'} size="lg">
              {u.profit >= 0 ? '+' : ''}{formatBattery(u.profit)}
            </Tag>
          </div>

          {u.boxes.map((box) => (
            <div key={box.name} className="blind-box-type">
              <div className="blind-box-type-header">
                <span className="blind-box-type-name">{box.name}</span>
                <span className="blind-box-type-stats">
                  {box.count} 次 ·{' '}
                  <Tag size="sm" color={box.profit >= 0 ? 'green' : 'red'}>
                    {box.profit >= 0 ? '+' : ''}{formatBattery(box.profit)}
                  </Tag>
                </span>
              </div>
              <div className="blind-box-gifts">
                {box.gifts.map((gift, i) => (
                  <Whisper key={i} trigger="hover" placement="top" speaker={<Tooltip>{gift.name}</Tooltip>}>
                    <div className="blind-box-gift">
                      {gift.img && <img className="blind-box-gift-img" src={gift.img} referrerPolicy="no-referrer" alt={gift.name} />}
                      <span className="blind-box-gift-count">x{gift.count}</span>
                      <span className="blind-box-gift-value">{formatBattery(gift.value)}</span>
                    </div>
                  </Whisper>
                ))}
              </div>
            </div>
          ))}
          <Divider style={{ margin: '12px 0' }} />
        </div>
      ))}
    </div>
  )
}
