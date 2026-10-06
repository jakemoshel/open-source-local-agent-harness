import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Download, FolderOpen, Plus, Search, Trash2 } from 'lucide-react'
import type { HarnessConfig } from '@shared/types'
import { call, ea, useOp } from '@/lib/api'
import { ago, shortPath } from '@/lib/format'
import { Badge, Button, Card, CardHeader, Input, Meter, Modal, PageHeader, Switch, Textarea } from '@/components/ui'
import { useAction } from '@/components/toast'

type MemoryData = { soulPath: string; soul: string; files: { name: string; path: string; content: string; limit: number | null }[] }
type Hit = { runId: string; title: string; role: string; ts: number; snippet: string }
type Meeting = { source: 'granola'; id: string; title: string; date: string; day: string; attendees: string[]; transcriptStatus: 'available' | 'unavailable'; path: string }
type MeetingDetail = Meeting & { summary: string; transcript: string }

function MeetingsArchive() {
  const { data: status, reload: reloadStatus } = useOp<{ path: string; count: number; syncEnabled: boolean }>('meetings_status', {}, { refreshOn: ['audit:new'] })
  const { data: meetings, reload: reloadMeetings } = useOp<Meeting[]>('meetings_list', { limit: 200 }, { refreshOn: ['audit:new'] })
  useEffect(() => {
    const refresh = () => { if (!document.hidden) { void reloadMeetings(); void reloadStatus() } }
    const timer = window.setInterval(refresh, 10_000)
    window.addEventListener('focus', refresh)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [reloadMeetings, reloadStatus])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<MeetingDetail | null>(null)
  const act = useAction()
  const navigate = useNavigate()
  const shown = meetings?.filter((m) => `${m.title} ${m.day} ${m.attendees.join(' ')}`.toLowerCase().includes(query.toLowerCase())) ?? []
  const sync = async () => {
    const started = await act(() => call<{ runId: string }>('meetings_sync_now'))
    if (started) navigate(`/runs/${started.runId}`)
  }
  return (
    <Card>
      <CardHeader
        title="Meetings"
        description={status ? `${status.count} archived · ${shortPath(status.path)}${status.syncEnabled ? ' · syncs nightly' : ''}` : 'Separate meeting archive inside memory'}
        actions={<div className="flex gap-2">
          <Button size="sm" onClick={sync}><Download className="size-3.5" /> Sync Granola</Button>
          {status && <Button size="sm" variant="ghost" onClick={() => ea.open(status.path)}><FolderOpen className="size-3.5" /> Open folder</Button>}
        </div>}
      />
      <div className="border-t border-line p-4">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter meetings by title, date or attendee…" />
      </div>
      <div className="max-h-80 divide-y divide-line overflow-y-auto border-t border-line">
        {shown.length ? shown.map((m) => (
          <button key={m.id} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-bg-2" onClick={() => act(async () => setSelected(await call<MeetingDetail>('meetings_read', { id: m.id })))}>
            <span className="w-24 shrink-0 font-mono text-xs text-fg-3">{m.day}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{m.title}</span>
            <Badge tone={m.transcriptStatus === 'available' ? 'green' : undefined}>{m.transcriptStatus === 'available' ? 'transcript' : 'notes only'}</Badge>
          </button>
        )) : <div className="px-4 py-5 text-[13px] text-fg-3">{meetings?.length ? 'No matching meetings.' : 'Sync Granola to add meetings here.'}</div>}
      </div>
      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected?.title ?? ''} wide>
        {selected && <div className="space-y-4">
          <div className="text-xs text-fg-3">{selected.date} · {selected.attendees.join(', ') || 'No attendees listed'}</div>
          <div><div className="mb-1 text-sm font-medium">Summary</div><pre className="selectable max-h-[35vh] overflow-auto whitespace-pre-wrap rounded-md bg-bg-2 p-3 text-xs">{selected.summary}</pre></div>
          <div><div className="mb-1 text-sm font-medium">Transcript</div><pre className="selectable max-h-[35vh] overflow-auto whitespace-pre-wrap rounded-md bg-bg-2 p-3 text-xs">{selected.transcript}</pre></div>
        </div>}
      </Modal>
    </Card>
  )
}

function Editor({ title, description, value, limit, onSave, rows = 10 }: { title: string; description?: string; value: string; limit?: number | null; onSave: (v: string) => Promise<unknown>; rows?: number }) {
  const [v, setV] = useState(value)
  const base = useRef(value)
  // A background refresh replaces the text only while it has no unsaved edits.
  useEffect(() => {
    setV((current) => (current === base.current ? value : current))
    base.current = value
  }, [value])
  const act = useAction()
  const over = !!limit && v.length > limit
  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        actions={
          <Button size="sm" variant="primary" disabled={v === value || over} onClick={() => act(() => onSave(v), 'Saved')}>
            Save
          </Button>
        }
      />
      <Textarea mono rows={rows} value={v} onChange={(e) => setV(e.target.value)} className="rounded-none border-0 px-4 focus:border-0" />
      {limit ? (
        <div className="flex items-center gap-3 border-t border-line px-4 py-2">
          <Meter value={v.length} max={limit} />
          <span className={over ? 'text-xs whitespace-nowrap text-red' : 'text-xs whitespace-nowrap text-fg-3'}>
            {v.length.toLocaleString()} / {limit.toLocaleString()}
          </span>
        </div>
      ) : null}
    </Card>
  )
}

