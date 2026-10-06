import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CircleAlert, CircleCheck, FolderSearch, Info } from 'lucide-react'
import type { MigrationItem, MigrationPlan } from '@shared/types'
import { call } from '@/lib/api'
import { shortPath } from '@/lib/format'
import { cx } from '@/lib/cx'
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Input, PageHeader, Spinner } from '@/components/ui'

type Found = { path: string; realPath: string; markers: string[] }
type Result = { applied: string[]; errors: { id: string; error: string }[]; backupDir: string }

const kindLabel: Record<MigrationItem['kind'], string> = {
  soul: 'Identity',
  memory: 'Memory',
  skill: 'Skills',
  env: 'Environment',
  mcp: 'MCP servers',
  gateway: 'Gateways',
  schedule: 'Schedules',
  sessions: 'History',
  config: 'Config'
}

export function Import() {
  const [found, setFound] = useState<Found[] | null>(null)
  const [home, setHome] = useState('')
  const [plan, setPlan] = useState<MigrationPlan | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [cutover, setCutover] = useState<{ stopped: string[]; enabledGateways: string[]; enabledSchedules: string[]; notes: string[] } | null>(null)

  useEffect(() => {
    void call<Found[]>('hermes_detect').then((f) => {
      setFound(f)
      if (f[0]) setHome(f[0].realPath)
    })
  }, [])

  const buildPlan = async () => {
    setError(null)
    setBusy(true)
    try {
      const p = await call<MigrationPlan>('hermes_plan', { home })
      setPlan(p)
      setSelected(new Set(p.items.filter((i) => i.selected).map((i) => i.id)))
      setResult(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    if (!plan) return
    setBusy(true)
    setError(null)
    try {
      setResult(await call<Result>('hermes_apply', { home: plan.hermesHome, itemIds: [...selected] }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const groups = plan ? Object.entries(Object.groupBy(plan.items, (i) => i.kind)) : []

  return (
    <>
      <PageHeader title="Import from Hermes" description="Read-only on Hermes. Backed up first." />
      <Card className="mb-6">
        <CardHeader title="1 · Hermes home" description={found?.length ? `Found ${found.length} installation${found.length > 1 ? 's' : ''} on this Mac.` : found ? 'No Hermes install detected automatically — enter the path.' : 'Looking…'} />
        <div className="space-y-3 p-4">
          {found?.map((f) => (
            <button
              key={f.realPath}
              onClick={() => setHome(f.realPath)}
              className={cx('flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left', home === f.realPath ? 'border-fg' : 'border-line hover:border-line-2')}
            >
              <FolderSearch className="size-4 text-fg-3" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px]">{shortPath(f.realPath)}</div>
                <div className="text-xs text-fg-3">{f.markers.join(' · ')}</div>
              </div>
            </button>
          ))}
          <div className="flex gap-2">
            <Input mono value={home} onChange={(e) => setHome(e.target.value)} placeholder="~/.hermes" />
            <Button variant="primary" loading={busy && !plan} disabled={!home} onClick={buildPlan}>
              Preview import
            </Button>
          </div>
          <ErrorNote error={error} />
        </div>
      </Card>

      {plan && !result && (
        <Card>
          <CardHeader
            title="2 · Choose what to bring over"
            description={`${selected.size} of ${plan.items.filter((i) => i.action !== 'skip').length} items selected. Gateways and schedules arrive disabled so Hermes and this app never answer the same message twice.`}
            actions={
              <Button variant="primary" loading={busy} disabled={!selected.size} onClick={apply}>
                Import {selected.size} item{selected.size === 1 ? '' : 's'}
              </Button>
            }
          />
          {plan.warnings.length > 0 && (
            <div className="space-y-1.5 border-b border-line bg-bg-2 px-4 py-3">
              {plan.warnings.map((w) => (
                <div key={w} className="flex gap-2 text-[13px] text-fg-2">
                  <Info className="mt-0.5 size-3.5 shrink-0 text-accent" />
                  {w}
                </div>
              ))}
            </div>
          )}
          {plan.items.length ? (
            groups.map(([kind, items]) => (
              <div key={kind} className="border-b border-line last:border-0">
                <div className="flex items-center justify-between bg-bg-2 px-4 py-1.5 text-xs font-medium text-fg-3">
                  {kindLabel[kind as MigrationItem['kind']]}
                  <button
                    className="hover:text-fg"
                    onClick={() => {
                      const ids = items!.filter((i) => i.action !== 'skip').map((i) => i.id)
                      const all = ids.every((id) => selected.has(id))
                      setSelected((s) => {
                        const n = new Set(s)
                        ids.forEach((id) => (all ? n.delete(id) : n.add(id)))
                        return n
                      })
                    }}
                  >
                    Toggle all
                  </button>
                </div>
                {items!.map((i) => (
                  <label key={i.id} className={cx('flex items-start gap-3 px-4 py-2.5', i.action === 'skip' && 'opacity-50')}>
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-[var(--fg)]"
                      disabled={i.action === 'skip'}
                      checked={selected.has(i.id)}
                      onChange={(e) =>
                        setSelected((s) => {
                          const n = new Set(s)
                          e.target.checked ? n.add(i.id) : n.delete(i.id)
                          return n
                        })
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[13px] font-medium">
                        {i.label}
                        {i.conflict && <Badge tone="amber">overwrites</Badge>}
                        {i.action === 'skip' && <Badge>skipped</Badge>}
                      </div>
                      {i.note && <div className="text-xs text-fg-3">{i.note}</div>}
                    </div>
                  </label>
                ))}
              </div>
            ))
          ) : (
            <Empty title="Nothing to import" description="This folder doesn't contain anything recognizable." />
          )}
        </Card>
      )}

      {busy && plan && (
        <div className="mt-4 flex items-center gap-2 text-[13px] text-fg-2">
          <Spinner className="size-3.5" /> Importing…
        </div>
      )}

      {result && (
        <Card>
          <CardHeader title="3 · Done" description={`Backup of the previous harness state: ${shortPath(result.backupDir)}`} />
          <div className="space-y-2 p-4 text-[13px]">
            <div className="flex items-center gap-2">
              <CircleCheck className="size-4 text-green" /> Imported {result.applied.length} item{result.applied.length === 1 ? '' : 's'}
            </div>
            {result.errors.map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-red">
                <CircleAlert className="size-4" /> {e.id}: {e.error}
              </div>
            ))}
            <div className="pt-3 text-fg-2">
              When you're ready to switch, cut over: this stops and disables the Hermes gateway LaunchAgent, then turns on iMessage/Slack and your schedules here. BlueBubbles keeps running. Re-running the import later only adds new sessions.
            </div>
            {cutover ? (
              <div className="mt-2 space-y-1 rounded-md border border-line bg-bg-2 p-3">
                <div>Stopped: {cutover.stopped.join(', ') || 'nothing'}</div>
                <div>Enabled gateways: {cutover.enabledGateways.join(', ') || 'none'}</div>
                <div>Enabled schedules: {cutover.enabledSchedules.join(', ') || 'none'}</div>
                {cutover.notes.map((n) => (
                  <div key={n} className="text-amber">
                    {n}
                  </div>
                ))}
                <Link to="/gateways" className="text-accent">
                  Check gateways →
                </Link>
              </div>
            ) : (
              <Button variant="primary" className="mt-2" loading={busy} onClick={async () => {
                if (!confirm('Stop Hermes and switch iMessage, Slack and schedules to Mac Mini Jarvis?')) return
                setBusy(true)
                try {
                  setCutover(await call('hermes_cutover'))
                } catch (err) {
                  setError((err as Error).message)
                } finally {
                  setBusy(false)
                }
              }}>
                Cut over from Hermes
              </Button>
            )}
          </div>
        </Card>
      )}
    </>
  )
}
