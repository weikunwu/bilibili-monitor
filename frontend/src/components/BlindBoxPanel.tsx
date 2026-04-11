import { useState } from 'react'
import { Button, ButtonGroup, Input, InputGroup, Tag, Divider } from 'rsuite'
import SearchIcon from '@rsuite/icons/Search'
import { fetchBlindBoxSummary, type BlindBoxUser } from '../api/client'

interface Props {
  roomId: number
}

const PERIODS = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: 'this_month', label: '本月' },
  { key: 'last_month', label: '上月' },
]

function formatCoin(coin: number): string {
  if (coin >= 10000) return (coin / 10000).toFixed(1).replace(/\.0$/, '') + '万'
  return coin.toLocaleString()
}

export function BlindBoxPanel({ roomId }: Props) {
  const [period, setPeriod] = useState('today')
  const [userName, setUserName] = useState('')
  const [users, setUsers] = useState<BlindBoxUser[]>([])
  const [periodLabel, setPeriodLabel] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleQuery() {
    setLoading(true)
    try {
      const data = await fetchBlindBoxSummary(roomId, period, userName || undefined)
      setUsers(data.users)
      setPeriodLabel(data.period)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="blind-box-panel">
      <div className="blind-box-controls">
        <ButtonGroup size="sm">
          {PERIODS.map((p) => (
            <Button
              key={p.key}
              appearance={period === p.key ? 'primary' : 'ghost'}
              onClick={() => setPeriod(p.key)}
            >
              {p.label}
            </Button>
          ))}
        </ButtonGroup>
        <InputGroup size="sm" style={{ width: 200 }}>
          <Input
            placeholder="用户名（留空查全部）"
            value={userName}
            onChange={setUserName}
            onPressEnter={handleQuery}
          />
          <InputGroup.Button onClick={handleQuery} loading={loading}>
            <SearchIcon />
          </InputGroup.Button>
        </InputGroup>
      </div>

      {periodLabel && (
        <div className="blind-box-period-label">{periodLabel} 盲盒汇总</div>
      )}

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
                开盒 {u.total_boxes} 次 · 花费 {formatCoin(u.total_cost)} · 价值 {formatCoin(u.total_value)}
              </span>
            </div>
            <Tag color={u.profit >= 0 ? 'green' : 'red'} size="lg">
              {u.profit >= 0 ? '+' : ''}{formatCoin(u.profit)}
            </Tag>
          </div>

          {u.boxes.map((box) => (
            <div key={box.name} className="blind-box-type">
              <div className="blind-box-type-header">
                <span className="blind-box-type-name">{box.name}</span>
                <span className="blind-box-type-stats">
                  {box.count} 次 ·{' '}
                  <Tag size="sm" color={box.profit >= 0 ? 'green' : 'red'}>
                    {box.profit >= 0 ? '+' : ''}{formatCoin(box.profit)}
                  </Tag>
                </span>
              </div>
              <div className="blind-box-gifts">
                {box.gifts.map((gift, i) => (
                  <div key={i} className="blind-box-gift">
                    {gift.img && <img className="blind-box-gift-img" src={gift.img} referrerPolicy="no-referrer" alt="" />}
                    <span className="blind-box-gift-count">x{gift.count}</span>
                    <span className="blind-box-gift-value">{formatCoin(gift.value)}</span>
                  </div>
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
