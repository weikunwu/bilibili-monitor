import { useEffect, useMemo, useRef } from 'react'
import { Plane, Heart, Sparkles, Star } from 'lucide-react'

/** 进场特效预设动画。每个组件铺满父容器（position:absolute inset:0）。
 *
 * Props:
 *   userName  — 显示在动画里的用户名
 *   loop      — true 时无限循环（用于面板缩略图预览）
 *   mini      — true 时按缩略图尺寸渲染（更小字号/粒子等）
 *   onDone    — !loop 时一段时长后调用一次，OBS 叠加页用来切下一条
 */

export const PRESET_DURATION_MS = 4500

export interface PresetProps {
  userName: string
  loop?: boolean
  mini?: boolean
  onDone?: () => void
}

function useDoneTimer(loop: boolean | undefined, onDone: (() => void) | undefined) {
  useEffect(() => {
    if (loop || !onDone) return
    const t = window.setTimeout(onDone, PRESET_DURATION_MS)
    return () => clearTimeout(t)
  }, [loop, onDone])
}

function PlaneBanner({ userName, loop, mini, onDone }: PresetProps) {
  useDoneTimer(loop, onDone)
  const planeSize = mini ? 28 : 96
  const fontSize = mini ? 12 : 32
  return (
    <div className={`fx-fill fx-plane${loop ? ' fx-loop' : ''}`}>
      <div className="fx-plane-rig">
        <div style={{ transform: 'scaleX(-1)', display: 'inline-flex' }}>
          <Plane size={planeSize} color="#ff7eb6" fill="#ff7eb6" strokeWidth={1.5} />
        </div>
        <div className="fx-plane-banner" style={{ fontSize, padding: mini ? '2px 8px' : '8px 20px' }}>
          欢迎 {userName}
        </div>
      </div>
    </div>
  )
}

function HeartFloat({ userName, loop, mini, onDone }: PresetProps) {
  useDoneTimer(loop, onDone)
  const count = mini ? 10 : 22
  const seed = useMemo(() => {
    return Array.from({ length: count }, (_, i) => ({
      delay: i * (mini ? 130 : 180),
      left: 5 + Math.random() * 90,
      sway: Math.random() * 80 - 40,
      size: mini ? 14 + Math.random() * 8 : 26 + Math.random() * 18,
      dur: 2400 + Math.random() * 1400,
    }))
  }, [count, mini])
  return (
    <div className={`fx-fill fx-hearts${loop ? ' fx-loop' : ''}`}>
      {seed.map((h, i) => (
        <span
          key={i}
          className="fx-heart"
          style={{
            left: `${h.left}%`,
            fontSize: h.size,
            animationDelay: `${h.delay}ms`,
            animationDuration: `${h.dur}ms`,
            ['--sway' as string]: `${h.sway}px`,
          }}
        >
          ♥
        </span>
      ))}
      <div className="fx-name fx-name-pop" style={{ fontSize: mini ? 14 : 56, color: '#fff0f5' }}>
        {userName}
      </div>
    </div>
  )
}

function Sparkle({ userName, loop, mini, onDone }: PresetProps) {
  useDoneTimer(loop, onDone)
  const count = mini ? 14 : 28
  const seed = useMemo(() => {
    return Array.from({ length: count }, () => ({
      top: Math.random() * 100,
      left: Math.random() * 100,
      delay: Math.random() * 1500,
      dur: 800 + Math.random() * 1000,
      size: mini ? 6 + Math.random() * 8 : 14 + Math.random() * 22,
    }))
  }, [count, mini])
  return (
    <div className={`fx-fill fx-sparkle${loop ? ' fx-loop' : ''}`}>
      {seed.map((s, i) => (
        <span
          key={i}
          className="fx-star"
          style={{
            top: `${s.top}%`,
            left: `${s.left}%`,
            width: s.size,
            height: s.size,
            fontSize: s.size,
            animationDelay: `${s.delay}ms`,
            animationDuration: `${s.dur}ms`,
          }}
        >
          ✦
        </span>
      ))}
      <div className="fx-name fx-name-glow" style={{ fontSize: mini ? 14 : 56 }}>
        {userName}
      </div>
    </div>
  )
}

