import { useEffect, useRef, useState } from 'react'
import claudeIcon from '@lobehub/icons-static-svg/icons/claudecode-color.svg'
import codexIcon from '@lobehub/icons-static-svg/icons/codex-color.svg'
import { useNavigate } from 'react-router-dom'
import type { HarnessConfig, ProviderId, Run } from '@shared/types'
import { call, useOp } from '@/lib/api'
import { cx } from '@/lib/cx'
import { Button, Field, Input, Kbd, Modal, Segmented, Textarea } from './ui'
import { useAction } from './toast'
import { EffortSelect, ModelSelect } from './ModelPicker'

export function ProviderLabel({ id }: { id: ProviderId }) {
  return <span className="inline-flex items-center gap-1.5">{id === 'claude' ? <ClaudeMark /> : <CodexMark />}{id === 'claude' ? 'Claude Code' : 'Codex'}</span>
}

export function ClaudeMark({ className = 'size-3.5' }: { className?: string }) {
  return <img src={claudeIcon} alt="" draggable={false} className={cx('inline-block shrink-0', className)} />
}

export function CodexMark({ className = 'size-3.5' }: { className?: string }) {
  return <img src={codexIcon} alt="" draggable={false} className={cx('inline-block shrink-0', className)} />
}

export function NewRunModal({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: { cwd?: string; provider?: ProviderId } }) {
  const { data: config } = useOp<HarnessConfig>('config_get', {}, { refreshOn: ['config:changed'] })
  const [prompt, setPrompt] = useState('')
  const [provider, setProvider] = useState<ProviderId>('claude')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [cwd, setCwd] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const navigate = useNavigate()
  const act = useAction()

  // Defaults apply when the modal opens (or once settings first load), not on every settings refresh while it is open.
  const loaded = !!config
  useEffect(() => {
    if (!open) return
    setProvider(preset?.provider ?? config?.defaultProvider ?? 'claude')
    setCwd(preset?.cwd ?? '')
    const t = setTimeout(() => ref.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [open, loaded, preset])

  const submit = async () => {
    if (!prompt.trim()) return
    setBusy(true)
    const run = await act(() =>
      call<Run>('runs_start', { prompt, provider, model: model || undefined, effort: effort || undefined, cwd: cwd || undefined, conversationKey: `ui:${crypto.randomUUID()}` })
    )
    setBusy(false)
    if (run) {
      setPrompt('')
      onClose()
      navigate(`/runs/${run.id}`)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New run"
      wide
      footer={
        <>
          <span className="mr-auto flex items-center gap-1 text-xs text-fg-3">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd> to start
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={submit} disabled={!prompt.trim()}>
            Start run
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Textarea
          ref={ref}
          rows={6}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.metaKey && void submit()}
          placeholder="What should the agent do?"
          className="text-[15px]"
        />
        <div className="grid grid-cols-[auto_1fr_1fr] items-end gap-3">
          <Field label="Agent">
            <Segmented
              value={provider}
              onChange={(p) => { if (p !== provider) { setModel(''); setEffort('') } setProvider(p) }}
              options={[
                { value: 'claude', label: <ProviderLabel id="claude" /> },
                { value: 'codex', label: <ProviderLabel id="codex" /> }
              ]}
            />
          </Field>
          <Field label="Model">
            <ModelSelect provider={provider} value={model} onChange={setModel} defaultLabel={`Default${config?.providers[provider].model ? ` (${config.providers[provider].model})` : ''}`} />
          </Field>
          <Field label="Thinking effort">
            <EffortSelect provider={provider} model={model || config?.providers[provider].model || ''} value={effort} onChange={setEffort} defaultLabel="Default" />
          </Field>
          <Field label="Working directory" className="col-span-3">
            <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={config?.defaultCwd || '~ (home)'} mono />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