function Roots({ config }: { config: HarnessConfig }) {
  const act = useAction()
  const [draft, setDraft] = useState('')
  const [startup, setStartup] = useState(config.memory.startupInstructions)
  const startupBase = useRef(config.memory.startupInstructions)
  useEffect(() => {
    setStartup((current) => (current === startupBase.current ? config.memory.startupInstructions : current))
    startupBase.current = config.memory.startupInstructions
  }, [config.memory.startupInstructions])
  const save = (patch: Partial<HarnessConfig['memory']>) => act(() => call('config_update', { patch: { memory: patch } }), 'Saved')
  return (
    <Card>
      <CardHeader title="Durable context" description="Git-tracked. Compact excerpts from the first root load at startup; full records are searched on demand." />
      <div className="divide-y divide-line">
        {config.memory.contextRoots.map((r) => (
          <div key={r} className="flex items-center gap-3 px-4 py-2.5">
            <span className="flex-1 truncate font-mono text-[13px]">{shortPath(r)}</span>
            <Button size="sm" variant="ghost" onClick={() => ea.open(r)}>
              <FolderOpen className="size-3.5" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => save({ contextRoots: config.memory.contextRoots.filter((x) => x !== r) })}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        <div className="flex gap-2 px-4 py-2.5">
          <Input mono value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="~/Documents/Context" />
          <Button
            icon={<Plus className="size-3.5" />}
            disabled={!draft}
            onClick={() => {
              void save({ contextRoots: [...config.memory.contextRoots, draft] })
              setDraft('')
            }}
          >
            Add
          </Button>
        </div>
      </div>
      <div className="border-t border-line p-4">
        <div className="mb-1.5 text-[13px] font-medium text-fg-2">Startup instructions</div>
        <Textarea rows={5} value={startup} onChange={(e) => setStartup(e.target.value)} placeholder="Once per session, read PROFILE.md, NOW.md, TASKS.md and index.md…" />
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="primary" disabled={startup === config.memory.startupInstructions} onClick={() => save({ startupInstructions: startup })}>
            Save
          </Button>
        </div>
      </div>
    </Card>
  )
}

type Snapshot = { roots: string[]; inject: { file: string; path: string; chars: number; approxTokens: number }[]; startupChars: number; approxStartupTokens: number; note: string }
type Hit2 = { id: string; type: string | null; path: string; aliases: string[]; score: number; snippet: string }
type Rec = { id: string; path: string; content: string; links: { id: string; path: string | null }[]; backlinks: { id: string; path: string }[] }

function SnapshotCard({ config }: { config: HarnessConfig }) {
  const { data } = useOp<Snapshot>('memory_snapshot', {}, { refreshOn: ['config:changed'] })
  const act = useAction()
  const total = data?.inject.reduce((a, f) => a + f.approxTokens, 0) ?? 0
  return (
    <Card>
      <CardHeader
        title="Session start snapshot"
        description={data ? `Jarvis startup ≈ ${data.approxStartupTokens.toLocaleString()} tokens, including identity and instructions. Provider tools and chat history are additional.` : 'Compact files injected at session start.'}
      />
      <div className="divide-y divide-line text-[13px]">
        {data?.inject.length ? (
          data.inject.map((f) => (
            <div key={f.file} className="flex items-center gap-3 px-4 py-2">
              <span className="flex-1 font-mono">{f.file}</span>
              <span className="text-xs text-fg-3">~{f.approxTokens.toLocaleString()} tokens</span>
            </div>
          ))
        ) : (
          <div className="px-4 py-3 text-fg-3">No context root yet.</div>
        )}
        <div className="flex items-center justify-between px-4 py-2 text-xs text-fg-2">
          <span>Memory excerpts ≈ {total.toLocaleString()} tokens</span>
          <span className="flex items-center gap-2">
            Compaction recap
            <Switch checked={config.memory.recap.enabled} onChange={(v) => act(() => call('config_update', { patch: { memory: { recap: { enabled: v } } } }))} />
          </span>
        </div>
        <p className="px-4 py-2.5 text-xs text-fg-2">Linked memory is maintained by nightly ingestion; conversations retrieve sourced records.</p>
      </div>
    </Card>
  )
}

function ContextLookup() {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit2[] | null>(null)
  const [rec, setRec] = useState<Rec | null>(null)
  const act = useAction()
  useEffect(() => {
    if (!q.trim()) return setHits(null)
    // Only the latest query may show its hits; a slow earlier search must not replace them.
    let current = true
    const t = setTimeout(() => void call<Hit2[]>('context_search', { query: q, limit: 15 }).then((h) => current && setHits(h), () => current && setHits([])), 200)
    return () => { current = false; clearTimeout(t) }
  }, [q])
  const open = (ref: string) => act(async () => setRec(await call<Rec>('context_read', { ref })))
  return (
    <Card>
      <CardHeader title="Context lookup" description="Same search Jarvis uses." />
      <div className="p-4">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="people, projects, preferences…" className="pl-8" />
        </div>
      </div>
      {hits && (
        <div className="max-h-[360px] divide-y divide-line overflow-y-auto border-t border-line">
          {hits.length ? (
            hits.map((h) => (
              <button key={h.path} onClick={() => open(h.path)} className="block w-full px-4 py-2.5 text-left hover:bg-bg-2">
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="font-mono font-medium">{h.id}</span>
                  {h.type && <Badge>{h.type}</Badge>}
                </div>
                <div className="mt-0.5 line-clamp-2 text-xs text-fg-2">{h.snippet}</div>
              </button>
            ))
          ) : (
            <div className="px-4 py-6 text-center text-[13px] text-fg-3">No records</div>
          )}
        </div>
      )}
      <Modal open={!!rec} onClose={() => setRec(null)} title={rec?.id ?? ''} wide>
        {rec && (
          <div className="space-y-3">
            <div className="font-mono text-xs text-fg-3">{shortPath(rec.path)}</div>
            <pre className="selectable max-h-[50vh] overflow-auto rounded-md border border-line bg-bg-2 p-3 font-mono text-xs whitespace-pre-wrap">{rec.content}</pre>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {rec.links.map((l) => (
                <button key={l.id} disabled={!l.path} onClick={() => l.path && open(l.path)} className="rounded bg-bg-3 px-2 py-0.5 font-mono disabled:opacity-40">
                  → {l.id}
                </button>
              ))}
              {rec.backlinks.map((l) => (
                <button key={l.path} onClick={() => open(l.path)} className="rounded bg-accent/10 px-2 py-0.5 font-mono text-accent">
                  ← {l.id}
                </button>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </Card>
  )
}

function SessionSearch() {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  useEffect(() => {
    if (!q.trim()) return setHits(null)
    let current = true
    const t = setTimeout(() => void call<Hit[]>('session_search', { query: q, limit: 30 }).then((h) => current && setHits(h), () => current && setHits([])), 200)
    return () => { current = false; clearTimeout(t) }
  }, [q])
  return (
    <Card>
      <CardHeader title="Session search" description="Every transcript." />
      <div className="p-4">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search past conversations…" className="pl-8" />
        </div>
      </div>
      {hits && (
        <div className="max-h-[420px] divide-y divide-line overflow-y-auto border-t border-line">
          {hits.length ? (
            hits.map((h, i) => (
              <Link key={i} to={`/runs/${h.runId}`} className="block px-4 py-2.5 hover:bg-bg-2">
                <div className="flex items-center justify-between gap-3 text-[13px]">
                  <span className="truncate font-medium">{h.title}</span>
                  <span className="shrink-0 text-xs text-fg-3">
                    {h.role} · {ago(h.ts)}
                  </span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-xs text-fg-2">{h.snippet}</div>
              </Link>
            ))
          ) : (
            <div className="px-4 py-6 text-center text-[13px] text-fg-3">No matches</div>
          )}
        </div>
      )}
    </Card>
  )
}

export function Memory() {
  const { data, reload } = useOp<MemoryData>('memory_list', {}, { refreshOn: ['audit:new'] })
  const { data: config } = useOp<HarnessConfig>('config_get', {}, { refreshOn: ['config:changed'] })
  return (
    <>
      <PageHeader title="Memory" description="What Jarvis knows, and where it looks." />
      <div className="mb-6"><MeetingsArchive /></div>
      <div className="grid grid-cols-2 gap-6">
        <div className="space-y-6">
          {data && (
            <Editor
              title="SOUL.md"
              description={`Identity and standing instructions · ${shortPath(data.soulPath)}`}
              value={data.soul}
              rows={12}
              onSave={async (v) => {
                await call('soul_set', { content: v })
                await reload()
              }}
            />
          )}
          {data?.files.map((f) => (
            <Editor
              key={f.name}
              title={f.name}
              description={f.name === 'USER.md' ? 'Who you are and how you like to work' : f.name === 'MEMORY.md' ? 'Stable operational notes' : undefined}
              value={f.content}
              limit={f.limit}
              rows={8}
              onSave={async (v) => {
                await call('memory_write', { file: f.name, content: v })
                await reload()
              }}
            />
          ))}
        </div>
        <div className="space-y-6">
          {config && <SnapshotCard config={config} />}
          {config && <Roots config={config} />}
          <ContextLookup />
          <SessionSearch />
        </div>
      </div>
    </>
  )
}
