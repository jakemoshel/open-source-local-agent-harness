import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Hash, MessageSquare, RefreshCw, X } from 'lucide-react'
import type { EnvEntry, GatewayStatus, HarnessConfig } from '@shared/types'
import { call, useOp } from '@/lib/api'
import { ago } from '@/lib/format'
import { cx } from '@/lib/cx'
import { Button, Card, Field, Input, NumberInput, PageHeader, Segmented, Select, Switch } from '@/components/ui'
import { useAction } from '@/components/toast'
import { useAutoSave } from '@/lib/autosave'

type Row = GatewayStatus & { config: HarnessConfig['gateways']['slack'] & HarnessConfig['gateways']['imessage'] }

function Chips({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const parts = draft.split(/[,\s]+/).filter(Boolean)
    if (parts.length) onChange(Array.from(new Set([...values, ...parts])))
    setDraft('')
  }
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-md border border-line-2 bg-bg px-1.5 py-1">
      {values.map((v) => (
        <span key={v} className="inline-flex h-6 items-center gap-1 rounded bg-bg-3 pr-1 pl-2 font-mono text-xs">
          {v}
          <button onClick={() => onChange(values.filter((x) => x !== v))} className="rounded p-0.5 text-fg-3 hover:text-fg">
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ',') && (e.preventDefault(), add())}
        onBlur={add}
        placeholder={values.length ? '' : placeholder}
        className="h-6 min-w-32 flex-1 bg-transparent px-1 font-mono text-xs outline-none placeholder:font-sans placeholder:text-fg-3"
      />
    </div>
  )
}

