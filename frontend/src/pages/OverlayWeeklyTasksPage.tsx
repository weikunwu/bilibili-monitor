import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'

interface WeeklyTasksData {
  count: number
  milestones: number[]
}

const POLL_MS = 5000
// 心动盲盒 gift_id=32251，B站 CDN 图稳定；直连省一次后端中转
const BLIND_BOX_ICON = 'https://s1.hdslb.com/bfs/live/38f645d811537b50873718cecbfd84cd28af50ed.png'

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
  const nextIdx = sorted.findIndex((m) => count < m)
  const nextTarget = nextIdx === -1 ? maxMs : sorted[nextIdx]
  // 里程碑视觉上等分：第 i 档锚在 (i+1)/n。这样第 1 档不会压在左侧 "已收集" 药丸上，
  // 最后一档停在轨道右端。段间距离不再受数值差影响（原来 20→60→120→180 的数值
  // 差造成视觉上不均，20 挤在最左）。
  const n = sorted.length
  const anchorPct = (i: number) => (n <= 0 ? 100 : ((i + 1) / n) * 100)
  let fillPct: number
  if (nextIdx === -1) {
    fillPct = 100
  } else if (nextIdx === 0) {
    fillPct = Math.max(0, Math.min(1, count / sorted[0])) * anchorPct(0)
  } else {
    const prev = sorted[nextIdx - 1]
    const tgt = sorted[nextIdx]
    const frac = tgt > prev ? (count - prev) / (tgt - prev) : 0
    fillPct = anchorPct(nextIdx - 1) + Math.max(0, Math.min(1, frac)) * (anchorPct(nextIdx) - anchorPct(nextIdx - 1))
  }

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
          <img
            src={BLIND_BOX_ICON}
            alt=""
            style={{ width: 20, height: 20, objectFit: 'contain', display: 'block' }}
          />
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: 0.3 }}>
            收集心动盲盒
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 14, fontWeight: 600 }}>
            <span style={{ color: '#ff85a2' }}>{count}</span>
            <span style={{ color: '#aaa' }}>/{nextTarget}</span>
          </span>
        </div>

        {/* 进度条：整体一条粗条，"已收集" 标签沉在填充色起点里 */}
        <div style={{ position: 'relative', height: 28 }}>
          {/* 底轨（只在右侧留 14px 让最后一个里程碑圆点不越界；
              左侧不留——第 1 个点在 25% 锚位，不会从左边越界） */}
          <div
            style={{
              position: 'absolute', left: 0, right: 14, top: 2, height: 24,
              background: 'rgba(255,255,255,0.12)',
              borderRadius: 12,
            }}
          />
          {/* 填充轨 */}
          <div
            style={{
              position: 'absolute', left: 0, top: 2, height: 24,
              width: `calc((100% - 14px) * ${fillPct / 100})`,
              minWidth: 58,
              background: 'linear-gradient(to right, #ff2d6b, #ff7aa0)',
              borderRadius: 12,
              boxShadow: '0 0 8px rgba(255,60,110,0.5)',
              display: 'flex', alignItems: 'center',
              paddingLeft: 10,
              color: '#fff', fontSize: 11, fontWeight: 700,
              letterSpacing: 0.3,
              whiteSpace: 'nowrap',
              boxSizing: 'border-box',
              overflow: 'hidden',
            }}
          >
            已收集
          </div>

          {/* 里程碑圆点：视觉上沿轨道等间距，不按数值比例 */}
          {sorted.map((m, i) => {
            const reached = count >= m
            const left = `calc((100% - 14px) * ${anchorPct(i) / 100} - 14px)`
            return (
              <div
                key={m}
                style={{
                  position: 'absolute', left, top: 0,
                  width: 28, height: 28, borderRadius: '50%',
                  background: reached
                    ? 'linear-gradient(135deg, #ffd34d, #ff9800)'
                    : 'rgba(60, 40, 60, 0.9)',
                  border: reached
                    ? '2px solid #fff7c2'
                    : '2px solid rgba(255,255,255,0.18)',
                  boxShadow: reached
                    ? '0 0 10px rgba(255,180,40,0.55)'
                    : 'inset 0 0 4px rgba(0,0,0,0.4)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 800,
                  color: reached ? '#4a2a00' : '#c9a3c9',
                }}
              >
                {m}
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
