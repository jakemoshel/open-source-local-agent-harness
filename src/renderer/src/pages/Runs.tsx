import { useState } from 'react'
import { Rocket, Search } from 'lucide-react'
import type { Run, RunStatus } from '@shared/types'
import { useOp } from '@/lib/api'
import { RunsTable } from '@/components/RunsTable'
import { Card, Empty, Input, PageHeader, Select, Spinner } from '@/components/ui'

export function Runs() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<RunStatus | ''>('')
  const [trigger, setTrigger] = useState('')
  const [limit, setLimit] = useState(100)
  const { data, loading } = useOp<Run[]>('runs_list', { q: q || undefined, status: status || undefined, trigger: trigger || undefined, limit }, { refreshOn: ['run:update'] })

  return (
    <>
      <PageHeader title="Runs" description="Every run, from everywhere." />
      <div className="mb-4 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search runs…" className="pl-8" />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value as RunStatus | '')}>
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="awaiting_approval">Needs approval</option>
          <option value="succeeded">Ready</option>
          <option value="failed">Error</option>
          <option value="cancelled">Canceled</option>
          <option value="queued">Queued</option>
        </Select>
        <Select value={trigger} onChange={(e) => setTrigger(e.target.value)}>
          <option value="">All sources</option>
          <option value="ui">App</option>
          <option value="schedule">Schedule</option>
          <option value="slack">Slack</option>
          <option value="imessage">iMessage</option>
          <option value="agent">Agent</option>
          <option value="imported">Hermes import</option>
        </Select>
      </div>
      <Card>
        {loading && !data ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : data?.length ? (
          <>
            <RunsTable runs={data} />
            {data.length >= limit && (
              <button onClick={() => setLimit(limit + 100)} className="w-full border-t border-line py-2.5 text-[13px] text-fg-2 hover:bg-bg-2">
                Load more
              </button>
            )}
          </>
        ) : (
          <Empty icon={<Rocket className="size-4" />} title="No runs match" description="Try different filters, or start a run with ⌘N." />
        )}
      </Card>
    </>
  )
}