function GatewayCard({ g, envKeys }: { g: Row; envKeys: Set<string> }) {
  const act = useAction()
  const [c, setC] = useAutoSave(g.config, (d) => call('gateways_configure', { name: g.name, patch: d }))
  const isSlack = g.name === 'slack'
  if (!c) return null
  const missing = isSlack ? ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'].filter((k) => !envKeys.has(k)) : []

  return (
    <Card>
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <div className="flex size-8 items-center justify-center rounded-md border border-line">{isSlack ? <Hash className="size-4" /> : <MessageSquare className="size-4" />}</div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{isSlack ? 'Slack' : 'iMessage'}</div>
          <div className="flex items-center gap-1.5 text-xs text-fg-2">
            <span className={cx('size-1.5 rounded-full', g.state === 'running' ? 'bg-green' : g.state === 'error' ? 'bg-red' : g.state === 'starting' ? 'bg-amber' : 'bg-fg-3')} />
            <span className="truncate">{g.enabled ? g.detail || g.state : 'Disabled'}</span>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => act(() => call('gateways_restart', { name: g.name }), 'Restarted')} title="Restart">
          <RefreshCw className="size-3.5" />
        </Button>
        <Switch checked={c.enabled} onChange={(v) => setC({ ...c, enabled: v })} />
      </div>
      <div className="space-y-4 p-4">
        {isSlack ? (
          <>
            <div className="text-[13px] text-fg-2">DM or mention. One thread, one conversation.</div>
            {missing.length > 0 && (
              <div className="rounded-md border border-amber/30 bg-amber/10 px-3 py-2 text-[13px]">
                Missing {missing.join(' and ')} — add {missing.length > 1 ? 'them' : 'it'} in{' '}
                <Link to="/env" className="text-accent">
                  Environment
                </Link>
                .
              </div>
            )}
            <Field label="Allowed Slack user IDs" hint="Everyone else is ignored.">
              <Chips values={c.allowedUsers ?? []} onChange={(v) => setC({ ...c, allowedUsers: v })} placeholder="U012ABCDEF" />
            </Field>
            <label className="flex items-center gap-3 text-[13px]">
              <Switch checked={c.replyInThread} onChange={(v) => setC({ ...c, replyInThread: v })} /> Reply in threads for channel mentions
            </label>
          </>
        ) : (
          <>
            <Field label="Backend">
              <Segmented
                value={c.backend}
                onChange={(v) => setC({ ...c, backend: v })}
                options={[
                  { value: 'bluebubbles', label: 'BlueBubbles' },
                  { value: 'messages', label: 'Messages.app' }
                ]}
              />
            </Field>
            {c.backend === 'bluebubbles' ? (
              <>
                <div className="text-[13px] text-fg-2">
                  Registers a webhook with your BlueBubbles server (like Hermes did) and replies through its API. Uses <code className="font-mono">BLUEBUBBLES_SERVER_URL</code> and{' '}
                  <code className="font-mono">BLUEBUBBLES_PASSWORD</code> from Environment.
                </div>
                {!envKeys.has('BLUEBUBBLES_PASSWORD') && (
                  <div className="rounded-md border border-amber/30 bg-amber/10 px-3 py-2 text-[13px]">
                    Missing BLUEBUBBLES_PASSWORD — add it in{' '}
                    <Link to="/env" className="text-accent">
                      Environment
                    </Link>{' '}
                    or import your Hermes .env.
                  </div>
                )}
                <Field label="Webhook port" hint="Webhook port">
                  <NumberInput min={1} max={65535} value={c.webhookPort} onChange={(port) => setC({ ...c, webhookPort: port })} className="w-32" />
                </Field>
              </>
            ) : (
              <div className="text-[13px] text-fg-2">
                Reads new messages from Messages on this Mac and replies through Messages.app. Needs <b>Full Disk Access</b> for Mac Mini Jarvis and permission to control Messages.
              </div>
            )}
            <Field label="Allowed senders" hint="Numbers or Apple IDs.">
              <Chips values={c.allowedHandles ?? []} onChange={(v) => setC({ ...c, allowedHandles: v })} placeholder="+15551234567" />
            </Field>
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Agent">
            <Select value={c.provider ?? ''} onChange={(e) => setC({ ...c, provider: (e.target.value || undefined) as Row['config']['provider'] })} className="w-full">
              <option value="">Default</option>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </Select>
          </Field>
          <Field label="Working directory">
            <Input mono value={c.cwd ?? ''} onChange={(e) => setC({ ...c, cwd: e.target.value || undefined })} placeholder="~" />
          </Field>
        </div>
        <div className="flex items-center justify-between border-t border-line pt-3">
          <span className="text-xs text-fg-3">Last message {ago(g.lastMessageAt)}</span>
        </div>
      </div>
    </Card>
  )
}

/** Who may message Jarvis. Saved by the owner here, never by an agent. */
function OwnerCard() {
  const { data, reload } = useOp<{ phone: string | null; slack: string | null }>('owner_get')
  const [phone, setPhone] = useState<string | null>(null)
  const [slack, setSlack] = useState<string | null>(null)
  const act = useAction()
  if (!data) return null
  const save = async () => {
    if (await act(() => call('owner_set', { phone: phone ?? data.phone ?? '', slack: slack ?? data.slack ?? '' }), 'Saved')) { setPhone(null); setSlack(null); await reload() }
  }
  return (
    <Card className="mb-6 px-4 py-3">
      <div className="mb-1 text-[13px] font-medium">Owner</div>
      <div className="mb-3 text-[13px] text-fg-2">Only these identities can message Jarvis. Leave one empty to block that gateway.</div>
      <div className="flex items-end gap-3">
        <Field label="iMessage number" className="flex-1"><Input mono value={phone ?? data.phone ?? ''} onChange={(e) => setPhone(e.target.value)} placeholder="+15551234567" /></Field>
        <Field label="Slack member ID" className="flex-1"><Input mono value={slack ?? data.slack ?? ''} onChange={(e) => setSlack(e.target.value)} placeholder="U0123ABCD" /></Field>
        <Button variant="primary" disabled={phone === null && slack === null} onClick={() => void save()}>Save</Button>
      </div>
    </Card>
  )
}

export function Gateways() {
  const { data } = useOp<Row[]>('gateways_status', {}, { refreshOn: ['gateway:update', 'config:changed'] })
  const { data: env } = useOp<EnvEntry[]>('env_list', {}, { refreshOn: ['config:changed'] })
  const { data: config } = useOp<HarnessConfig>('config_get', {}, { refreshOn: ['config:changed'] })
  const act = useAction()
  const keys = new Set((env ?? []).map((e) => e.key))
  return (
    <>
      <PageHeader title="Gateways" description="iMessage and Slack." />
      <OwnerCard />
      <Card className="mb-6 grid grid-cols-[1fr_auto] items-center gap-6 px-4 py-3">
        <div className="text-[13px] text-fg-2">
          <div className="mb-1 font-medium text-fg">Commands (iMessage, Slack and Chat)</div>
          <code className="font-mono">NEW</code> starts a fresh session · <code className="font-mono">NEW &lt;text&gt;</code> starts one with that message · <code className="font-mono">STOP</code> stops the running turn ·{' '}
          <code className="font-mono">/new</code> and <code className="font-mono">/reset</code> start fresh. After inactivity the next message starts a fresh session with a recap of the last one (0 turns this off).
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-fg-2">Auto-reset after</span>
          <input
            type="number"
            min={0}
            className="h-8 w-20 rounded-md border border-line-2 bg-bg px-2.5 text-sm"
            defaultValue={config?.gateways.idleResetMinutes ?? 120}
            key={config?.gateways.idleResetMinutes}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            onBlur={(e) => {
              const input = e.currentTarget
              const saved = config?.gateways.idleResetMinutes ?? 120
              const minutes = input.value.trim() === '' ? NaN : Math.round(Number(input.value))
              // A cleared or invalid field must not silently save 0, which turns auto-reset off.
              if (!Number.isFinite(minutes) || minutes < 0) {
                input.value = String(saved)
                return
              }
              input.value = String(minutes)
              if (minutes !== saved) void act(() => call('config_update', { patch: { gateways: { idleResetMinutes: minutes } } }), minutes ? 'Saved' : 'Auto-reset turned off')
            }}
          />
          <span className="text-[13px] text-fg-2">min</span>
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-6">
        {(data ?? []).map((g) => (
          <GatewayCard key={g.name} g={g} envKeys={keys} />
        ))}
      </div>
    </>
  )
}
