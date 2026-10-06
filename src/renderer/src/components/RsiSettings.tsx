import type { RsiModel, RsiSettings as Settings } from '@shared/rsi'
import { SMALL_MODEL, LARGE_MODEL } from '@shared/rsi-defaults'
import { Card, CardHeader, Field, Input, Segmented, Switch } from './ui'
import { EffortSelect, ModelSelect } from './ModelPicker'
import { useOp } from '@/lib/api'

type Metric = { commit: string; kind: string; samples: number; durationMs: number | null; succeeded: number; toolErrors: number; corrections: number }
export function RsiSettings({ value, onChange }: { value: Settings; onChange: (settings: Settings) => void }) {
  const set = (patch: Partial<Settings>) => onChange({ ...value, ...patch })
  const { data: metrics } = useOp<Metric[]>('rsi_statistics', { days: 14 }, { refreshOn: ['run:finished', 'update:status'] })
  const modelRow = (size: 'small' | 'large', label: string, description: string) => {
    const model = value[size]
    const update = (patch: Partial<RsiModel>) => set({ [size]: { ...model, ...patch } })
    return <div className="space-y-3">
      <div><div className="text-sm font-medium">{label}</div><p className="mt-1 text-xs text-fg-3">{description}</p></div>
      <Field label="Agent"><Segmented value={model.provider} onChange={provider => update({ ...(provider === 'claude' ? SMALL_MODEL : LARGE_MODEL), provider })} options={[{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }]} /></Field>
      <Field label="Model"><ModelSelect provider={model.provider} value={model.model} onChange={m => update({ model: m || (model.provider === 'claude' ? SMALL_MODEL.model : LARGE_MODEL.model) })} defaultLabel="RSI default" /></Field>
      <Field label="Thinking effort"><EffortSelect provider={model.provider} model={model.model} value={model.effort} onChange={e => update({ effort: (e || 'medium') as RsiModel['effort'] })} defaultLabel="Medium" /></Field>
    </div>
  }
  const number = (key: 'smallMaxFiles' | 'smallMaxMinutes' | 'sliceMinutes' | 'retryMinutes' | 'maxPerDay' | 'maxAttempts' | 'intervalHours', label: string, min: number, hint?: string) => <Field label={label} hint={hint}><Input type="number" min={min} value={value[key]} onChange={e => { const n = Number(e.target.value); if (e.target.value && Number.isFinite(n) && n >= min) set({ [key]: n }) }} /></Field>
  return <Card>
    <CardHeader title="RSI customization" description="The triggering review estimates scope before queuing work. Small gains, one-off fixes, and skill and harness reviews use the small model; broader work uses the large model." />
    <div className="space-y-5 p-4">
      <label className="flex items-center gap-3 text-[13px]"><Switch checked={value.enabled} onChange={enabled => set({ enabled })} /> Autonomous self-improvement</label>
      <div className="grid grid-cols-2 gap-6">{modelRow('small', 'Small tasks and reviews', 'Local fixes and routine improvements with a known approach.')}{modelRow('large', 'Large tasks', 'Features, migrations, cross-component work, and complex investigations.')}</div>
      <div className="grid grid-cols-2 gap-4">{number('smallMaxFiles', 'Small task: maximum files', 1)}{number('smallMaxMinutes', 'Small task: estimated minutes', 1)}</div>
      <p className="text-xs text-fg-3">The review records files, components, estimated minutes, priority, and its reason. Work exceeding either threshold or spanning multiple components uses the large model.</p>
      <label className="flex items-center gap-3 text-[13px]"><Switch checked={value.escalate} onChange={escalate => set({ escalate })} /> Escalate small jobs when scope grows or an implementation fails</label>
      <div className="grid grid-cols-4 gap-4">{number('sliceMinutes', 'Minutes per process', 1, 'Progress resumes in a fresh process')}{number('retryMinutes', 'Retry delay (minutes)', 1)}{number('maxPerDay', 'Job slices per day', 0, '0 = unlimited')}{number('maxAttempts', 'Failed attempts per job', 0, '0 = unlimited')}</div>
      <div className="flex items-center gap-4"><label className="flex items-center gap-3 text-[13px]"><Switch checked={value.proactive} onChange={proactive => set({ proactive })} /> Discover improvements proactively</label>{number('intervalHours', 'Review interval (hours)', 0.1)}</div>
      <Field label="RSI instructions"><textarea className="min-h-24 w-full rounded-md border border-line bg-bg-2 p-3 text-sm" value={value.instructions} onChange={e => set({ instructions: e.target.value })} placeholder="Priorities, preferred approaches, or areas to improve…" /></Field>
      {!!metrics?.length && <div className="overflow-x-auto"><div className="mb-2 text-sm font-medium">Measured outcomes · past 14 days</div><table className="w-full text-left text-xs"><thead className="text-fg-3"><tr>{['Installed commit', 'Activity', 'Completed', 'Avg seconds', 'Tool errors', 'Corrections'].map(h => <th key={h} className="py-2 pr-3">{h}</th>)}</tr></thead><tbody>{metrics.map(m => <tr key={`${m.commit}:${m.kind}`} className="border-t border-line"><td className="py-2 font-mono">{m.commit.slice(0, 8)}</td><td>{m.kind}</td><td>{m.succeeded}/{m.samples}</td><td>{m.durationMs === null ? '—' : (m.durationMs / 1000).toFixed(1)}</td><td>{m.toolErrors}</td><td>{m.corrections}</td></tr>)}</tbody></table></div>}
    </div>
  </Card>
}
