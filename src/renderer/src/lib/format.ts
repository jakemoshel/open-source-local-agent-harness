export function ago(ts: number | null | undefined): string {
  if (!ts) return '—'
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

export function until(ts: number | null | undefined): string {
  if (!ts) return '—'
  const s = Math.round((ts - Date.now()) / 1000)
  if (s < 60) return `in ${Math.max(0, s)}s`
  const m = Math.round(s / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `in ${h}h`
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function duration(start: number | null, end: number | null): string {
  if (!start) return '—'
  const ms = (end ?? Date.now()) - start
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function tokens(n: number | null | undefined): string {
  if (!n) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export function shortPath(p: string): string {
  const home = p.match(/^\/Users\/[^/]+/)?.[0]
  return home ? p.replace(home, '~') : p
}

export function cronText(expr: string): string {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return expr
  const [min, hour, dom, mon, dow] = f
  const time = /^\d+$/.test(min) && /^\d+$/.test(hour) ? new Date(2000, 0, 1, +hour, +min).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null
  const days: Record<string, string> = { '1-5': 'weekdays', '0,6': 'weekends', '*': 'every day', '1': 'Mondays', '0': 'Sundays', '5': 'Fridays' }
  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${min.slice(2)} minutes`
  if (min === '0' && hour.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') return `Every ${hour.slice(2)} hours`
  if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour'
  if (time && dom === '*' && mon === '*' && days[dow]) return `${days[dow][0].toUpperCase()}${days[dow].slice(1)} at ${time}`
  return expr
}
