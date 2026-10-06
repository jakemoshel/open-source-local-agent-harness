import { useCallback, useEffect, useRef, useState } from 'react'

type EaApi = {
  invoke: <T = unknown>(op: string, args?: unknown) => Promise<T>
  open: (target: string) => Promise<string>
  reveal: (target: string) => Promise<void>
  on: (fn: (channel: string, payload: unknown, profile: string) => void) => () => void
  onNavigate: (fn: (path: string) => void) => () => void
}

declare global {
  interface Window {
    ea: EaApi
  }
}

export const ea = window.ea

export function call<T = unknown>(op: string, args?: unknown): Promise<T> {
  const id = sessionStorage.getItem('jarvis-profile') || 'owner'
  const shared = /^(profiles_|auth_install_missing$|gateways_|services_|app_restart$|harness_restart$|doctor$|update_|permissions_|open_settings_pane$|hermes_|terminal_)/.test(op)
  return id === 'owner' || shared ? ea.invoke<T>(op, args) : ea.invoke<T>('profiles_call', { id, op, args })
}

type BusHandler = (channel: string, payload: unknown) => void
/** Events every profile view shows. */
const GLOBAL_CHANNELS = new Set(['gateway:update', 'update:status'])
const handlers = new Map<string, Set<BusHandler>>()
let unsubscribe: (() => void) | null = null

/** One IPC listener for the whole renderer (busy runs stream many events), fanned out by channel. */
function subscribe(channels: string[], fn: BusHandler): () => void {
  for (const c of channels) {
    let set = handlers.get(c)
    if (!set) handlers.set(c, (set = new Set()))
    set.add(fn)
  }
  unsubscribe ??= ea.on((c, p, profile) => {
    const set = handlers.get(c)
    if (!set?.size) return
    if (!GLOBAL_CHANNELS.has(c) && profile !== (sessionStorage.getItem('jarvis-profile') || 'owner')) return
    for (const h of [...set]) h(c, p)
  })
  return () => {
    for (const c of channels) {
      const set = handlers.get(c)
      set?.delete(fn)
      if (set && !set.size) handlers.delete(c)
    }
    if (!handlers.size && unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
  }
}

export function useBus(channels: string[], fn: (channel: string, payload: unknown) => void): void {
  const ref = useRef(fn)
  ref.current = fn
  const key = channels.join(',')
  useEffect(() => (key ? subscribe(key.split(','), (c, p) => ref.current(c, p)) : undefined), [key])
}

export function useOp<T>(op: string, args?: unknown, opts: { refreshOn?: string[]; throttleMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const argKey = JSON.stringify(args ?? {})
  const timer = useRef<number | null>(null)
  /** Only the latest request may set state: a slow answer for the previous chat must not replace the current one. */
  const seq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      const r = await call<T>(op, JSON.parse(argKey))
      if (mine !== seq.current) return
      setData(r)
      setError(null)
    } catch (err) {
      if (mine !== seq.current) return
      setError((err as Error).message)
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [op, argKey])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    seq.current++
  }, [])

  useBus(opts.refreshOn ?? [], () => {
    if (timer.current) return
    timer.current = window.setTimeout(() => {
      timer.current = null
      void load()
    }, opts.throttleMs ?? 250)
  })

  return { data, error, loading, reload: load, setData }
}
