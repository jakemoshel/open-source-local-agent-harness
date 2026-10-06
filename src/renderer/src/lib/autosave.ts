import { useCallback, useEffect, useRef, useState } from 'react'
import { useAction } from '@/components/toast'

export function useAutoSave<T>(saved: T | null | undefined, save: (draft: T) => Promise<unknown>, delay = 600) {
  const act = useAction()
  const [draft, setDraftState] = useState<T | null>(saved ?? null)
  const latest = useRef<T | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const inflight = useRef(0)
  const savedRef = useRef(saved)
  const saveRef = useRef(save)
  const actRef = useRef(act)
  savedRef.current = saved
  saveRef.current = save
  actRef.current = act

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    const d = latest.current
    if (d === null) return
    latest.current = null
    inflight.current++
    const ok = await actRef.current(async () => { await saveRef.current(d); return true })
    inflight.current--
    if (!ok && latest.current === null && savedRef.current != null) setDraftState(savedRef.current as T)
  }, [])

  useEffect(() => {
    if (saved != null && latest.current === null && inflight.current === 0) setDraftState(saved as T)
  }, [saved])

  useEffect(() => () => { void flush() }, [flush])

  const setDraft = useCallback((next: T) => {
    latest.current = next
    setDraftState(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), delay)
  }, [delay, flush])

  const discard = useCallback(() => {
    clearTimeout(timer.current)
    latest.current = null
    if (savedRef.current != null) setDraftState(savedRef.current as T)
  }, [])

  return [draft, setDraft, discard] as const
}
