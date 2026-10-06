import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowLeft, Brain, ChevronRight, CircleAlert, CircleCheck, CornerDownLeft, FolderOpen, RotateCcw, ShieldAlert, Snowflake, Square, TerminalSquare, Wrench } from 'lucide-react'
import type { LiveDelta, Run, RunEvent } from '@shared/types'
import { call, ea, useBus, useOp } from '@/lib/api'
import { clockTime, duration, shortPath, tokens } from '@/lib/format'
import { cx } from '@/lib/cx'
import { ProviderLabel } from '@/components/NewRun'
import { TriggerLabel } from '@/components/RunsTable'
import { Badge, Button, Card, CopyButton, Segmented, Spinner, Status, Textarea } from '@/components/ui'
import { useAction } from '@/components/toast'

export const ACTIVE = new Set(['queued', 'running', 'awaiting_approval'])

function subject(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'op', 'description']) if (typeof i[k] === 'string') return i[k] as string
  return JSON.stringify(input).slice(0, 140)
}

export type Block =
  | { kind: 'user'; ev: RunEvent }
  | { kind: 'text'; ev: RunEvent }
  | { kind: 'thinking'; ev: RunEvent }
  | { kind: 'tool'; call: RunEvent; result?: RunEvent }
  | { kind: 'approval'; ev: RunEvent }
  | { kind: 'error'; ev: RunEvent }
  | { kind: 'system'; ev: RunEvent }

