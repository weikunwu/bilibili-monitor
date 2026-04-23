import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'

interface WeeklyTasksData {
  count: number
  milestones: number[]
}

const POLL_MS = 5000

export function OverlayWeeklyTasksPage() {
  const { roomId } = useParams()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  const [data, setData] = useState<WeeklyTasksData>({ count: 0, milestones: [20, 60, 120, 180] })
  const [error, setError] = useState<string>('')

  // 透明背景，方便 OBS 浏览器源叠加。
  useEffect(() => {
    const prevHtml = document.documentElement.style.background
    const prevBody = document.body.style.background
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    return () => {
      document.documentElement.style.background = prevHtml
      document.body.style.background = prevBody
    }
  }, [])

  useEffect(() => {
    if (!roomId) return
    if (!token) { setError('缺少 token'); return }
    let cancelled = false
    let iv = 0
    async function poll() {
      try {
        const r = await fetch(`/api/overlay/weekly-tasks/${roomId}?token=${encodeURIComponent(token)}`)
        if (r.status === 410) {
          setError('房间已到期')
          cancelled = true
          clearInterval(iv)
          return
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d = await r.json()
        if (!cancelled) {
          setData({
            count: Number(d.count) || 0,
            milestones: Array.isArray(d.milestones) && d.milestones.length
              ? d.milestones.map((x: unknown) => Number(x) || 0).filter((n: number) => n > 0)
              : [20, 60, 120, 180],
          })
          setError('')
        }
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    }
    poll()
    iv = window.setInterval(poll, POLL_MS)
    return () => { cancelled = true; clearInterval(iv) }
  }, [roomId, token])

  const { count, milestones } = data
  const sorted = [...milestones].sort((a, b) => a - b)
  const maxMs = sorted[sorted.length - 1] || 1
  // 下一个未达成的里程碑；都达成就停在最后一档
  const nextTarget = sorted.find((m) => count < m) ?? maxMs
  const fillPct = Math.max(0, Math.min(100, (count / maxMs) * 100))

  return (
    <div
      style={{
        position: 'fixed', inset: 0, margin: 0, padding: 16,
        background: 'transparent',
        fontFamily: '-apple-system, "PingFang SC", sans-serif',
        color: '#fff',
      }}
    >
      <div
        style={{
          maxWidth: 440,
          background: 'linear-gradient(135deg, rgba(42,18,42,0.88), rgba(60,22,48,0.88))',
          border: '1px solid rgba(255, 107, 157, 0.25)',
          borderRadius: 14,
          padding: '12px 16px 14px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        }}
      >
        {/* 标题行 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 16 }}>💖</span>
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: 0.3 }}>
            收集心动盲盒
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 14, fontWeight: 600 }}>
            <span style={{ color: '#ff85a2' }}>{count}</span>
            <span style={{ color: '#aaa' }}>/{nextTarget}</span>
          </span>
        </div>

        {/* 进度条 */}
        <div style={{ position: 'relative', height: 32 }}>
          {/* 底轨 */}
          <div
            style={{
              position: 'absolute', left: 20, right: 20, top: 12, height: 8,
              background: 'rgba(255,255,255,0.12)',
              borderRadius: 4,
            }}
          />
          {/* 填充轨 */}
          <div
            style={{
              position: 'absolute', left: 20, top: 12, height: 8,
              width: `calc((100% - 40px) * ${fillPct / 100})`,
              background: 'linear-gradient(to right, #ff2d6b, #ff7aa0)',
              borderRadius: 4,
              boxShadow: '0 0 8px rgba(255,60,110,0.5)',
            }}
          />

          {/* 左侧 "已收集 N" 药丸 */}
          <div
            style={{
              position: 'absolute', left: 0, top: 0,
              background: 'linear-gradient(135deg, #ff2d6b, #c2185b)',
              color: '#fff', fontSize: 12, fontWeight: 700,
              padding: '5px 10px', borderRadius: 14,
              display: 'flex', alignItems: 'center', gap: 4,
              boxShadow: '0 2px 6px rgba(255,45,107,0.5)',
              whiteSpace: 'nowrap',
            }}
          >
            已收集 {count}
          </div>

          {/* 里程碑圆点 */}
          {sorted.map((m) => {
            const reached = count >= m
            const left = `calc(20px + (100% - 40px) * ${m / maxMs} - 14px)`
            return (
              <div
                key={m}
                style={{
                  position: 'absolute', left, top: -2,
                  width: 32, height: 32, borderRadius: '50%',
                  background: reached
                    ? 'linear-gradient(135deg, #ffd34d, #ff9800)'
                    : 'rgba(60, 40, 60, 0.85)',
                  border: reached
                    ? '2px solid #fff7c2'
                    : '2px solid rgba(255,255,255,0.15)',
                  boxShadow: reached
                    ? '0 0 10px rgba(255,180,40,0.55)'
                    : 'inset 0 0 4px rgba(0,0,0,0.4)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 800,
                  color: reached ? '#4a2a00' : '#999',
                }}
              >
                {reached ? m : <LockIcon />}
              </div>
            )
          })}
        </div>
      </div>

      {error && (
        <div style={{ position: 'fixed', bottom: 4, right: 4, fontSize: 10, color: '#ef5350', opacity: 0.6 }}>
          {error}
        </div>
      )}
    </div>
  )
}

function LockIcon() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" fill="none">
      <path
        d="M3 6V4a3 3 0 016 0v2h1a1 1 0 011 1v6a1 1 0 01-1 1H2a1 1 0 01-1-1V7a1 1 0 011-1h1zm1.5 0h3V4a1.5 1.5 0 00-3 0v2z"
        fill="currentColor"
      />
    </svg>
  )
}
