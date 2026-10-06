import { useEffect, useState } from 'react'
import type { ModelOption, ProviderId } from '@shared/types'
import { useOp } from '@/lib/api'
import { cx } from '@/lib/cx'
import { Input, Select } from './ui'

const CUSTOM = '__custom__'
const EFFORT_LABELS: Record<string, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }
const ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export const effortLabel = (e: string) => EFFORT_LABELS[e] ?? e

/** The subscription's models for a provider, as the CLI reports them for the current profile. */
function useModels(provider: ProviderId): ModelOption[] {
  const { data } = useOp<{ models: ModelOption[]; live: boolean }>('models_list', { provider })
  return data?.models ?? []
}

/** Efforts the chosen model supports. With no model chosen, every effort some model offers. */
function effortsFor(models: ModelOption[], model: string): string[] {
  const found = models.find((m) => m.id === model)
  if (found) return found.efforts
  return ORDER.filter((e) => models.some((m) => m.efforts.includes(e)))
}

const compactClass = 'h-7 rounded-md bg-bg-2 px-1.5 text-xs text-fg outline-none'

/**
 * Model dropdown with a Default option ('' = use the next level up: Settings, then the CLI) and Custom… for any
 * model ID the list doesn't include yet.
 */
export function ModelSelect({ provider, value, onChange, defaultLabel, compact, className }: {
  provider: ProviderId; value: string; onChange: (v: string) => void; defaultLabel: string; compact?: boolean; className?: string
}) {
  const models = useModels(provider)
  const known = !value || models.some((m) => m.id === value)
  const [custom, setCustom] = useState(!known)
  // A saved custom ID stays visible once the list loads; switching provider resets it.
  useEffect(() => { setCustom(!!value && models.length > 0 && !models.some((m) => m.id === value)) }, [provider, models.length])
  const select = (
    <Select
      aria-label="Model"
      compact={compact}
      value={custom ? CUSTOM : value}
      onChange={(e) => {
        if (e.target.value === CUSTOM) { setCustom(true); return }
        setCustom(false)
        onChange(e.target.value)
      }}
      className={compact ? cx('max-w-40', className) : cx('w-full', className)}
    >
      <option value="">{defaultLabel}</option>
      {/* Lines follow each new release (Sonnet 5.5 → 6 on release day); versions stay pinned. */}
      {[{ label: 'Always the newest', list: models.filter((m) => m.tracksLatest) }, { label: 'Pinned versions', list: models.filter((m) => !m.tracksLatest) }].filter((g) => g.list.length).map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.list.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.label}{m.latest ? ` (now ${m.latest})` : ''}{m.recommended ? ' · recommended' : ''}</option>)}
        </optgroup>
      ))}
      {!known && !custom && <option value={value}>{value}</option>}
      <option value={CUSTOM}>Custom…</option>
    </Select>
  )
  if (!custom) return select
  return (
    <div className={cx('flex gap-1.5', compact ? 'items-center' : '')}>
      {select}
      {compact
        ? <input autoFocus value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder="model id" className={cx(compactClass, 'w-28 font-mono')} />
        : <Input mono autoFocus value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder="model id" />}
    </div>
  )
}

/** Effort dropdown limited to what the chosen model supports; clears a choice the new model can't use. */
export function EffortSelect({ provider, model, value, onChange, defaultLabel, compact, className }: {
  provider: ProviderId; model: string; value: string; onChange: (v: string) => void; defaultLabel: string; compact?: boolean; className?: string
}) {
  const models = useModels(provider)
  const efforts = effortsFor(models, model)
  useEffect(() => { if (value && models.length && !efforts.includes(value)) onChange('') }, [model, models.length])
  const unsupported = models.length > 0 && efforts.length === 0
  const options = <>
    <option value="">{unsupported ? 'Not adjustable' : defaultLabel}</option>
    {efforts.map((e) => <option key={e} value={e}>{effortLabel(e)}</option>)}
    {value && !efforts.includes(value) && <option value={value}>{effortLabel(value)}</option>}
  </>
  return <Select aria-label="Thinking effort" title="Thinking effort" compact={compact} value={value} disabled={unsupported} onChange={(e) => onChange(e.target.value)} className={cx(compact ? undefined : 'w-full', className)}>{options}</Select>
}