export function toBlocks(events: RunEvent[]): Block[] {
  const blocks: Block[] = []
  const tools = new Map<string, Block & { kind: 'tool' }>()
  const approvals = new Map<string, Block & { kind: 'approval' }>()
  for (const ev of events) {
    switch (ev.type) {
      case 'user':
      case 'text':
      case 'thinking':
      case 'error':
      case 'system':
        blocks.push({ kind: ev.type, ev } as Block)
        break
      case 'tool_call': {
        const b = { kind: 'tool' as const, call: ev }
        tools.set(String(ev.data.id), b)
        blocks.push(b)
        break
      }
      case 'tool_result': {
        const b = tools.get(String(ev.data.id))
        if (b) b.result = ev
        else blocks.push({ kind: 'tool', call: { ...ev, type: 'tool_call', data: { id: ev.data.id, name: 'tool', input: {} } }, result: ev })
        break
      }
      case 'approval': {
        const id = String(ev.data.approvalId ?? `${ev.seq}`)
        const existing = approvals.get(id)
        if (existing) existing.ev = { ...existing.ev, data: { ...existing.ev.data, ...ev.data } }
        else {
          const b = { kind: 'approval' as const, ev }
          approvals.set(id, b)
          blocks.push(b)
        }
        break
      }
    }
  }
  return blocks
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-sm selectable text-[14px]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

function ToolRow({ b }: { b: Block & { kind: 'tool' } }) {
  const [open, setOpen] = useState(false)
  const name = String(b.call.data.name)
  const input = b.call.data.input
  const err = b.result?.data.isError === true
  const out = b.result ? String(b.result.data.output ?? '') : ''
  return (
    <div className="rounded-md border border-line bg-bg">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-bg-2">
        <ChevronRight className={cx('size-3.5 shrink-0 text-fg-3 transition-transform', open && 'rotate-90')} />
        {name === 'Bash' || name === 'shell' ? <TerminalSquare className="size-3.5 shrink-0 text-fg-2" /> : <Wrench className="size-3.5 shrink-0 text-fg-2" />}
        <span className="shrink-0 font-medium">{name.replace(/^mcp__/, '').replace(/__/g, ' · ')}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-2">{subject(input)}</span>
        {!b.result ? <Spinner className="size-3.5" /> : err ? <CircleAlert className="size-3.5 text-red" /> : <CircleCheck className="size-3.5 text-green" />}
      </button>
      {open && (
        <div className="space-y-2 border-t border-line p-3">
          <div>
            <div className="mb-1 text-[11px] font-medium tracking-wide text-fg-3 uppercase">Input</div>
            <pre className="selectable max-h-72 overflow-auto rounded bg-bg-2 p-2 font-mono text-xs whitespace-pre-wrap">{JSON.stringify(input, null, 2)}</pre>
          </div>
          {b.result && (
            <div>
              <div className="mb-1 flex items-center justify-between text-[11px] font-medium tracking-wide text-fg-3 uppercase">
                Output <CopyButton text={out} />
              </div>
              <pre className={cx('selectable max-h-96 overflow-auto rounded bg-bg-2 p-2 font-mono text-xs whitespace-pre-wrap', err && 'text-red')}>{out || '(empty)'}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-2 text-left text-[13px] text-fg-3 hover:text-fg-2">
      <Brain className="mt-0.5 size-3.5 shrink-0" />
      <span className={cx('selectable whitespace-pre-wrap', !open && 'line-clamp-1')}>{text}</span>
    </button>
  )
}

function ApprovalBlock({ ev }: { ev: RunEvent }) {
  const act = useAction()
  const d = ev.data as { approvalId?: string; tool: string; input?: unknown; status: string; rule?: string | null; auto?: boolean }
  return (
    <div className={cx('flex items-center gap-3 rounded-md border px-3 py-2.5 text-[13px]', d.status === 'pending' ? 'border-purple/40 bg-purple/8' : 'border-line bg-bg')}>
      <ShieldAlert className={cx('size-4 shrink-0', d.status === 'pending' ? 'text-purple' : d.status === 'approved' ? 'text-green' : 'text-red')} />
      <div className="min-w-0 flex-1">
        <div>
          <span className="font-medium">{d.tool}</span>
          {d.rule && <span className="ml-2 text-fg-3">rule “{d.rule}”</span>}
        </div>
        {d.input !== undefined && <div className="truncate font-mono text-xs text-fg-2">{subject(d.input)}</div>}
      </div>
      {d.status === 'pending' && d.approvalId ? (
        <>
          <Button size="sm" onClick={() => act(() => call('approvals_resolve', { id: d.approvalId, approve: false }))}>
            Deny
          </Button>
          <Button size="sm" title="Approve, and stop asking about this exact action" onClick={() => act(() => call('approvals_resolve', { id: d.approvalId, approve: true, always: true }))}>
            Always allow
          </Button>
          <Button size="sm" variant="primary" onClick={() => act(() => call('approvals_resolve', { id: d.approvalId, approve: true }))}>
            Approve
          </Button>
        </>
      ) : (
        <Badge tone={d.status === 'approved' ? 'green' : 'red'}>{d.auto ? 'blocked by rule' : d.status}</Badge>
      )}
    </div>
  )
}

export function Transcript({ blocks, live, active }: { blocks: Block[]; live: string; active: boolean }) {
  return (
    <div className="space-y-3">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'user':
            return (
              <div key={i} className="flex justify-end">
                <div className="selectable max-w-[80%] rounded-2xl rounded-br-md bg-fg px-4 py-2.5 text-[14px] whitespace-pre-wrap text-bg">{String(b.ev.data.text)}</div>
              </div>
            )
          case 'text':
            return (
              <div key={i} className="py-1">
                <Markdown text={String(b.ev.data.text)} />
              </div>
            )
          case 'thinking':
            return <Thinking key={i} text={String(b.ev.data.text)} />
          case 'tool':
            return <ToolRow key={i} b={b} />
          case 'approval':
            return <ApprovalBlock key={i} ev={b.ev} />
          case 'error':
            return (
              <div key={i} className="selectable rounded-md border border-red/30 bg-red/8 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-red">
                {String(b.ev.data.message)}
              </div>
            )
          case 'system':
            return b.ev.data.codexServerRequest ? (
              <div key={i} className="selectable rounded-md border border-red/30 bg-red/8 px-3 py-2 text-xs whitespace-pre-wrap text-red">
                {String(b.ev.data.message)} · {String(b.ev.data.codexServerRequest)}
              </div>
            ) : null
        }
      })}
      {live && (
        <div className="py-1">
          <div className="prose-sm selectable caret text-[14px] whitespace-pre-wrap">{live}</div>
        </div>
      )}
      {active && !live && (
        <div className="flex items-center gap-2 py-1 text-[13px] text-fg-3">
          <Spinner className="size-3.5" /> Working…
        </div>
      )}
    </div>
  )
}

function Logs({ events }: { events: RunEvent[] }) {
  const color: Record<string, string> = { error: 'text-red', approval: 'text-purple', status: 'text-accent', tool_call: 'text-fg', tool_result: 'text-fg-2', text: 'text-fg', user: 'text-amber' }
  return (
    <div className="selectable overflow-x-auto rounded-md bg-bg py-2 font-mono text-[12.5px] leading-6">
      {events.map((e) => {
        const d = e.data
        const line =
          e.type === 'tool_call'
            ? `${d.name} ${subject(d.input)}`
            : e.type === 'tool_result'
              ? String(d.output ?? '').split('\n').slice(0, 3).join(' ⏎ ').slice(0, 300)
              : e.type === 'text' || e.type === 'user' || e.type === 'thinking'
                ? String(d.text ?? '').replace(/\s+/g, ' ').slice(0, 300)
                : JSON.stringify(d)
        return (
          <div key={e.seq} className="flex gap-4 px-4 hover:bg-bg-2">
            <span className="w-16 shrink-0 text-fg-3">{clockTime(e.ts)}</span>
            <span className={cx('w-24 shrink-0', color[e.type] ?? 'text-fg-2')}>{e.type}</span>
            <span className="min-w-0 flex-1 truncate">{line}</span>
          </div>
        )
      })}
    </div>
  )
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-fg-3">{label}</div>
      <div className="mt-1 truncate text-[13px]">{children}</div>
    </div>
  )
}

