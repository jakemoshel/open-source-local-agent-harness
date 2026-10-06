import { useState } from 'react'
import { ArrowDown, ArrowUp, Bot, History, Plus, RotateCcw, Trash2, User } from 'lucide-react'
import type { AuditEntry, SafeguardAction, SafeguardRule, Safeguards as SG } from '@shared/types'
import { call, useOp } from '@/lib/api'
import { ago } from '@/lib/format'
import { Badge, Button, Card, CardHeader, Field, Input, NumberInput, PageHeader, Segmented, Select } from '@/components/ui'
import { useAction } from '@/components/toast'
import { useAutoSave } from '@/lib/autosave'

const tone = (a: SafeguardAction) => (a === 'allow' ? 'green' : a === 'ask' ? 'purple' : 'red')

export function Safeguards() {
  const { data } = useOp<SG>('safeguards_get', {}, { refreshOn: ['config:changed'] })
  const { data: history } = useOp<AuditEntry[]>('audit_list', { kind: 'safeguards', limit: 30 }, { refreshOn: ['audit:new'] })
  const [draft, setDraft] = useAutoSave<SG>(data, (d) => call('safeguards_set', { safeguards: d }))
  const [newRule, setNewRule] = useState<SafeguardRule>({ id: '', tool: 'Bash', match: '', action: 'ask', note: '' })
  const act = useAction()
  if (!draft || !data) return null
  const move = (i: number, d: number) => {
    const rules = [...draft.rules]
    const [r] = rules.splice(i, 1)
    rules.splice(i + d, 0, r)
    setDraft({ ...draft, rules })
  }

  return (
    <>
      <PageHeader
        title="Safeguards"
        description="Checked before every tool call. First match wins."
      />
      <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-6">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Rules" description='tool is a glob on the tool name (Bash, Edit, Write, mcp__github__*). match is a glob or "re:<regex>" against the command, path or URL. Bash commands are also checked per chained segment.' />
            <div className="divide-y divide-line">
              {draft.rules.map((r, i) => (
                <div key={r.id + i} className="grid grid-cols-[130px_150px_minmax(0,1fr)_96px_auto] items-center gap-2 px-4 py-2">
                  <Input mono value={r.id} onChange={(e) => setDraft({ ...draft, rules: draft.rules.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)) })} />
                  <Input mono value={r.tool} onChange={(e) => setDraft({ ...draft, rules: draft.rules.map((x, j) => (j === i ? { ...x, tool: e.target.value } : x)) })} />
                  <Input mono value={r.match ?? ''} placeholder="(any input)" onChange={(e) => setDraft({ ...draft, rules: draft.rules.map((x, j) => (j === i ? { ...x, match: e.target.value || undefined } : x)) })} />
                  <Select value={r.action} onChange={(e) => setDraft({ ...draft, rules: draft.rules.map((x, j) => (j === i ? { ...x, action: e.target.value as SafeguardAction } : x)) })}>
                    <option value="allow">allow</option>
                    <option value="ask">ask</option>
                    <option value="deny">deny</option>
                  </Select>
                  <div className="flex">
                    <Button variant="ghost" size="sm" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp className="size-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" disabled={i === draft.rules.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown className="size-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                  {r.note && <div className="col-span-5 -mt-1 pl-1 text-xs text-fg-3">{r.note}</div>}
                </div>
              ))}
              <div className="grid grid-cols-[130px_150px_minmax(0,1fr)_96px_auto] items-center gap-2 bg-bg-2 px-4 py-2.5">
                <Input mono placeholder="rule-id" value={newRule.id} onChange={(e) => setNewRule({ ...newRule, id: e.target.value })} />
                <Input mono placeholder="Bash" value={newRule.tool} onChange={(e) => setNewRule({ ...newRule, tool: e.target.value })} />
                <Input mono placeholder="git push *" value={newRule.match} onChange={(e) => setNewRule({ ...newRule, match: e.target.value })} />
                <Select value={newRule.action} onChange={(e) => setNewRule({ ...newRule, action: e.target.value as SafeguardAction })}>
                  <option value="allow">allow</option>
                  <option value="ask">ask</option>
                  <option value="deny">deny</option>
                </Select>
                <Button
                  size="sm"
                  icon={<Plus className="size-3.5" />}
                  disabled={!newRule.id || !newRule.tool}
                  onClick={() => {
                    setDraft({ ...draft, rules: [...draft.rules, { ...newRule, match: newRule.match || undefined, note: newRule.note || undefined }] })
                    setNewRule({ id: '', tool: 'Bash', match: '', action: 'ask', note: '' })
                  }}
                >
                  Add
                </Button>
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-2 gap-6">
            <Card className="space-y-4 p-4">
              <Field label="When no rule matches">
                <Segmented
                  value={draft.defaultAction}
                  onChange={(v) => setDraft({ ...draft, defaultAction: v })}
                  options={[
                    { value: 'allow', label: 'Allow' },
                    { value: 'ask', label: 'Ask me' },
                    { value: 'deny', label: 'Deny' }
                  ]}
                />
              </Field>
              <Field label="Approval timeout" hint="Unanswered approvals are denied after this.">
                <div className="flex items-center gap-2">
                  <NumberInput min={1} className="w-24" value={draft.approvalTimeoutSec} onChange={(n) => setDraft({ ...draft, approvalTimeoutSec: n })} />
                  <span className="text-[13px] text-fg-2">seconds</span>
                </div>
              </Field>
            </Card>
            <Card className="space-y-4 p-4">
              <Field label="Codex sandbox" hint="Codex uses its sandbox instead of rules.">
                <Select value={draft.codex.sandboxMode} onChange={(e) => setDraft({ ...draft, codex: { ...draft.codex, sandboxMode: e.target.value as SG['codex']['sandboxMode'] } })} className="w-full">
                  <option value="danger-full-access">Full access (no sandbox)</option>
                  <option value="workspace-write">Write inside working directory</option>
                  <option value="read-only">Read-only</option>
                </Select>
              </Field>
              <Field label="Codex network">
                <Segmented
                  value={draft.codex.networkAccess ? 'on' : 'off'}
                  onChange={(v) => setDraft({ ...draft, codex: { ...draft.codex, networkAccess: v === 'on' } })}
                  options={[
                    { value: 'on', label: 'On' },
                    { value: 'off', label: 'Off' }
                  ]}
                />
              </Field>
            </Card>
          </div>
        </div>

        <Card className="h-fit">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <History className="size-4" /> History
              </span>
            }
          />
          <div className="max-h-[70vh] divide-y divide-line overflow-y-auto">
            {history?.length ? (
              history.map((h) => (
                <div key={h.id} className="flex items-start gap-2.5 px-4 py-2.5">
                  {h.actor === 'agent' ? <Bot className="mt-0.5 size-3.5 text-purple" /> : <User className="mt-0.5 size-3.5 text-fg-3" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px]">{h.summary}</div>
                    <div className="text-xs text-fg-3">
                      {h.actor} · {ago(h.ts)}
                    </div>
                  </div>
                  {h.before != null && (
                    <Button variant="ghost" size="sm" title="Restore the state before this change" onClick={() => confirm('Restore safeguards to before this change?') && act(() => call('safeguards_revert', { auditId: h.id }), 'Reverted')}>
                      <RotateCcw className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))
            ) : (
              <div className="px-4 py-6 text-[13px] text-fg-3">No changes yet.</div>
            )}
          </div>
          <div className="border-t border-line px-4 py-2.5 text-xs text-fg-3">
            Legend: <Badge tone={tone('allow')}>allow</Badge> <Badge tone={tone('ask')}>ask</Badge> <Badge tone={tone('deny')}>deny</Badge>
          </div>
        </Card>
      </div>
    </>
  )
}
