import { useEffect, useRef } from 'react'

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, opts: {
        sitekey: string
        callback: (token: string) => void
        'error-callback'?: () => void
        'expired-callback'?: () => void
        theme?: 'light' | 'dark' | 'auto'
        size?: 'normal' | 'compact'
      }) => string
      reset: (widgetId?: string) => void
      remove: (widgetId?: string) => void
    }
    onloadTurnstileCallback?: () => void
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js'

interface Props {
  siteKey: string
  onToken: (token: string) => void
  /** 让外部通过 ref 触发 reset（重新校验） */
  resetRef?: React.MutableRefObject<(() => void) | null>
}

export function TurnstileWidget({ siteKey, onToken, resetRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!siteKey) return
    if (!document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
      const s = document.createElement('script')
      s.src = SCRIPT_SRC
      s.async = true; s.defer = true
      document.head.appendChild(s)
    }

    let cancelled = false
    const render = () => {
      if (cancelled || !containerRef.current || !window.turnstile) return
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        theme: 'dark',
        callback: (token) => onToken(token),
        'error-callback': () => onToken(''),
        'expired-callback': () => onToken(''),
      })
    }
    if (window.turnstile) {
      render()
    } else {
      const iv = setInterval(() => {
        if (window.turnstile) { clearInterval(iv); render() }
      }, 100)
      return () => { cancelled = true; clearInterval(iv) }
    }
    if (resetRef) {
      resetRef.current = () => {
        if (widgetIdRef.current && window.turnstile) {
          window.turnstile.reset(widgetIdRef.current)
          onToken('')
        }
      }
    }

    return () => {
      cancelled = true
      if (widgetIdRef.current && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current) } catch { /* noop */ }
      }
      if (resetRef) resetRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey])

  if (!siteKey) return null
  return <div ref={containerRef} style={{ display: 'flex', justifyContent: 'center' }} />
}
