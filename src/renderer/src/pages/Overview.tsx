import { Link } from 'react-router-dom'
import { ArrowUpRight, Calendar, Rocket } from 'lucide-react'
import type { AuthStatus, GatewayStatus, Run, Schedule } from '@shared/types'
import { useOp } from '@/lib/api'
import { cronText, until } from '@/lib/format'
import { RunsTable } from '@/components/RunsTable'
import { ClaudeMark, CodexMark } from '@/components/NewRun'
import { Card, CardHeader, Empty, PageHeader } from '@/components/ui'
import { cx } from '@/lib/cx'

type Stats = { total: number; byStatus: Record<string, number>; byDay: { day: string; count: number; tokens: number }[] }

function Bars({ data }: { data: { day: string; count: number }[] }) {
  const days: { day: string; count: number }[] = []
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    days.push({ day: key, count: data.find((x) => x.day === key)?.count ?? 0 })
  }
  const max = Math.max(1, ...days.map((d) => d.count))
  return (
    <div className="flex h-16 items-end gap-1">
      {days.map((d) => (
        <div key={d.day} title={`${d.day}: ${d.count} runs`} className="flex-1 rounded-sm bg-fg/80 hover:bg-fg" style={{ height: `${Math.max(3, (d.count / max) * 100)}%`, opacity: d.count ? 1 : 0.15 }} />
      ))}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="text-[13px] text-fg-2">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-fg-3">{sub}</div>}
    </Card>
  )
}

export function Overview() {
  const { data: runs } = useOp<Run[]>('runs_list', { limit: 8 }, { refreshOn: ['run:update'] })
  const { data: stats } = useOp<Stats>('runs_stats', { days: 14 }, { refreshOn: ['run:update'], throttleMs: 1500 })
  const { data: auth } = useOp<AuthStatus>('auth_status', {}, {})
  const { data: schedules } = useOp<(Schedule & { next: number[] })[]>('schedules_list', {}, { refreshOn: ['config:changed'] })
  const { data: gateways } = useOp<GatewayStatus[]>('gateways_status', {}, { refreshOn: ['gateway:update', 'config:changed'] })

  const done = (stats?.byStatus.succeeded ?? 0) + (stats?.byStatus.failed ?? 0)
  const rate = done ? Math.round(((stats?.byStatus.succeeded ?? 0) / done) * 100) : null
  const tok = stats?.byDay.reduce((a, d) => a + d.tokens, 0) ?? 0
  const upcoming = (schedules ?? [])
    .filter((s) => s.enabled && s.next[0])
    .sort((a, b) => a.next[0] - b.next[0])
    .slice(0, 4)

  return (
    <>
      <PageHeader title="Overview" description="Your local agent harness on this Mac." />
      <div className="mb-6 grid grid-cols-4 gap-4">
        <Stat label="Runs · 14 days" value={stats?.total ?? '—'} sub={`${stats?.byStatus.running ?? 0} running now`} />
        <Stat label="Success rate" value={rate === null ? '—' : `${rate}%`} sub={`${stats?.byStatus.failed ?? 0} errors`} />
        <Stat label="Tokens · 14 days" value={tok ? `${(tok / 1000).toFixed(0)}k` : '—'} sub="Billed to your subscriptions" />
        <Card className="px-4 py-3.5">
          <div className="mb-2 text-[13px] text-fg-2">Activity</div>
          <Bars data={stats?.byDay ?? []} />
        </Card>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-6">
        <Card>
          <CardHeader
            title="Recent runs"
            actions={
              <Link to="/runs" className="flex items-center gap-1 text-[13px] text-fg-2 hover:text-fg">
                View all <ArrowUpRight className="size-3.5" />
              </Link>
            }
          />
          {runs?.length ? <RunsTable runs={runs} compact /> : <Empty icon={<Rocket className="size-4" />} title="No runs yet" description="Start one with New Run or ⌘N." />}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Agents" />
            <div className="divide-y divide-line">
              {(['claude', 'codex'] as const).map((p) => (
                <div key={p} className="flex items-center gap-3 px-4 py-3">
                  {p === 'claude' ? <ClaudeMark className="size-4" /> : <CodexMark className="size-4" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{p === 'claude' ? 'Claude Code' : 'Codex'}</div>
                    <div className="truncate text-xs text-fg-3">{auth?.[p].detail ?? 'Checking…'}</div>
                  </div>
                  <span className={cx('size-2 rounded-full', auth ? (auth[p].ok ? 'bg-green' : 'bg-red') : 'bg-fg-3')} />
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Gateways"
              actions={
                <Link to="/gateways" className="text-[13px] text-fg-2 hover:text-fg">
                  Manage
                </Link>
              }
            />
            <div className="divide-y divide-line">
              {(gateways ?? []).map((g) => (
                <div key={g.name} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1">
                    <div className="text-sm font-medium">{g.name === 'slack' ? 'Slack' : 'iMessage'}</div>
                    <div className="truncate text-xs text-fg-3">{g.enabled ? g.detail || g.state : 'Disabled'}</div>
                  </div>
                  <span className={cx('size-2 rounded-full', g.state === 'running' ? 'bg-green' : g.state === 'error' ? 'bg-red' : g.state === 'starting' ? 'bg-amber' : 'bg-fg-3')} />
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Upcoming"
              actions={
                <Link to="/schedules" className="text-[13px] text-fg-2 hover:text-fg">
                  Schedules
                </Link>
              }
            />
            {upcoming.length ? (
              <div className="divide-y divide-line">
                {upcoming.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                    <Calendar className="size-4 text-fg-3" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{s.name}</div>
                      <div className="text-xs text-fg-3">{cronText(s.cron)}</div>
                    </div>
                    <div className="text-xs text-fg-2">{until(s.next[0])}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-4 py-5 text-[13px] text-fg-3">No active schedules.</div>
            )}
          </Card>
        </div>
      </div>
    </>
  )
}
