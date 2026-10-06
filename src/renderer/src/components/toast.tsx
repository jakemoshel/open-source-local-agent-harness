import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { CircleAlert, CircleCheck } from 'lucide-react'

type Toast = { id: number; text: string; tone: 'ok' | 'error' }
const Ctx = createContext<(text: string, tone?: Toast['tone']) => void>(() => undefined)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random()
    setItems((x) => [...x, { id, text, tone }])
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'error' ? 6000 : 3000)
  }, [])
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} className="pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border border-line bg-bg px-3 py-2.5 text-[13px] shadow-[var(--shadow)]">
            {t.tone === 'ok' ? <CircleCheck className="mt-px size-4 shrink-0 text-green" /> : <CircleAlert className="mt-px size-4 shrink-0 text-red" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export const useToast = () => useContext(Ctx)

export function useAction() {
  const toast = useToast()
  return async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    try {
      const r = await fn()
      if (ok) toast(ok)
      return r
    } catch (err) {
      toast((err as Error).message, 'error')
      return undefined
    }
  }
}
