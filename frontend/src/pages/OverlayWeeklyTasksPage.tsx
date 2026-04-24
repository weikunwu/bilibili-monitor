import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'

interface WeeklyTasksData {
  count: number
  milestones: number[]
  plusCount: number
  plusTarget: number
  plusStatus: number
  plusGiftName: string
  plusGiftImg: string
  cycleSettlementTime: number
  cycleEndTime: number
}

const POLL_MS = 5000
// 心动盲盒 gift_id=32251，B站 CDN 图稳定；直连省一次后端中转
const BLIND_BOX_ICON = 'https://s1.hdslb.com/bfs/live/38f645d811537b50873718cecbfd84cd28af50ed.png'

// 电影票礼物图（plus_gift_img 典型值）—— 预览用，直连 B 站 CDN。
const MOVIE_TICKET_ICON = 'https://s1.hdslb.com/bfs/live/20864a10beaea541c7dce264d5bbc56676d63e4f.png'

export function OverlayWeeklyTasksPage() {
  const { roomId } = useParams()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  // ?preview=weekly|crit：跳过 API，用内置 mock 数据直接渲染对应卡片，方便截图 / 设计预览。
  const preview = searchParams.get('preview')
  const [data, setData] = useState<WeeklyTasksData>({
    count: 0,
    milestones: [20, 60, 120, 180],
    plusCount: 0,
    plusTarget: 0,
    plusStatus: 0,
    plusGiftName: '',
    plusGiftImg: '',
    cycleSettlementTime: 0,
    cycleEndTime: 0,
  })
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
    if (preview) return  // 预览模式：直接用 mock，跳过 API 轮询
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
            plusCount: Number(d.plus_task_count) || 0,
            plusTarget: Number(d.plus_task_target) || 0,
            plusStatus: Number(d.plus_task_status) || 0,
            plusGiftName: typeof d.plus_gift_name === 'string' ? d.plus_gift_name : '',
            plusGiftImg: typeof d.plus_gift_img === 'string' ? d.plus_gift_img : '',
            cycleSettlementTime: Number(d.cycle_settlement_time) || 0,
            cycleEndTime: Number(d.cycle_end_time) || 0,
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
  }, [roomId, token, preview])

  // cycle 两段式：[start, settlement) = 心动盲盒收集期 → weekly 卡；
  // [settlement, end) = 暴击任务时段 → 仅当 plus_task_status===1 显示 crit 卡，否则藏；
  // >= end = cycle 结束等下一轮 → 藏。cycle 信息缺失时（首次/接口异常）退化到基于
  // status 的老行为，避免一上来白屏。
  // plus_task_status：1=进行中；2=收满未出；3=收满已出。
  const nowSec = Date.now() / 1000
  const hasCycle = data.cycleSettlementTime > 0
  const inCollectionPhase = hasCycle && nowSec < data.cycleSettlementTime
  const inCritPhase = hasCycle
    && nowSec >= data.cycleSettlementTime
    && (data.cycleEndTime <= 0 || nowSec < data.cycleEndTime)
  const critLive = data.plusStatus === 1 && data.plusTarget > 0
  let mode: 'hidden' | 'weekly' | 'crit'
  if (!hasCycle) {
    mode = critLive ? 'crit' : 'weekly'
  } else if (inCollectionPhase) {
    mode = 'weekly'
  } else if (inCritPhase) {
    mode = critLive ? 'crit' : 'hidden'
  } else {
    mode = 'hidden'
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
      {preview === 'weekly' ? (
        <WeeklyTaskCard count={87} milestones={[20, 60, 120, 180]} />
      ) : preview === 'crit' ? (
        <CritTaskCard count={6} target={10} giftName="电影票" giftImg={MOVIE_TICKET_ICON} />
      ) : mode === 'hidden' ? null : mode === 'crit' ? (
        <CritTaskCard
          count={data.plusCount}
          target={data.plusTarget}
          giftName={data.plusGiftName || '电影票'}
          giftImg={data.plusGiftImg}
        />
      ) : (
        <WeeklyTaskCard count={data.count} milestones={data.milestones} />
      )}

      {error && (
        <div style={{ position: 'fixed', bottom: 4, right: 4, fontSize: 10, color: '#ef5350', opacity: 0.6 }}>
          {error}
        </div>
      )}
    </div>
  )
}

