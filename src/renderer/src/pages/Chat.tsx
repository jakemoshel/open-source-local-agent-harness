import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowUp, Calendar, ChevronRight, FolderOpen, Hash, MessageSquare, MonitorSmartphone, Plus, RotateCcw, Search, Square } from 'lucide-react'
import type { ConversationSummary, HarnessConfig, LiveDelta, ProviderId, Run, RunEvent, RunTrigger } from '@shared/types'
import { call, useBus, useOp } from '@/lib/api'
import { EffortSelect, ModelSelect } from '@/components/ModelPicker'
import { ago, duration, shortPath, tokens } from '@/lib/format'
import { cx } from '@/lib/cx'
import { ClaudeMark, CodexMark } from '@/components/NewRun'
import { Button, Mark, StatusDot } from '@/components/ui'
import { useAction, useToast } from '@/components/toast'
import { ACTIVE, Transcript, toBlocks } from './RunDetail'

const sourceIcon: Partial<Record<RunTrigger, React.ReactNode>> = {
  ui: <MonitorSmartphone className="size-3.5" />,
  slack: <Hash className="size-3.5" />,
  imessage: <MessageSquare className="size-3.5" />,
  schedule: <Calendar className="size-3.5" />
}

const sourceLabel: Record<RunTrigger, string> = { ui: 'App', imessage: 'iMessage', slack: 'Slack', schedule: 'Schedules', imported: 'Imported', agent: 'Agent', bench: 'Benchmark' }

const SUGGESTIONS = [
  'What’s on my plate today?',
  'Brief me every weekday at 8am',
  'Run diagnostics',
  'Which skills look stale?'
]

type Grouping = 'date' | 'source'
interface Group { id: string; label: string; chats: ConversationSummary[] }

/** Per-window conveniences; storage can be unavailable, and the sidebar works the same without it. */
function stored<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : fallback } catch { return fallback }
}
function store(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* not persisted */ }
}

/** Long groups show their newest chats; the rest are one click away. */
const PREVIEW = 8
/** Background and imported threads start folded so live chats stay in view. */
const FOLDED_BY_DEFAULT = ['source:imported', 'source:bench', 'source:agent']

function groupChats(chats: ConversationSummary[], by: Grouping): Group[] {
  // Running chats sit on top whatever the grouping, like an inbox's unread section.
  const running = chats.filter((c) => ACTIVE.has(c.lastStatus))
  const rest = chats.filter((c) => !ACTIVE.has(c.lastStatus))
  const groups: Group[] = running.length ? [{ id: 'running', label: 'Running', chats: running }] : []
  if (by === 'source') {
    for (const [source, label] of Object.entries(sourceLabel)) groups.push({ id: `source:${source}`, label, chats: rest.filter((c) => c.source === source) })
  } else {
    const day = new Date()
    day.setHours(0, 0, 0, 0)
    const today = day.getTime()
    const DAY = 86_400_000
    const spans: [string, string, number][] = [['today', 'Today', today], ['yesterday', 'Yesterday', today - DAY], ['week', 'Previous 7 days', today - 7 * DAY], ['month', 'Previous 30 days', today - 30 * DAY], ['older', 'Older', -Infinity]]
    const byDate: Group[] = spans.map(([id, label]) => ({ id: `date:${id}`, label, chats: [] }))
    for (const c of rest) byDate[spans.findIndex(([, , from]) => c.updatedAt >= from)].chats.push(c)
    groups.push(...byDate)
  }
  return groups.filter((g) => g.chats.length)
}

