import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, FolderOpen, RefreshCw, RotateCcw } from 'lucide-react'
import type { AuthStatus, HarnessConfig } from '@shared/types'
import { call, ea, useOp } from '@/lib/api'
import { ClaudeMark, CodexMark } from '@/components/NewRun'
import { Badge, Button, Card, CardHeader, Field, Input, NumberInput, PageHeader, Segmented, Switch } from '@/components/ui'
import { useAction } from '@/components/toast'
import { SubscriptionLogin, type LoginTarget } from '@/components/SubscriptionLogin'
import { EffortSelect, ModelSelect } from '@/components/ModelPicker'
import { RsiSettings } from '@/components/RsiSettings'
import { cx } from '@/lib/cx'
import { useAutoSave } from '@/lib/autosave'

export function Settings() {
  const { data: config } = useOp<HarnessConfig>('config_get', {}, { refreshOn: ['config:changed'] })
  const { data: auth, setData: setAuth } = useOp<AuthStatus>('auth_status', { refresh: true }, {})
  const { data: info } = useOp<{ home: string; electron: string; node: string }>('app_info', {}, {})
  const [c, setC] = useAutoSave<HarnessConfig>(config, (d) => call('config_update', { patch: d }))
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [signIn, setSignIn] = useState<'claude' | 'codex' | null>(null)
  const selectedProfile = sessionStorage.getItem('jarvis-profile') || 'owner'
  const { data: profiles } = useOp<LoginTarget[]>('profiles_list')
  const loginTarget = profiles?.find((p) => p.id === selectedProfile) ?? null
  const act = useAction()
  if (!c || !config) return null
  const setP = <K extends 'claude' | 'codex'>(k: K, patch: Partial<HarnessConfig['providers'][K]>) => setC({ ...c, providers: { ...c.providers, [k]: { ...c.providers[k], ...patch } } })
  const install = async () => {
    setInstalling(true)
    try {
      const result = await act(() => call<{ installed: string[]; auth: AuthStatus }>('auth_install_missing'), 'CLIs installed. Sign in below.')
      if (result) setAuth(result.auth)
    } finally { setInstalling(false) }
  }
  const login = (provider: 'claude' | 'codex') => setSignIn(provider)

  return (
    <>
      <PageHeader
        title="Settings"
      />
      <div className="space-y-6">
        {selectedProfile === 'owner' && <Card>
          <CardHeader title="Scheduled task notifications" description="Every completion appears on this Mac. Send a status to your iMessage too, including failures and runs with nothing new to report." />
          <div className="space-y-3 p-4">
            <div className="flex items-center gap-3"><span>iMessage me after every scheduled task</span><Switch checked={c.notifications?.scheduleCompletions !== false} onChange={enabled => setC({ ...c, notifications: { ...c.notifications, scheduleCompletions: enabled } })} /></div>
            <Input value={c.notifications?.imessageTarget ?? ''} placeholder="Your owner-profile contact (default)" onChange={e => setC({ ...c, notifications: { scheduleCompletions: c.notifications?.scheduleCompletions !== false, imessageTarget: e.target.value } })} />
          </div>
        </Card>}
        <Card>
          <CardHeader
            title="Agents"
            description="Subscriptions only. API keys are never used."
            actions={<div className="flex items-center gap-2">
              {auth && (!auth.claude.installed || !auth.codex.installed) && <Button size="sm" variant="primary" loading={installing} onClick={install}>Install missing CLIs</Button>}
              <Button
                size="sm"
                loading={checking}
                icon={<RefreshCw className="size-3.5" />}
                onClick={async () => {
                  setChecking(true)
                  setAuth(await call<AuthStatus>('auth_status', { refresh: true }))
                  setChecking(false)
                }}
              >
                Recheck
              </Button>
            </div>}
          />
          {signIn && loginTarget && <div className="border-b border-line p-4">
            <SubscriptionLogin profile={loginTarget} provider={signIn} onClose={() => setSignIn(null)} onDone={(i) => { if (i.state === 'connected') void call<AuthStatus>('auth_status', { refresh: true }).then(setAuth) }} />
          </div>}
          <div className="divide-y divide-line">
            <div className="grid grid-cols-[220px_1fr] gap-6 p-4">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <ClaudeMark className="size-4" /> Claude Code
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs">
                  <span className={cx('size-1.5 rounded-full', auth?.claude.ok ? 'bg-green' : 'bg-red')} />
                  <span className="text-fg-2">{auth?.claude.detail ?? 'Checking…'}</span>
                </div>
                {auth?.claude.installed && !auth.claude.ok && <Button size="sm" className="mt-2" onClick={() => login('claude')}>Sign in with Claude</Button>}
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Model">
                  <ModelSelect provider="claude" value={c.providers.claude.model ?? ''} onChange={(v) => setP('claude', { model: v || undefined })} defaultLabel="CLI default" />
                </Field>
                <Field label="Thinking effort">
                  <EffortSelect provider="claude" model={c.providers.claude.model ?? ''} value={c.providers.claude.effort ?? ''} onChange={(v) => setP('claude', { effort: (v || undefined) as HarnessConfig['providers']['claude']['effort'] })} defaultLabel="Model default" />
                </Field>
                <Field label="Executable">
                  <Input mono value={c.providers.claude.executable ?? ''} onChange={(e) => setP('claude', { executable: e.target.value || undefined })} placeholder="auto (PATH)" />
                </Field>
                <label className="col-span-3 flex items-center gap-3 text-[13px]">
                  <Switch checked={c.providers.claude.loadProjectSettings} onChange={(v) => setP('claude', { loadProjectSettings: v })} />
                  Load project CLAUDE.md and settings
                </label>
              </div>
            </div>
            <div className="grid grid-cols-[220px_1fr] gap-6 p-4">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <CodexMark className="size-4" /> Codex
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs">
                  <span className={cx('size-1.5 rounded-full', auth?.codex.ok ? 'bg-green' : 'bg-red')} />
                  <span className="text-fg-2">{auth?.codex.detail ?? 'Checking…'}</span>
                </div>
                {auth?.codex.installed && !auth.codex.ok && <Button size="sm" className="mt-2" onClick={() => login('codex')}>Sign in with ChatGPT</Button>}
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Model">
                  <ModelSelect provider="codex" value={c.providers.codex.model ?? ''} onChange={(v) => setP('codex', { model: v || undefined })} defaultLabel="CLI default" />
                </Field>
                <Field label="Thinking effort">
                  <EffortSelect provider="codex" model={c.providers.codex.model ?? ''} value={c.providers.codex.reasoningEffort ?? ''} onChange={(v) => setP('codex', { reasoningEffort: (v || undefined) as HarnessConfig['providers']['codex']['reasoningEffort'] })} defaultLabel="Model default" />
                </Field>
                <Field label="Executable">
                  <Input mono value={c.providers.codex.executable ?? ''} onChange={(e) => setP('codex', { executable: e.target.value || undefined })} placeholder="auto (PATH)" />
                </Field>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Runs" />
          <div className="grid grid-cols-5 gap-4 p-4">
            <Field label="Agent">
              <Segmented
                value={c.defaultProvider}
                onChange={(v) => setC({ ...c, defaultProvider: v })}
                options={[
                  { value: 'claude', label: 'Claude Code' },
                  { value: 'codex', label: 'Codex' }
                ]}
              />
            </Field>
            <Field label="Timezone">
              <Input mono value={c.timezone} onChange={(e) => setC({ ...c, timezone: e.target.value })} />
            </Field>
            <Field label="Directory">
              <Input mono value={c.defaultCwd ?? ''} onChange={(e) => setC({ ...c, defaultCwd: e.target.value || undefined })} placeholder="~" />
            </Field>
            <Field label="Parallel runs" hint="~350 MB each">
              <NumberInput min={1} max={16} value={c.maxConcurrentRuns} onChange={(n) => setC({ ...c, maxConcurrentRuns: n })} />
            </Field>
            <Field label="Tool logs" hint="0 = forever">
              <div className="flex items-center gap-2">
                <NumberInput min={0} value={c.retentionDays} onChange={(n) => setC({ ...c, retentionDays: n })} />
                <span className="text-[13px] text-fg-2">days</span>
              </div>
            </Field>
          </div>
        </Card>

        {selectedProfile === 'owner' && <RsiSettings value={c.selfRepair} onChange={selfRepair => setC({ ...c, selfRepair })} />}

        <Card>
          <CardHeader
            title="Learning"
            description="Skill and harness lessons use the small RSI model. One-off tool failures qualify for review."
            actions={
              <Button size="sm" onClick={() => act(() => call('learning_curate_now'), 'Curation run started')}>
                Curate
              </Button>
            }
          />
          <div className="grid grid-cols-[1fr_1fr] gap-6 p-4">
            <div className="space-y-3">
              <label className="flex items-center gap-3 text-[13px]">
                <Switch checked={c.learning.reflect} onChange={(v) => setC({ ...c, learning: { ...c.learning, reflect: v } })} /> Reflect after tasks
              </label>
              <Field label="Minimum">
                <div className="flex items-center gap-2">
                  <NumberInput min={0} className="w-20" value={c.learning.minToolCalls} onChange={(n) => setC({ ...c, learning: { ...c.learning, minToolCalls: n } })} />
                  <span className="text-[13px] text-fg-2">tool calls</span>
                </div>
              </Field>
              <Field label="User tasks between reviews">
                <NumberInput min={5} max={100} value={c.learning.minTasksBetween} onChange={(n) => setC({ ...c, learning: { ...c.learning, minTasksBetween: n } })} />
              </Field>
              <Field label="Review cooldown (hours)">
                <NumberInput min={0} max={168} value={c.learning.cooldownHours} onChange={(n) => setC({ ...c, learning: { ...c.learning, cooldownHours: n } })} />
              </Field>

            </div>
            <div className="space-y-3">
              <label className="flex items-center gap-3 text-[13px]">
                <Switch checked={c.learning.curate} onChange={(v) => setC({ ...c, learning: { ...c.learning, curate: v } })} /> Curate weekly
              </label>
              <Field label="Schedule">
                <Input mono value={c.learning.curateCron} onChange={(e) => setC({ ...c, learning: { ...c.learning, curateCron: e.target.value } })} />
              </Field>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="App"
            actions={
              <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => confirm('Restart Jarvis? Active runs stop.') && act(() => call('harness_restart', { reason: 'from Settings' }))}>
                Restart
              </Button>
            }
          />
          <div className="space-y-3 p-4">
            <Segmented
              value={c.ui.theme}
              onChange={(v) => setC({ ...c, ui: { ...c.ui, theme: v } })}
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'system', label: 'System' }
              ]}
            />
            <label className="flex items-center gap-3 text-[13px]">
              <Switch checked={c.ui.keepAlive} onChange={(v) => setC({ ...c, ui: { ...c.ui, keepAlive: v } })} /> Start at login, restart on crash
            </label>
            <label className="flex items-center gap-3 text-[13px]">
              <Switch checked={c.ui.launchAtLogin} disabled={c.ui.keepAlive} onChange={(v) => setC({ ...c, ui: { ...c.ui, launchAtLogin: v } })} /> Login item (if the above is off)
            </label>
            <label className="flex items-center gap-3 text-[13px]">
              <Switch checked={c.ui.keepRunningInTray} onChange={(v) => setC({ ...c, ui: { ...c.ui, keepRunningInTray: v } })} /> Keep running when closed
            </label>
            <label className="flex items-center gap-3 text-[13px]">
              <Switch checked={c.update.auto} onChange={(v) => setC({ ...c, update: { ...c.update, auto: v } })} /> Auto-update
            </label>
          </div>
        </Card>


        <div className="grid grid-cols-2 gap-6">
          <Card className="p-4">
            <div className="text-sm font-semibold">Hermes</div>
            <div className="mt-1 mb-3 text-[13px] text-fg-3">Import memory, skills, jobs and history.</div>
            <Link to="/import">
              <Button icon={<ArrowRight className="size-3.5" />}>Import</Button>
            </Link>
          </Card>
          <Card className="p-4">
            <div className="text-sm font-semibold">Folder</div>
            <div className="mt-1 mb-3 font-mono text-[13px] text-fg-2">{info?.home}</div>
            <div className="flex items-center gap-2">
              <Button icon={<FolderOpen className="size-3.5" />} onClick={() => info && ea.open(info.home)}>
                Open
              </Button>
              <Badge>Electron {info?.electron}</Badge>
              <Badge>Node {info?.node}</Badge>
            </div>
          </Card>
        </div>
      </div>
    </>
  )
}
