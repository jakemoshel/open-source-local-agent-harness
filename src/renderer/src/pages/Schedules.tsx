import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarClock, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import type { HarnessConfig, Schedule } from '@shared/types'
import { call, useOp } from '@/lib/api'
import { ago, cronText, until } from '@/lib/format'
import { ProviderLabel } from '@/components/NewRun'
import { EffortSelect, ModelSelect, effortLabel } from '@/components/ModelPicker'
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Select, Switch, Textarea } from '@/components/ui'
import { useAction } from '@/components/toast'

type Row = Schedule & { next: number[]; lastFiredAt: number | null; cronError: string | null }

const PRESETS = [
  { label: 'Every weekday at 8:00', cron: '0 8 * * 1-5' },
  { label: 'Every day at 9:00', cron: '0 9 * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Mondays at 9:00', cron: '0 9 * * 1' }
]

function Editor({ value, onClose }: { value: Partial<Schedule> | null; onClose: () => void }) {
  const [s, setS] = useState<Partial<Schedule>>(value ?? {})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<Schedule>) => setS((x) => ({ ...x, ...patch }))
  const { data: config } = useOp<HarnessConfig>('config_get', {}, { refreshOn: ['config:changed'] })
  const agent = s.provider ?? config?.defaultProvider ?? 'claude'
  if (!value) return null
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      // null resets a field to the default; an omitted field would keep the saved value.
      await call('schedules_upsert', {
        ...s,
        provider: s.provider ?? null, model: s.model ?? null, effort: s.effort ?? null,
        timezone: s.timezone ?? null, cwd: s.cwd ?? null, deliver: s.deliver?.target ? s.deliver : null
      })
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={value.id ? 'Edit schedule' : 'New schedule'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!s.name || (!s.cron && !s.runAt) || (!s.prompt && !s.op)}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ErrorNote error={error} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <Input value={s.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder="Morning brief" />
          </Field>
          <Field label="Schedule (cron, local time)" hint={s.cron ? cronText(s.cron) : 'minute hour day month weekday'}>
            <div className="flex gap-2">
              <Input mono value={s.cron ?? ''} onChange={(e) => set({ cron: e.target.value })} placeholder="0 8 * * 1-5" />
              <Select value="" onChange={(e) => e.target.value && set({ cron: e.target.value })} className="w-28">
                <option value="">Presets</option>
                {PRESETS.map((p) => (
                  <option key={p.cron} value={p.cron}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
        </div>
        {s.op ? (
          <div className="rounded-md border border-line bg-bg-2 px-3 py-2.5 text-[13px] text-fg-2">
            Runs the harness operation <code className="font-mono text-fg">{s.op}</code> directly — no model call, no tokens.
          </div>
        ) : (
          <Field label="Prompt">
            <Textarea rows={6} value={s.prompt ?? ''} onChange={(e) => set({ prompt: e.target.value })} placeholder="What should the agent do each time?" />
          </Field>
        )}
        <Field label="Timezone" hint="Blank = default">
          <Input mono value={s.timezone ?? ''} onChange={(e) => set({ timezone: e.target.value || undefined })} placeholder="America/New_York" />
        </Field>
        {!s.op && (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Agent">
              <Select value={s.provider ?? ''} onChange={(e) => set({ provider: (e.target.value || undefined) as Schedule['provider'], model: undefined, effort: undefined })} className="w-full">
                <option value="">Default ({config?.defaultProvider === 'codex' ? 'Codex' : 'Claude Code'})</option>
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
              </Select>
            </Field>
            <Field label="Model">
              <ModelSelect provider={agent} value={s.model ?? ''} onChange={(v) => set({ model: v || undefined })} defaultLabel="Default (Settings)" />
            </Field>
            <Field label="Thinking">
              <EffortSelect provider={agent} model={s.model ?? ''} value={s.effort ?? ''} onChange={(v) => set({ effort: (v || undefined) as Schedule['effort'] })} defaultLabel="Default (Settings)" />
            </Field>
          </div>
        )}
        <Field label="Working directory">
          <Input mono value={s.cwd ?? ''} onChange={(e) => set({ cwd: e.target.value || undefined })} placeholder="~" />
        </Field>
        <div className="grid grid-cols-[140px_1fr] gap-3">
          <Field label="Deliver result to">
            <Select
              value={s.deliver?.gateway ?? ''}
              onChange={(e) => set({ deliver: e.target.value ? { gateway: e.target.value as 'slack' | 'imessage', target: s.deliver?.target ?? '' } : undefined })}
              className="w-full"
            >
              <option value="">Nowhere</option>
              <option value="slack">Slack</option>
              <option value="imessage">iMessage</option>
            </Select>
          </Field>
          <Field label="Target" hint={s.deliver?.gateway === 'slack' ? 'Channel ID, optionally CHANNEL:THREAD_TS' : s.deliver?.gateway === 'imessage' ? 'Phone, email or chat GUID' : undefined}>
            <Input mono disabled={!s.deliver} value={s.deliver?.target ?? ''} onChange={(e) => set({ deliver: { gateway: s.deliver!.gateway, target: e.target.value } })} />
          </Field>
        </div>
        <label className="flex items-center gap-3 text-[13px]">
          <Switch checked={!!s.persistentConversation} onChange={(v) => set({ persistentConversation: v })} />
          Keep one continuing conversation across runs (the agent remembers earlier runs of this schedule)
        </label>
      </div>
    </Modal>
  )
}

export function Schedules() {
  const { data } = useOp<Row[]>('schedules_list', {}, { refreshOn: ['config:changed', 'run:update'], throttleMs: 800 })
  const [editing, setEditing] = useState<Partial<Schedule> | null>(null)
  const act = useAction()

  return (
    <>
      <PageHeader
        title="Schedules"
        description="Recurring runs."
        actions={
          <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing({ enabled: true })}>
            New schedule
          </Button>
        }
      />
      <Card>
        {data?.length ? (
          <div className="divide-y divide-line">
            {data.map((s) => (
              <div key={s.id} className="grid grid-cols-[minmax(0,1fr)_200px_140px_auto] items-center gap-4 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    {s.source === 'hermes' && <Badge>from Hermes</Badge>}
                    {s.op && <Badge tone="green">no model</Badge>}
                    {s.deliver && <Badge tone="blue">→ {s.deliver.gateway}</Badge>}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-fg-3">{s.op ? `harness op ${s.op}` : s.prompt}</div>
                </div>
                <div className="text-[13px]">
                  <div>{cronText(s.cron)}</div>
                  <div className="font-mono text-xs text-fg-3">{s.cronError ? <span className="text-red">{s.cronError}</span> : `${s.cron}${s.timezone ? ` · ${s.timezone.split('/').pop()?.replace('_', ' ')}` : ''}`}</div>
                </div>
                <div className="text-[13px] text-fg-2">
                  <div>{s.enabled ? `Next ${until(s.next[0])}` : 'Paused'}</div>
                  <div className="text-xs text-fg-3">
                    {s.provider ? <ProviderLabel id={s.provider} /> : 'Default agent'}{s.model ? ` · ${s.model}` : ''}{s.effort ? ` · ${effortLabel(s.effort)}` : ''} · last {ago(s.lastFiredAt)}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Switch checked={s.enabled} onChange={(v) => act(() => call('schedules_upsert', { ...s, enabled: v }), v ? 'Schedule enabled' : 'Schedule paused')} />
                  <Button variant="ghost" size="sm" title="Run now" onClick={() => act(() => call('schedules_run_now', { id: s.id }), 'Started')}>
                    <Play className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" title="Edit" onClick={() => setEditing(s)}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" title="Delete" onClick={() => confirm(`Delete "${s.name}"?`) && act(() => call('schedules_delete', { id: s.id }), 'Deleted')}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            icon={<CalendarClock className="size-4" />}
            title="No schedules"
            description={
              <>
                Create one here, ask an agent to set one up, or <Link to="/import" className="text-accent">import your Hermes cron jobs</Link>.
              </>
            }
          />
        )}
      </Card>
      {editing && <Editor key={editing.id ?? "new"} value={editing} onClose={() => setEditing(null)} />}
    </>
  )
}