export function RunDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const act = useAction()
  const [run, setRun] = useState<Run | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [live, setLive] = useState('')
  const [view, setView] = useState<'transcript' | 'logs'>('transcript')
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    if (!id) return
    setRun(null)
    setEvents([])
    setLive('')
    // Answers for a run we already navigated away from are dropped; events that streamed in while loading are kept.
    let current = true
    void call<Run>('runs_get', { id, events: false }).then((r) => current && setRun(r), () => undefined)
    void call<RunEvent[]>('runs_events', { id }).then((list) => {
      if (!current) return
      const seen = new Set(list.map((e) => e.seq))
      setEvents((xs) => [...list, ...xs.filter((x) => !seen.has(x.seq))].sort((a, b) => a.seq - b.seq))
    }, () => undefined)
    return () => { current = false }
  }, [id])

  useBus(['run:event', 'run:delta', 'run:update'], (channel, payload) => {
    if (channel === 'run:event') {
      const ev = payload as RunEvent
      if (ev.runId !== id) return
      setEvents((xs) => (xs.some((x) => x.seq === ev.seq) ? xs : [...xs, ev]))
      if (ev.type === 'text' || ev.type === 'tool_call') setLive('')
    } else if (channel === 'run:delta') {
      const d = payload as LiveDelta
      if (d.runId === id) setLive((s) => s + d.text)
    } else if (payload && (payload as Run).id === id) {
      setRun(payload as Run)
      if (!ACTIVE.has((payload as Run).status)) setLive('')
    }
  })

  const { data: thread } = useOp<Run[]>('runs_list', { conversationKey: run?.conversationKey ?? '__none__', limit: 200 }, { refreshOn: ['run:update'] })
  const turns = useMemo(() => (run?.conversationKey ? [...(thread ?? [])].sort((a, b) => a.createdAt - b.createdAt) : []), [thread, run?.conversationKey])
  const idx = turns.findIndex((t) => t.id === id)
  const prev = idx > 0 ? turns[idx - 1] : null
  const cacheCold = prev?.finishedAt && run?.startedAt ? run.startedAt - prev.finishedAt > 5 * 60_000 : false

  const { data: children } = useOp<Run[]>('runs_list', { parentRunId: id, limit: 20 }, { refreshOn: ['run:update'] })
  const blocks = useMemo(() => toBlocks(events), [events])
  const active = run ? ACTIVE.has(run.status) : false

  useEffect(() => {
    const main = bottom.current?.closest('main')
    if (!main) return
    const onScroll = () => (stick.current = main.scrollHeight - main.scrollTop - main.clientHeight < 120)
    main.addEventListener('scroll', onScroll)
    return () => main.removeEventListener('scroll', onScroll)
  }, [run?.id])

  useEffect(() => {
    if (stick.current && active) bottom.current?.scrollIntoView({ block: 'end' })
  }, [events.length, live, active])

  if (!run)
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    )

  const send = async () => {
    if (!reply.trim()) return
    setSending(true)
    const next = await act(() => call<Run>('runs_start', { prompt: reply, provider: run.provider, model: run.model ?? undefined, cwd: run.cwd, conversationKey: run.conversationKey }))
    setSending(false)
    if (next) {
      setReply('')
      navigate(`/runs/${next.id}`)
    }
  }

  const rerun = async () => {
    const next = await act(() =>
      call<Run>('runs_start', { prompt: run.prompt, provider: run.provider, model: run.model ?? undefined, cwd: run.cwd, conversationKey: `ui:${crypto.randomUUID()}` })
    )
    if (next) navigate(`/runs/${next.id}`)
  }

  const canContinue = !!run.conversationKey && run.trigger !== 'imported' && !active && turns[turns.length - 1]?.id === run.id

  return (
    <>
      <Link to="/runs" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-fg-2 hover:text-fg">
        <ArrowLeft className="size-3.5" /> Runs
      </Link>
      <div className="mb-5 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-[-0.02em]">{run.title}</h1>
          <div className="mt-1 font-mono text-xs text-fg-3">{run.id}</div>
        </div>
        <div className="flex shrink-0 gap-2">
          {active ? (
            <Button icon={<Square className="size-3.5" />} onClick={() => act(() => call('runs_cancel', { id: run.id }), 'Cancel requested')}>
              Cancel
            </Button>
          ) : (
            run.trigger !== 'imported' && (
              <Button icon={<RotateCcw className="size-3.5" />} onClick={rerun}>
                Rerun
              </Button>
            )
          )}
          <Button icon={<FolderOpen className="size-3.5" />} onClick={() => ea.open(run.cwd)}>
            Open folder
          </Button>
        </div>
      </div>

      <Card className="mb-6 grid grid-cols-6 gap-6 px-5 py-4">
        <Meta label="Status">
          <Status status={run.status} />
        </Meta>
        <Meta label="Agent">{run.trigger === 'imported' ? 'Hermes' : <ProviderLabel id={run.provider} />}</Meta>
        <Meta label="Source">
          <TriggerLabel trigger={run.trigger} />
        </Meta>
        <Meta label="Duration">{duration(run.startedAt, run.finishedAt)}</Meta>
        <Meta label="Tokens">
          {run.usage ? (
            <span title={`${run.usage.inputTokens} in (${run.usage.cachedInputTokens} cached) · ${run.usage.outputTokens} out`}>
              {tokens(run.usage.inputTokens)} in · {tokens(run.usage.outputTokens)} out
            </span>
          ) : (
            '—'
          )}
        </Meta>
        <Meta label="Directory">
          <span className="font-mono text-xs">{shortPath(run.cwd)}</span>
        </Meta>
        {(run.model || turns.length > 1 || cacheCold || run.error) && (
          <div className="col-span-6 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            {run.model && <Badge>{run.model}</Badge>}
            {turns.length > 1 && (
              <Badge tone="blue">
                Turn {idx + 1} of {turns.length}
              </Badge>
            )}
            {cacheCold && (
              <Badge tone="amber">
                <Snowflake className="size-3" /> Prompt cache likely cold (idle {Math.round((run.startedAt! - prev!.finishedAt!) / 60000)}m)
              </Badge>
            )}
            {run.error && <span className="selectable text-[13px] text-red">{run.error}</span>}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-[minmax(0,1fr)_220px] gap-6">
        <div>
          <div className="mb-3 flex items-center justify-between">
            <Segmented
              value={view}
              onChange={setView}
              options={[
                { value: 'transcript', label: 'Transcript' },
                { value: 'logs', label: 'Logs' }
              ]}
            />
            <span className="text-xs text-fg-3">{events.length} events</span>
          </div>
          <Card className="p-5">{view === 'transcript' ? <Transcript blocks={blocks} live={live} active={active} /> : <Logs events={events} />}</Card>
          {canContinue && (
            <Card className="mt-4 p-3">
              <Textarea
                rows={3}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || !e.shiftKey) && (e.preventDefault(), void send())}
                placeholder="Reply to continue this conversation…"
                className="border-0 px-1 focus:border-0"
              />
              <div className="flex items-center justify-between px-1 pt-1">
                <span className="text-xs text-fg-3">Continues the same {run.provider === 'claude' ? 'Claude Code session' : 'Codex thread'}</span>
                <Button size="sm" variant="primary" loading={sending} disabled={!reply.trim()} onClick={send} icon={<CornerDownLeft className="size-3.5" />}>
                  Send
                </Button>
              </div>
            </Card>
          )}
          <div ref={bottom} />
        </div>

        <div>
          {turns.length > 1 && (
            <>
              <div className="mb-2 text-xs font-medium text-fg-3">Conversation</div>
              <div className="space-y-1">
                {turns.map((t, i) => (
                  <Link
                    key={t.id}
                    to={`/runs/${t.id}`}
                    className={cx('flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]', t.id === id ? 'bg-bg text-fg shadow-[0_0_0_1px_var(--border)]' : 'text-fg-2 hover:bg-hover')}
                  >
                    <span className="w-4 text-xs text-fg-3">{i + 1}</span>
                    <span className="truncate">{t.prompt.split('\n')[0]}</span>
                  </Link>
                ))}
              </div>
            </>
          )}
          {!!children?.length && (
            <div className="mt-4">
              <div className="mb-2 text-xs font-medium text-fg-3">Follow-up runs</div>
              <div className="space-y-2">
                {children.map((c) => (
                  <Link key={c.id} to={`/runs/${c.id}`} className="block rounded-md border border-line bg-bg px-2.5 py-2 text-[13px] hover:border-line-2">
                    <div className="truncate font-medium">{c.title.startsWith('↻') ? 'Learning' : c.title}</div>
                    <div className="line-clamp-3 text-xs text-fg-2">{c.result || (ACTIVE.has(c.status) ? 'Running…' : c.status)}</div>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {run.parentRunId && (
            <div className="mt-4 text-[13px]">
              <div className="mb-1 text-xs font-medium text-fg-3">Started by</div>
              <Link to={`/runs/${run.parentRunId}`} className="text-accent hover:underline">
                Parent run
              </Link>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
