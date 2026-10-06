import { Activity, Download, Power, Wrench, RefreshCw, RotateCcw, ShieldCheck, ShieldX, Square, Play } from 'lucide-react'
import type { DoctorCheck, DoctorReport, PermissionStatus, ServiceInfo, UpdateStatus } from '@shared/types'
import { useState } from 'react'
import { call, useBus, useOp } from '@/lib/api'
import { Badge, Button, Card, CardHeader, Spinner } from './ui'
import { ago } from '@/lib/format'
import { useAction } from './toast'
import { cx } from '@/lib/cx'

export function PermissionsCard() {
  const { data, reload } = useOp<PermissionStatus>('permissions_status', {}, {})
  const act = useAction()
  const open = (pane: string) => act(() => call('open_settings_pane', { pane }))
  return (
    <Card>
      <CardHeader
        title="Permissions"
        description="Agents inherit what you grant Jarvis."
        actions={
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => void reload()}>
            Recheck
          </Button>
        }
      />
      <div className="divide-y divide-line text-[13px]">
        <div className="flex items-center gap-3 px-4 py-3">
          {data?.fullDiskAccess ? <ShieldCheck className="size-4 text-green" /> : <ShieldX className="size-4 text-red" />}
          <div className="flex-1">
            <div className="font-medium">Full Disk Access</div>
            <div className="text-xs text-fg-3">Messages, Mail, protected files.</div>
          </div>
          <Button size="sm" onClick={() => open('fullDiskAccess')}>
            Open
          </Button>
        </div>
        <div className="flex items-center gap-3 px-4 py-3">
          <ShieldCheck className="size-4 text-fg-3" />
          <div className="flex-1">
            <div className="font-medium">Automation</div>
            <div className="text-xs text-fg-3">Controlling other apps.</div>
          </div>
          <Button size="sm" onClick={() => open('automation')}>
            Open
          </Button>
        </div>
        <div className="flex items-center gap-3 px-4 py-3">
          {data?.accessibility ? <ShieldCheck className="size-4 text-green" /> : <ShieldX className="size-4 text-amber" />}
          <div className="flex-1">
            <div className="font-medium">Accessibility</div>
            <div className="text-xs text-fg-3">Clicking and typing in other apps.</div>
          </div>
          <Button size="sm" onClick={() => open('accessibility')}>
            Open
          </Button>
        </div>
        <div className="flex items-center gap-3 px-4 py-3">
          {data?.screenRecording ? <ShieldCheck className="size-4 text-green" /> : <ShieldX className="size-4 text-amber" />}
          <div className="flex-1">
            <div className="font-medium">Screen Recording</div>
            <div className="text-xs text-fg-3">Screenshots, so agents can see the screen.</div>
          </div>
          <Button size="sm" onClick={() => open('screenRecording')}>
            Open
          </Button>
        </div>
        <div className="flex items-center gap-3 px-4 py-3">
          <ShieldCheck className={cx('size-4', data?.loginShellEnv ? 'text-green' : 'text-amber')} />
          <div className="flex-1">
            <div className="font-medium">Shell environment</div>
            <div className="text-xs text-fg-3">{data ? `${data.loginShellEnv} variables from your shell` : '…'}</div>
          </div>
        </div>
      </div>
    </Card>
  )
}

const kindLabel: Record<ServiceInfo['kind'], string> = { hermes: 'Hermes', bluebubbles: 'BlueBubbles', jarvis: 'Jarvis', other: 'Other' }

export function ServicesCard() {
  const { data, reload } = useOp<ServiceInfo[]>('services_list', {}, {})
  const act = useAction()
  const run = (op: string, label: string, msg: string) => act(() => call(op, { label }), msg).then(() => reload())
  return (
    <Card>
      <CardHeader
        title="Services"
        description="LaunchAgents Jarvis manages."
        actions={
          <>
            <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => act(() => call('app_restart', { name: 'BlueBubbles' }), 'Restarting BlueBubbles')}>
              Restart BlueBubbles
            </Button>
            <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => void reload()}>
              Refresh
            </Button>
          </>
        }
      />
      <div className="divide-y divide-line">
        {data?.length ? (
          data.map((s) => (
            <div key={s.label} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className={cx('size-2 shrink-0 rounded-full', s.pid ? 'bg-green' : s.loaded ? 'bg-amber' : 'bg-fg-3')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono">{s.label}</span>
                  <Badge>{kindLabel[s.kind]}</Badge>
                  {s.disabled && <Badge tone="red">disabled</Badge>}
                </div>
                <div className="truncate font-mono text-xs text-fg-3">
                  {s.pid ? `pid ${s.pid}` : s.loaded ? `loaded · last exit ${s.lastExit ?? '—'}` : 'not loaded'} · {s.program}
                </div>
              </div>
              <Button size="sm" variant="ghost" title="Restart" onClick={() => run('services_restart', s.label, 'Restarted')}>
                <RotateCcw className="size-3.5" />
              </Button>
              {s.loaded ? (
                <Button size="sm" variant="ghost" title="Stop" onClick={() => run('services_stop', s.label, 'Stopped')}>
                  <Square className="size-3.5" />
                </Button>
              ) : (
                <Button size="sm" variant="ghost" title="Start" onClick={() => run('services_start', s.label, 'Started')}>
                  <Play className="size-3.5" />
                </Button>
              )}
              <Button size="sm" variant="ghost" title={s.disabled ? 'Enable at login' : 'Disable at login'} onClick={() => run(s.disabled ? 'services_enable' : 'services_disable', s.label, s.disabled ? 'Enabled' : 'Disabled')}>
                <Power className="size-3.5" />
              </Button>
            </div>
          ))
        ) : (
          <div className="px-4 py-5 text-[13px] text-fg-3">None found.</div>
        )}
      </div>
    </Card>
  )
}