function WeeklyTaskCard({ count, milestones }: { count: number; milestones: number[] }) {
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
        maxWidth: 400,
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
        <span style={{ fontSize: 20, fontWeight: 600, letterSpacing: 0.3 }}>
          收集心动盲盒
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 20, fontWeight: 600 }}>
          <span style={{ color: '#ff85a2' }}>{count}</span>
          <span style={{ color: '#aaa' }}>/{nextTarget}</span>
        </span>
      </div>

      {/* 进度条：整体一条粗条，"已收集" 标签沉在填充色起点里 */}
      <div style={{ position: 'relative', height: 36 }}>
        {/* 底轨（只在右侧留 18px 让最后一个里程碑圆点不越界；
            左侧不留——第 1 个点在 25% 锚位，不会从左边越界） */}
        <div
          style={{
            position: 'absolute', left: 0, right: 18, top: 6, height: 24,
            background: 'rgba(255,255,255,0.12)',
            borderRadius: 12,
          }}
        />
        {/* 填充轨 */}
        <div
          style={{
            position: 'absolute', left: 0, top: 6, height: 24,
            width: `calc((100% - 18px) * ${fillPct / 100})`,
            minWidth: 58,
            background: 'linear-gradient(to right, #ff2d6b, #ff7aa0)',
            borderRadius: 12,
            boxShadow: '0 0 8px rgba(255,60,110,0.5)',
            display: 'flex', alignItems: 'center',
            paddingLeft: 10,
            color: '#fff', fontSize: 17, fontWeight: 700,
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
          const left = `calc((100% - 18px) * ${anchorPct(i) / 100} - 18px)`
          return (
            <div
              key={m}
              style={{
                position: 'absolute', left, top: 0,
                width: 36, height: 36, borderRadius: '50%',
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
                fontSize: 16, fontWeight: 800,
                color: reached ? '#4a2a00' : '#c9a3c9',
              }}
            >
              {m}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CritTaskCard({
  count, target, giftName, giftImg,
}: { count: number; target: number; giftName: string; giftImg: string }) {
  // 暴击任务目标小（通常 10 个），不走里程碑圆点，直接一条线性进度条。
  const pct = target > 0 ? Math.max(0, Math.min(1, count / target)) * 100 : 0

  return (
    <div
      style={{
        maxWidth: 400,
        // 暴击配色：走更"烈"的红→橙，和普通周任务的粉紫做视觉区分，一眼能认出"这是暴击"
        background: 'linear-gradient(135deg, rgba(58,14,14,0.9), rgba(70,28,8,0.9))',
        border: '1px solid rgba(255, 170, 60, 0.4)',
        borderRadius: 14,
        padding: '12px 16px 14px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.4), 0 0 12px rgba(255,120,40,0.25)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        {giftImg ? (
          <img
            src={giftImg}
            alt=""
            style={{ width: 22, height: 22, objectFit: 'contain', display: 'block' }}
          />
        ) : null}
        <span style={{ fontSize: 20, fontWeight: 600, letterSpacing: 0.3 }}>
          收集{giftName}
        </span>
        <span
          style={{
            marginLeft: 8,
            fontSize: 12, fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 999,
            background: 'linear-gradient(to right, #ff4d2a, #ffa43a)',
            color: '#2a0a00',
            letterSpacing: 0.5,
          }}
        >
          暴击
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 20, fontWeight: 600 }}>
          <span style={{ color: '#ffb84d' }}>{count}</span>
          <span style={{ color: '#aaa' }}>/{target}</span>
        </span>
      </div>

      <div style={{ position: 'relative', height: 28 }}>
        <div
          style={{
            position: 'absolute', left: 0, right: 0, top: 2, height: 24,
            background: 'rgba(255,255,255,0.12)',
            borderRadius: 12,
          }}
        />
        <div
          style={{
            position: 'absolute', left: 0, top: 2, height: 24,
            width: `${pct}%`,
            minWidth: count > 0 ? 58 : 0,
            background: 'linear-gradient(to right, #ff3d1a, #ffb347)',
            borderRadius: 12,
            boxShadow: '0 0 10px rgba(255,120,40,0.6)',
            display: 'flex', alignItems: 'center',
            paddingLeft: count > 0 ? 10 : 0,
            color: '#fff', fontSize: 15, fontWeight: 700,
            letterSpacing: 0.3,
            whiteSpace: 'nowrap',
            boxSizing: 'border-box',
            overflow: 'hidden',
          }}
        >
          {count > 0 ? '已收集' : ''}
        </div>
      </div>
    </div>
  )
}
