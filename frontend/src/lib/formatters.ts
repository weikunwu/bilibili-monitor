export function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatTime(ts: string): string {
  if (!ts) return ''
  const d = new Date(ts + 'Z')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function formatCoin(battery: number, coinType?: string): string {
  if (!battery) return ''
  if (coinType === 'silver') return ''
  const sign = battery < 0 ? '-' : ''
  const yuan = Math.abs(battery) / 10
  return sign + '¥' + yuan.toFixed(1).replace(/\.0$/, '')
}

export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function fmtUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

export function localToUTC(s: string): string {
  return fmtUTC(new Date(s))
}

export function fixUrl(url: string): string {
  return url ? url.replace(/^http:\/\//, 'https://') : ''
}
