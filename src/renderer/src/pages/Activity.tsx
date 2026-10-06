import { useState } from 'react'
import { Bot, Cpu, User } from 'lucide-react'
import type { AuditEntry } from '@shared/types'
import { useOp } from '@/lib/api'
import { ago } from '@/lib/format'
import { Badge, Card, Empty, PageHeader, Select } from '@/components/ui'

export function Activity() {
  const [kind, setKind] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const { data } = useOp<AuditEntry[]>('audit_list', { kind: kind || undefined, limit: 300 }, { refreshOn: ['audit:new'] })
  return (
    <>
      <PageHeader
        title="Activity"
        description="Every change, by anyone."
        actions={
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Everything</option>
            {['safeguards', 'schedules', 'gateways', 'mcp', 'env', 'config', 'memory', 'soul', 'skills', 'migration'].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </Select>
        }
      />
      <Card>
        {data?.length ? (
          <div className="divide-y divide-line">
            {data.map((e) => (
              <div key={e.id}>
                <button onClick={() => setOpen(open === e.id ? null : e.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-bg-2">
                  {e.actor === 'agent' ? <Bot className="size-4 text-purple" /> : e.actor === 'system' ? <Cpu className="size-4 text-fg-3" /> : <User className="size-4 text-fg-3" />}
                  <Badge>{e.kind}</Badge>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{e.summary}</span>
                  <span className="text-xs text-fg-3">
                    {e.actor} · {ago(e.ts)}
                  </span>
                </button>
                {open === e.id && (e.before != null || e.after != null) && (
                  <div className="grid grid-cols-2 gap-3 bg-bg-2 px-4 py-3">
                    {(['before', 'after'] as const).map((k) => (
                      <div key={k}>
                        <div className="mb-1 text-[11px] font-medium text-fg-3 uppercase">{k}</div>
                        <pre className="selectable max-h-72 overflow-auto rounded border border-line bg-bg p-2 font-mono text-xs whitespace-pre-wrap">{JSON.stringify(e[k], null, 2)}</pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No activity yet" />
        )}
      </Card>
    </>
  )
}
