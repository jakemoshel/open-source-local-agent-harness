import { useNavigate } from 'react-router-dom'
import { Archive, Bot, Calendar, Gauge, Hash, MessageSquare, MonitorSmartphone } from 'lucide-react'
import type { Run, RunTrigger } from '@shared/types'
import { ago, duration, shortPath, tokens } from '@/lib/format'
import { ClaudeMark, CodexMark } from './NewRun'
import { Status } from './ui'

const triggerIcon: Record<RunTrigger, React.ReactNode> = {
  ui: <MonitorSmartphone className="size-3.5" />,
  schedule: <Calendar className="size-3.5" />,
  slack: <Hash className="size-3.5" />,
  imessage: <MessageSquare className="size-3.5" />,
  agent: <Bot className="size-3.5" />,
  imported: <Archive className="size-3.5" />,
  bench: <Gauge className="size-3.5" />
}

const triggerLabel: Record<RunTrigger, string> = { ui: 'App', schedule: 'Schedule', slack: 'Slack', imessage: 'iMessage', agent: 'Agent', imported: 'Hermes', bench: 'Benchmark' }

export function TriggerLabel({ trigger }: { trigger: RunTrigger }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-fg-2">
      {triggerIcon[trigger]}
      {triggerLabel[trigger]}
    </span>
  )
}

export function RunsTable({ runs, compact }: { runs: Run[]; compact?: boolean }) {
  const navigate = useNavigate()
  return (
    <div className="divide-y divide-line">
      {runs.map((r) => (
        <div
          key={r.id}
          onClick={() => navigate(`/runs/${r.id}`)}
          className="grid cursor-default grid-cols-[minmax(0,1fr)_130px_110px_90px] items-center gap-4 px-4 py-3 text-[13px] hover:bg-bg-2 data-[compact=true]:grid-cols-[minmax(0,1fr)_120px_90px]"
          data-compact={compact}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {r.trigger === 'imported' ? null : r.provider === 'claude' ? <ClaudeMark /> : <CodexMark />}
              <span className="truncate text-sm font-medium">{r.title}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-3 text-xs text-fg-3">
              <TriggerLabel trigger={r.trigger} />
              {!compact && <span className="truncate font-mono">{shortPath(r.cwd)}</span>}
              {!compact && r.model && <span className="font-mono">{r.model}</span>}
            </div>
          </div>
          <Status status={r.status} />
          {!compact && (
            <div className="text-fg-2">
              <div>{duration(r.startedAt, r.finishedAt)}</div>
              <div className="text-xs text-fg-3">{tokens(r.usage ? r.usage.inputTokens + r.usage.outputTokens : 0)} tok</div>
            </div>
          )}
          <div className="text-right text-fg-2">{ago(r.createdAt)}</div>
        </div>
      ))}
    </div>
  )
}
