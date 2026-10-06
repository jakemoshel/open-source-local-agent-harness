import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { call, useOp } from '@/lib/api'
import { cx } from '@/lib/cx'
import { Badge, Button, Empty, Input, PageHeader } from '@/components/ui'
import { useAction } from '@/components/toast'

type TerminalInfo = { id: string; name: string; cwd: string; running: boolean; exitCode: number | null; cursor: number; startedAt: number }
type ReadResult = TerminalInfo & { output: string; truncated: boolean }

/** The same persistent terminals agents use (terminal_* ops), so you can watch or take over what they started. */
export function Terminal() {
  const [params, setParams] = useSearchParams()
  const { data: list, reload } = useOp<TerminalInfo[]>('terminal_list')
  const act = useAction()
  const [selected, setSelected] = useState<string | null>(null)
  const [output, setOutput] = useState('')
  const [line, setLine] = useState('')
  const cursor = useRef<number | undefined>(undefined)
  const pane = useRef<HTMLPreElement>(null)
  const current = list?.find((t) => t.id === selected) ?? null

  useEffect(() => {
    const requested = params.get('session')
    if (requested && list?.some((t) => t.id === requested) && selected !== requested) setSelected(requested)
    else if (list?.length && !list.some((t) => t.id === selected)) setSelected(list[0].id)
  }, [list, selected, params])

  // Poll while a terminal is shown: cheap, and survives renderer reloads without missing output.
  useEffect(() => {
    if (!selected) return
    cursor.current = undefined
    setOutput('')
    let stop = false
    const tick = async () => {
      try {
        const r = await call<ReadResult>('terminal_read', { id: selected, since: cursor.current, maxChars: 60_000 })
        if (stop) return
        // Reads continue exactly where the last one ended; output keeps its own line breaks.
        if (r.output) setOutput((o) => (cursor.current === undefined ? r.output : (o + r.output).slice(-200_000)))
        cursor.current = r.cursor
        if (!r.running) void reload()
      } catch {
        void reload()
      }
      if (!stop) setTimeout(tick, 1000)
    }
    void tick()
    return () => {
      stop = true
    }
  }, [selected, reload])

  useEffect(() => {
    pane.current?.scrollTo({ top: pane.current.scrollHeight })
  }, [output])

  const open = async () => {
    const t = await act(() => call<TerminalInfo>('terminal_open', {}))
    if (t) {
      await reload()
      setSelected(t.id)
      setParams({ session: t.id })
    }
  }
  const send = async (payload: { input?: string; keys?: string[] }) => {
    if (!selected) return
    await act(() => call('terminal_send', { id: selected, ...payload, waitMs: 0 }))
  }
  const close = async () => {
    if (!selected) return
    await act(() => call('terminal_close', { id: selected }))
    setParams({})
    await reload()
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <PageHeader
        title="Terminal"
        description="Persistent shells on this Mac. Agents open them with terminal_open to keep servers, builds and ssh sessions running between tasks."
        actions={<Button onClick={open}>New terminal</Button>}
      />
      {!list?.length ? (
        <Empty title="No terminals open" description="Open one here, or ask Jarvis to run something in a terminal." action={<Button onClick={open}>New terminal</Button>} />
      ) : (
        <div className="flex min-h-0 flex-1 gap-4">
          <div className="w-52 shrink-0 space-y-1 overflow-y-auto">
            {list.map((t) => (
              <button
                key={t.id}
                onClick={() => { setSelected(t.id); setParams({ session: t.id }) }}
                className={cx('w-full rounded-md px-3 py-2 text-left text-sm', t.id === selected ? 'bg-bg-3 text-fg-1' : 'text-fg-2 hover:bg-bg-2')}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{t.name}</span>
                  {t.running ? <Badge tone="green">live</Badge> : <Badge>exit {t.exitCode ?? '?'}</Badge>}
                </div>
                <div className="truncate text-xs text-fg-3">{t.cwd}</div>
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <pre ref={pane} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[#111] p-3 font-mono text-xs leading-5 text-[#ddd]">
              {output || ' '}
            </pre>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void send({ input: line })
                setLine('')
              }}
            >
              <Input mono className="flex-1" value={line} onChange={(e) => setLine(e.target.value)} placeholder={current?.running ? 'Type a command and press Enter' : 'This terminal has exited'} disabled={!current?.running} />
              <Button type="button" variant="secondary" disabled={!current?.running} onClick={() => void send({ keys: ['ctrl-c'] })}>Ctrl-C</Button>
              <Button type="button" variant="secondary" onClick={close}>{current?.running ? 'Close' : 'Remove'}</Button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