function Firework({ userName, loop, mini, onDone }: PresetProps) {
  useDoneTimer(loop, onDone)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // 把可空 ref 绑到非空局部，避免内嵌函数里 TS 的 narrowing 失效。
    const cv = canvas
    const c2d = ctx
    const par = parent

    let cancelled = false
    let rafId = 0
    let burstCount = 0
    const maxBursts = loop ? Infinity : 4

    function syncSize() {
      const r = par.getBoundingClientRect()
      cv.width = Math.max(1, Math.round(r.width))
      cv.height = Math.max(1, Math.round(r.height))
    }
    syncSize()
    const ro = new ResizeObserver(syncSize)
    ro.observe(par)

    interface P { x: number; y: number; vx: number; vy: number; life: number; color: string }
    const particles: P[] = []
    const radius = mini ? 1.6 : 3
    const gravity = mini ? 0.05 : 0.1
    const decay = 0.012

    function spawnBurst() {
      if (cancelled || burstCount >= maxBursts) return
      burstCount++
      const w = cv.width
      const h = cv.height
      const cx = w * (0.2 + Math.random() * 0.6)
      const cy = h * (0.2 + Math.random() * 0.4)
      const hue = Math.floor(Math.random() * 360)
      const n = mini ? 32 : 64
      const baseSpeed = Math.min(w, h) * 0.012
      for (let i = 0; i < n; i++) {
        const angle = (Math.PI * 2 * i) / n + Math.random() * 0.25
        const speed = baseSpeed * (0.4 + Math.random() * 0.9)
        particles.push({
          x: cx, y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          color: `hsl(${hue}, 90%, 65%)`,
        })
      }
    }

    spawnBurst()
    const burstTimer = window.setInterval(spawnBurst, 950)

    function tick() {
      if (cancelled) return
      c2d.clearRect(0, 0, cv.width, cv.height)
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]
        p.vy += gravity
        p.x += p.vx
        p.y += p.vy
        p.life -= decay
        if (p.life <= 0) { particles.splice(i, 1); continue }
        c2d.globalAlpha = Math.max(0, p.life)
        c2d.fillStyle = p.color
        c2d.beginPath()
        c2d.arc(p.x, p.y, radius, 0, Math.PI * 2)
        c2d.fill()
      }
      c2d.globalAlpha = 1
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      clearInterval(burstTimer)
      ro.disconnect()
    }
  }, [loop, mini])

  return (
    <div className={`fx-fill fx-firework${loop ? ' fx-loop' : ''}`}>
      <canvas ref={canvasRef} className="fx-firework-canvas" />
      <div className="fx-name fx-name-pop" style={{ fontSize: mini ? 14 : 48 }}>
        {userName}
      </div>
    </div>
  )
}

export interface PresetDef {
  key: string
  label: string
  Icon: typeof Plane
  Component: (p: PresetProps) => React.ReactElement
}

export const ENTRY_PRESETS: PresetDef[] = [
  { key: 'plane_banner', label: '飞机横幅', Icon: Plane, Component: PlaneBanner },
  { key: 'heart_float', label: '爱心飘飘', Icon: Heart, Component: HeartFloat },
  { key: 'firework', label: '烟花绽放', Icon: Sparkles, Component: Firework },
  { key: 'sparkle', label: '星光闪耀', Icon: Star, Component: Sparkle },
]

export const PRESET_LABEL: Record<string, string> = Object.fromEntries(
  ENTRY_PRESETS.map((p) => [p.key, p.label]),
)

export const PRESET_COMPONENT: Record<string, PresetDef['Component']> = Object.fromEntries(
  ENTRY_PRESETS.map((p) => [p.key, p.Component]),
)
