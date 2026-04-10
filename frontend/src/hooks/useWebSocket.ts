import { useEffect, useRef, useState, useCallback } from 'react'
import type { LiveEvent, ConnectionStatus } from '../types'

export function useWebSocket(onEvent: (ev: LiveEvent) => void) {
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const wsRef = useRef<WebSocket | null>(null)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  const connect = useCallback(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    wsRef.current = ws

    ws.onopen = () => setStatus('connected')
    ws.onmessage = (e) => {
      try {
        const ev: LiveEvent = JSON.parse(e.data)
        if (!ev.extra) ev.extra = {} as never
        onEventRef.current(ev)
      } catch { /* ignore */ }
    }
    ws.onclose = () => {
      setStatus('disconnected')
      setTimeout(connect, 3000)
    }
    ws.onerror = () => setStatus('disconnected')
  }, [])

  useEffect(() => {
    connect()
    return () => { wsRef.current?.close() }
  }, [connect])

  return status
}