function Sidebar({ active }: { active: string | null }) {
  const [q, setQ] = useState('')
  const [by, setBy] = useState<Grouping>(() => stored('chat.sidebar.groupBy', 'date'))
  const [folded, setFolded] = useState<string[]>(() => stored('chat.sidebar.folded', FOLDED_BY_DEFAULT))
  const [expanded, setExpanded] = useState<string[]>([])
  const { data } = useOp<ConversationSummary[]>('conversations_list', { limit: 300, q: q || undefined }, { refreshOn: ['run:update'], throttleMs: 500 })
  const navigate = useNavigate()
  const groups = groupChats(data ?? [], by)
  const toggle = (id: string) => setFolded((f) => {
    const next = f.includes(id) ? f.filter((x) => x !== id) : [...f, id]
    store('chat.sidebar.folded', next)
    return next
  })
  const pickGrouping = (next: Grouping) => {
    setBy(next)
    store('chat.sidebar.groupBy', next)
  }
  return (
    <aside className="flex w-[268px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="space-y-2 p-3">
        <Button variant="primary" className="w-full" icon={<Plus className="size-3.5" />} onClick={() => navigate('/chat')}>
          New chat
        </Button>
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chats" placeholder="Search chats" className="h-8 w-full rounded-md bg-bg-2 pr-2 pl-8 text-[13px] outline-none placeholder:text-fg-3" />
        </div>
        <div className="flex items-center gap-1 text-[11px] text-fg-3" role="radiogroup" aria-label="Group chats by">
          <span className="mr-1">Group by</span>
          {(['date', 'source'] as const).map((g) => (
            <button key={g} role="radio" aria-checked={by === g} onClick={() => pickGrouping(g)} className={cx('rounded px-1.5 py-0.5 capitalize', by === g ? 'bg-bg-3 text-fg' : 'hover:text-fg')}>
              {g}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {groups.map((g) => {
          // A search shows every match, and the open chat is never hidden inside a folded group.
          const open = !!q || !folded.includes(g.id) || g.chats.some((c) => c.key === active)
          const all = !!q || expanded.includes(g.id)
          const shown = all ? g.chats : g.chats.slice(0, PREVIEW)
          return (
            <section key={g.id} aria-label={g.label} className="mt-2 first:mt-0">
              <button onClick={() => toggle(g.id)} aria-expanded={open} className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-fg-3 hover:text-fg">
                <ChevronRight className={cx('size-3 transition-transform', open && 'rotate-90')} />
                <span className="flex-1 text-left">{g.label}</span>
                <span className="tabular-nums">{g.chats.length}</span>
              </button>
              {open && (
                <div className="space-y-px">
                  {shown.map((c) => (
                    <Link
                      key={c.key}
                      to={`/chat/${encodeURIComponent(c.key)}`}
                      title={`${c.title}\n${sourceLabel[c.source] ?? c.source} · ${c.turns} turn${c.turns === 1 ? '' : 's'}`}
                      className={cx('flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]', c.key === active ? 'bg-bg-3 text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg')}
                    >
                      <span className="shrink-0 text-fg-3">{sourceIcon[c.source] ?? <MonitorSmartphone className="size-3.5" />}</span>
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                      {ACTIVE.has(c.lastStatus) ? <StatusDot status={c.lastStatus} className="size-2" /> : <span className="shrink-0 text-[11px] text-fg-3">{ago(c.updatedAt).replace(' ago', '')}</span>}
                    </Link>
                  ))}
                  {g.chats.length > shown.length && (
                    <button onClick={() => setExpanded((x) => [...x, g.id])} className="w-full rounded-md px-2 py-1 text-left text-[12px] text-fg-3 hover:bg-hover hover:text-fg">
                      Show all {g.chats.length}
                    </button>
                  )}
                </div>
              )}
            </section>
          )
        })}
        {data && !data.length && <div className="px-2 py-6 text-center text-xs text-fg-3">{q ? 'No matches' : 'No chats yet'}</div>}
      </div>
    </aside>
  )
}

function Composer({
  disabled,
  running,
  onSend,
  onStop,
  provider,
  setProvider,
  model,
  setModel,
  effort,
  setEffort,
  cwd,
  setCwd,
  config,
  autoFocusKey
}: {
  disabled?: boolean
  running: boolean
  onSend: (text: string) => Promise<boolean>
  onStop: () => void
  provider: ProviderId
  setProvider: (p: ProviderId) => void
  model: string
  setModel: (m: string) => void
  effort: string
  setEffort: (e: string) => void
  cwd: string
  setCwd: (c: string) => void
  config: HarnessConfig | null
  autoFocusKey: string
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [autoFocusKey])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`
    el.style.overflowY = el.scrollHeight > 280 ? 'auto' : 'hidden'
  }, [text])
  const send = async () => {
    if (!text.trim() || disabled || sending) return
    const submitted = text
    setSending(true)
    try {
      if (await onSend(submitted)) setText((current) => current === submitted ? '' : current)
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="rounded-2xl border border-line bg-surface shadow-[var(--shadow)] focus-within:border-fg-3">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
        placeholder={running ? 'Steer the current task…' : 'Message Jarvis…'}
        className="block max-h-[280px] w-full resize-none bg-transparent focus-visible:outline-none px-4 pt-3.5 pb-1 text-[15px] leading-relaxed outline-none placeholder:text-fg-3"
      />
      <div className="flex items-center gap-2 px-2.5 pb-2.5">
        <div className="flex rounded-md bg-bg-2 p-0.5">
          {(['claude', 'codex'] as const).map((p) => (
            <button
              key={p}
              onClick={() => { if (p !== provider) { setModel(''); setEffort('') } setProvider(p) }}
              title={p === 'claude' ? 'Claude Code' : 'Codex'}
              className={cx('flex h-6 items-center gap-1.5 rounded px-2 text-xs font-medium', provider === p ? 'bg-bg text-fg shadow-[0_0_0_1px_var(--border-2)]' : 'text-fg-3 hover:text-fg')}
            >
              {p === 'claude' ? <ClaudeMark className="size-3" /> : <CodexMark className="size-3" />}
              {p === 'claude' ? 'Claude' : 'Codex'}
            </button>
          ))}
        </div>
        <ModelSelect compact provider={provider} value={model} onChange={setModel} defaultLabel={`Default${config?.providers[provider].model ? ` (${config.providers[provider].model})` : ' model'}`} />
        <EffortSelect compact provider={provider} model={model || config?.providers[provider].model || ''} value={effort} onChange={setEffort} defaultLabel="Default effort" />
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-bg-2 px-2">
          <FolderOpen className="size-3.5 shrink-0 text-fg-3" />
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={config?.defaultCwd || '~'} className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-fg-3" />
        </div>
        {running && (
          <Button size="sm" onClick={onStop} icon={<Square className="size-3" />}>
            Stop
          </Button>
        )}
        <button
          onClick={send}
          disabled={!text.trim() || disabled || sending}
          className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent text-on-accent transition-opacity disabled:opacity-25"
          title={running ? 'Steer task (Enter)' : 'Send (Enter)'}
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  )
}

export function Chat() {
  const params = useParams<{ key?: string }>()
  const key = params.key ? decodeURIComponent(params.key) : null
  const navigate = useNavigate()
  const act = useAction()
  const toast = useToast()
  const { data: config } = useOp<HarnessConfig>('config_get', {}, { refreshOn: ['config:changed'] })
  const [runs, setRuns] = useState<Run[]>([])
  const [events, setEvents] = useState<Record<string, RunEvent[]>>({})
  const [live, setLive] = useState<Record<string, string>>({})
  const [provider, setProvider] = useState<ProviderId>('claude')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [cwd, setCwd] = useState('')
  const [sidebar, setSidebar] = useState(() => stored('chat.sidebar.open', true))
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  /** The open thread's run ids, updated synchronously: bus events can arrive before React re-renders. */
  const ids = useRef(new Set<string>())
  const current = useRef(key)
  current.current = key
  /** Preserve pickers and the first run's stream when opening a thread from this composer. */
  const started = useRef<{ key: string; runId?: string } | null>(null)

  useEffect(() => {
    if (!key && config) setProvider(config.defaultProvider)
  }, [key, config])

  const loadThread = async (k: string) => {
    const list = (await call<Run[]>('runs_list', { conversationKey: k, limit: 500 })).sort((a, b) => a.createdAt - b.createdAt)
    // A slow answer for the chat we just left must not replace the one now open.
    if (current.current !== k) return
    for (const r of list) ids.current.add(r.id)
    setRuns((xs) => [...list, ...xs.filter((x) => !list.some((r) => r.id === x.id))].sort((a, b) => a.createdAt - b.createdAt))
    const last = list[list.length - 1]
    if (last) {
      setProvider(last.provider)
      setModel(last.model && last.model !== config?.providers[last.provider].model ? last.model : '')
      setCwd(last.cwd)
    }
    const evs = await call<Record<string, RunEvent[]>>('runs_events_many', { ids: list.map((r) => r.id) })
    if (current.current !== k) return
    // Events that streamed in while loading are kept; the fetched history fills in the rest.
    setEvents((m) => {
      const merged = { ...m }
      for (const [id, fetched] of Object.entries(evs)) {
        const seen = new Set(fetched.map((e) => e.seq))
        merged[id] = [...fetched, ...(m[id] ?? []).filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq)
      }
      return merged
    })
  }

  useEffect(() => {
    setRuns([])
    setEvents({})
    setLive({})
    const own = started.current?.key === key ? started.current : null
    started.current = null
    ids.current = new Set(own?.runId ? [own.runId] : [])
    stick.current = true
    // Models and efforts are per chat (and per provider); never carry one chat's picks into another.
    if (!own) {
      setModel('')
      setEffort('')
    }
    if (key) void loadThread(key).catch(() => undefined)
    else setCwd('')
  }, [key])

  // ⌘B shows or hides the chat list, as in Hermes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'b') return
      e.preventDefault()
      setSidebar((open) => {
        store('chat.sidebar.open', !open)
        return !open
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useBus(['run:event', 'run:delta', 'run:update'], (channel, payload) => {
    if (channel === 'run:update') {
      const r = payload as Run | null
      if (!r || !key || r.conversationKey !== key) return
      ids.current.add(r.id)
      setRuns((xs) => (xs.some((x) => x.id === r.id) ? xs.map((x) => (x.id === r.id ? r : x)) : [...xs, r].sort((a, b) => a.createdAt - b.createdAt)))
      if (!ACTIVE.has(r.status)) setLive((l) => ({ ...l, [r.id]: '' }))
    } else if (channel === 'run:event') {
      const ev = payload as RunEvent
      // Only this thread's runs: other chats' events would pile up in memory unseen.
      if (!ids.current.has(ev.runId)) return
      setEvents((m) => {
        const cur = m[ev.runId] ?? []
        return cur.some((x) => x.seq === ev.seq) ? m : { ...m, [ev.runId]: [...cur, ev] }
      })
      if (ev.type === 'text' || ev.type === 'tool_call') setLive((l) => ({ ...l, [ev.runId]: '' }))
    } else {
      const d = payload as LiveDelta
      if (!ids.current.has(d.runId)) return
      setLive((l) => ({ ...l, [d.runId]: (l[d.runId] ?? '') + d.text }))
    }
  })

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [events, live, runs.length])

  const activeRun = runs.find((r) => ACTIVE.has(r.status))

  const send = async (text: string) => {
    const k = key ?? `ui:${crypto.randomUUID()}`
    stick.current = true
    const sent = await act(() => call<{ run: Run | null; steered: boolean; notice?: string; conversationKey?: string; chatModel?: { provider: ProviderId; model?: string; effort?: string } }>('chat_send', { prompt: text, provider, model: model || undefined, effort: effort || undefined, cwd: cwd || undefined, conversationKey: k }))
    if (!sent) return false
    if (current.current !== key) return true
    const { run, chatModel, notice, conversationKey: opened } = sent
    // NEW and STOP answer without a run; NEW <text> and a switch in front of a message announce themselves too.
    if (notice) toast(notice)
    // NEW opens a new chat: bare, an empty one; with text, the chat its first run started in.
    if (!run) {
      if (opened) {
        started.current = { key: opened }
        navigate(`/chat/${encodeURIComponent(opened)}`)
      }
      return true
    }
    const target = opened ?? k
    ids.current.add(run.id)
    if (target !== key) started.current = { key: target, runId: run.id }
    // A typed switch (CLAUDE OPUS, CODEX SOL HIGH, DEFAULT) moves the pickers, so later messages carry it.
    if (chatModel) {
      setProvider(chatModel.provider)
      setModel(chatModel.model ?? '')
      setEffort(chatModel.effort ?? '')
    }
    if (target !== key) navigate(`/chat/${encodeURIComponent(target)}`)
    else setRuns((xs) => (xs.some((x) => x.id === run.id) ? xs : [...xs, run]))
    return true
  }

  const external = runs[0] && runs[0].trigger !== 'ui' && runs[0].trigger !== 'agent'

  return (
    <div className="flex h-full min-h-0">
      {sidebar && <Sidebar active={key} />}
      <section className="workspace-canvas flex min-w-0 flex-1 flex-col">
        {key && runs.length > 0 && (
          <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-bg px-5 text-[13px]">
            <span className="min-w-0 flex-1 truncate font-medium">{runs[0].title}</span>
            <span className="font-mono text-xs text-fg-3">{shortPath(runs[runs.length - 1].cwd)}</span>
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} title="Keep this thread but start a fresh agent session" onClick={() => act(() => call('conversation_reset', { key }), 'Next message starts a fresh session')}>
              Fresh session
            </Button>
          </div>
        )}
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {!key ? (
            <div className="mx-auto flex h-full max-w-2xl flex-col justify-center px-6 pb-10">
              <Mark className="size-8" />
              <h1 className="mt-5 font-serif text-[40px] font-semibold tracking-[-0.03em]">At your service.</h1>
              <div className="mt-6 grid grid-cols-2 gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => void send(s)} className="rounded-2xl border border-line bg-surface px-4 py-4 shadow-sm text-left text-[13px] text-fg-2 hover:border-line-2 hover:text-fg">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-3 px-6 py-6">
              {runs.map((r) => (
                <div key={r.id}>
                  <Transcript blocks={toBlocks(events[r.id] ?? []).filter((b) => !(b.kind === 'tool' && b.call.data.name === 'ToolSearch'))} live={live[r.id] ?? ''} active={ACTIVE.has(r.status)} />
                  {r.error && <div className="selectable mt-2 rounded-md border border-red/30 bg-red/8 px-3 py-2 text-[13px] text-red">{r.error}</div>}
                  {!ACTIVE.has(r.status) && (
                    <div className="mt-1 flex items-center gap-3 text-[11px] text-fg-3">
                      <Link to={`/runs/${r.id}`} className="hover:text-fg">
                        View run
                      </Link>
                      <span title={r.triggerRef ?? undefined}>{sourceLabel[r.trigger]}</span>
                      <span>{r.provider === 'claude' ? 'Claude Code' : 'Codex'}</span>
                      <span>{duration(r.startedAt, r.finishedAt)}</span>
                      {r.usage && <span>{tokens(r.usage.inputTokens + r.usage.outputTokens)} tokens</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0 px-6 pb-5">
          <div className="mx-auto max-w-3xl">
            {external && <div className="mb-2 text-center text-xs text-fg-3">This thread started in {runs[0].trigger}. Steering an active task also affects its reply there.</div>}
            <Composer
              running={!!activeRun}
              onSend={send}
              onStop={() => activeRun && act(() => call('runs_cancel', { id: activeRun.id }))}
              provider={provider}
              setProvider={setProvider}
              model={model}
              setModel={setModel}
              effort={effort}
              setEffort={setEffort}
              cwd={cwd}
              setCwd={setCwd}
              config={config}
              autoFocusKey={key ?? 'new'}
            />
          </div>
        </div>
      </section>
    </div>
  )
}