const updateTone: Record<UpdateStatus['state'], 'gray' | 'blue' | 'green' | 'amber' | 'red'> = {
  idle: 'green',
  checking: 'gray',
  available: 'blue',
  building: 'amber',
  installing: 'amber',
  error: 'red',
  unsupported: 'gray'
}

export function UpdatesCard() {
  const { data: u, setData } = useOp<UpdateStatus>('update_status', {}, {})
  const act = useAction()
  useBus(['update:status'], (_c, p) => setData(p as UpdateStatus))
  if (!u) return null
  const working = u.state === 'checking' || u.state === 'building' || u.state === 'installing'
  const label = u.state === 'idle' ? 'Up to date' : u.state === 'unsupported' ? 'Dev build' : u.state[0].toUpperCase() + u.state.slice(1)
  return (
    <Card>
      <CardHeader
        title="Updates"
        description={
          <>
            {u.auto ? 'Installs when idle.' : 'Manual.'} <span className="font-mono">{u.sourceDir}</span>
          </>
        }
        actions={
          <>
            <Button size="sm" disabled={working} icon={<RefreshCw className="size-3.5" />} onClick={() => act(() => call('update_check'))}>
              Check
            </Button>
            {u.state === 'available' && (
              <Button size="sm" variant="primary" icon={<Download className="size-3.5" />} onClick={() => act(() => call('update_apply', {}), 'Updating')}>
                Install
              </Button>
            )}
          </>
        }
      />
      <div className="space-y-2 px-4 py-3 text-[13px]">
        <div className="flex items-center gap-2">
          {working ? <Spinner className="size-3.5" /> : <Badge tone={updateTone[u.state]}>{label}</Badge>}
          <span className="font-mono text-xs text-fg-3">{u.currentCommit.slice(0, 7)}</span>
          {u.lastCheck && <span className="text-xs text-fg-3">· checked {ago(u.lastCheck)}</span>}
        </div>
        {u.jobId && <div className="text-xs text-fg-3">Job {u.jobId.slice(0, 8)} · {u.phase}</div>}
        {u.message && <div className={cx('whitespace-pre-wrap text-xs', u.state === 'error' ? 'text-red' : 'text-fg-3')}>{u.message}</div>}
        {u.behind.length > 0 && (
          <ul className="space-y-0.5">
            {u.behind.slice(0, 8).map((c) => (
              <li key={c.sha} className="truncate text-xs text-fg-2">
                <span className="font-mono text-fg-3">{c.sha.slice(0, 7)}</span> {c.subject}
              </li>
            ))}
          </ul>
        )}
        {!u.signed && u.state !== 'unsupported' && (
          <div className="text-xs text-fg-3">Updates are signed with Jarvis’s local certificate, so folder and Full Disk Access grants carry over. Set update.signingIdentity to use your own.</div>
        )}
      </div>
    </Card>
  )
}

const dot: Record<DoctorCheck['status'], string> = { ok: 'bg-green', warn: 'bg-amber', fail: 'bg-red' }

export function DoctorCard() {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [busy, setBusy] = useState<'check' | 'fix' | null>(null)
  const act = useAction()
  const go = (fix: boolean) => {
    setBusy(fix ? 'fix' : 'check')
    return act(() => call<DoctorReport>('doctor', { fix }).then(setReport)).finally(() => setBusy(null))
  }
  const problems = report?.checks.filter((c) => c.status !== 'ok') ?? []
  const passing = report?.checks.filter((c) => c.status === 'ok') ?? []
  return (
    <Card>
      <CardHeader
        title="Diagnostics"
        description="Power-on to iMessage reply. Also: npm run doctor"
        actions={
          <>
            <Button size="sm" loading={busy === 'check'} disabled={!!busy} icon={<Activity className="size-3.5" />} onClick={() => void go(false)}>
              Run
            </Button>
            <Button size="sm" loading={busy === 'fix'} disabled={!!busy} icon={<Wrench className="size-3.5" />} onClick={() => void go(true)}>
              Repair
            </Button>
          </>
        }
      />
      {report && (
        <div className="text-[13px]">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <span className={cx('size-2 rounded-full', problems.some((c) => c.status === 'fail') ? 'bg-red' : problems.length ? 'bg-amber' : 'bg-green')} />
            <span className="font-medium">{report.summary}</span>
            <span className="text-xs text-fg-3">· {ago(report.at)}</span>
          </div>
          <div className="divide-y divide-line">
            {problems.map((c) => (
              <div key={c.id} className="flex gap-3 px-4 py-2.5">
                <span className={cx('mt-1.5 size-1.5 shrink-0 rounded-full', dot[c.status])} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{c.title}</div>
                  {c.detail && <div className="whitespace-pre-wrap text-xs text-fg-3">{c.detail}</div>}
                  {c.fix && <div className="mt-1 font-mono text-xs text-fg-2">→ {c.fix}</div>}
                </div>
              </div>
            ))}
          </div>
          {passing.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 text-xs text-fg-3">
              {passing.map((c) => (
                <span key={c.id} className="flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-green" />
                  {c.title}
                </span>
              ))}
            </div>
          )}
          {report.fixed.length > 0 && <div className="border-t border-line px-4 py-2.5 text-xs text-fg-3">Repaired: {report.fixed.join(' · ')}</div>}
        </div>
      )}
    </Card>
  )
}
