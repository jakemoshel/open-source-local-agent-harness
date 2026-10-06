import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Ban, Eye, EyeOff, FolderOpen, Globe, HardDrive, KeyRound, Pencil, Plus, Shield, Trash2, Wrench } from 'lucide-react'
import type { EnvEntry, HarnessConfig, McpServerEntry, Safeguards, Skill } from '@shared/types'
import { call, ea, useOp } from '@/lib/api'
import { Badge, Button, Card, CardHeader, CopyButton, Empty, Field, Input, Modal, PageHeader } from '@/components/ui'
import { useAction } from '@/components/toast'

function Access() {
  const { data: env } = useOp<EnvEntry[]>('env_list', {}, { refreshOn: ['config:changed'] })
  const { data: mcp } = useOp<Record<string, McpServerEntry>>('mcp_list', {}, { refreshOn: ['config:changed'] })
  const { data: sg } = useOp<Safeguards>('safeguards_get', {}, { refreshOn: ['config:changed'] })
  const { data: skills } = useOp<Skill[]>('skills_list', {}, {})
  const { data: config } = useOp<HarnessConfig>('config_get', {}, { refreshOn: ['config:changed'] })
  const passed = env?.filter((e) => !e.blocked).length ?? 0
  const blocked = env?.filter((e) => e.blocked) ?? []
  const servers = Object.entries(mcp ?? {}).filter(([, s]) => s.enabled !== false)
  const rows: { icon: React.ReactNode; label: string; value: React.ReactNode; to?: string }[] = [
    {
      icon: <HardDrive className="size-4" />,
      label: 'Filesystem',
      value: (
        <>
          Claude Code: <b>full access</b> (no sandbox) · Codex: <b>{sg?.codex.sandboxMode ?? '…'}</b>
        </>
      ),
      to: '/safeguards'
    },
    { icon: <Globe className="size-4" />, label: 'Network', value: <>Claude Code: on · Codex: {sg?.codex.networkAccess ? 'on' : 'off'}</> },
    {
      icon: <KeyRound className="size-4" />,
      label: 'Environment',
      value: (
        <>
          {passed} variable{passed === 1 ? '' : 's'} from this page, plus the app’s own login environment (PATH, HOME…)
        </>
      )
    },
    {
      icon: <Ban className="size-4" />,
      label: 'Never passed',
      value: blocked.length ? blocked.map((b) => b.key).join(', ') : 'Any ANTHROPIC_*, OPENAI_*, CODEX_API_KEY or other pay-per-token keys'
    },
    {
      icon: <Wrench className="size-4" />,
      label: 'Tools',
      value: (
        <>
          Claude Code built-ins (Bash, Read, Edit, Write, Grep, Glob, WebFetch, WebSearch, Task…) or Codex shell/apply_patch, plus harness and {servers.length} MCP server
          {servers.length === 1 ? '' : 's'}
          {servers.length ? `: ${servers.map(([n]) => n).join(', ')}` : ''}
        </>
      ),
      to: '/integrations'
    },
    {
      icon: <Shield className="size-4" />,
      label: 'Safeguards',
      value: (
        <>
          {sg?.rules.length ?? 0} rules · default <b>{sg?.defaultAction}</b> · {skills?.length ?? 0} skills · default directory {config?.defaultCwd || '~'}
        </>
      ),
      to: '/safeguards'
    }
  ]
  return (
    <Card className="mb-6">
      <CardHeader title="What agents can access" description="What every run receives." />
      <div className="divide-y divide-line">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
            <span className="text-fg-3">{r.icon}</span>
            <span className="w-28 shrink-0 font-medium">{r.label}</span>
            <span className="min-w-0 flex-1 text-fg-2">{r.value}</span>
            {r.to && (
              <Link to={r.to} className="text-xs text-fg-3 hover:text-fg">
                Edit
              </Link>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}

export function Env() {
  const { data, reload } = useOp<EnvEntry[]>('env_list', {}, { refreshOn: ['config:changed', 'audit:new'] })
  const { data: info } = useOp<{ files: { env: string } }>('app_info', {}, {})
  const [shown, setShown] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<{ key: string; value: string; isNew: boolean } | null>(null)
  const act = useAction()
  const toggle = (k: string) => setShown((s) => (s.has(k) ? (s.delete(k), new Set(s)) : new Set(s.add(k))))

  return (
    <>
      <PageHeader
        title="Environment"
        description="~/.jarvis/.env"
        actions={
          <>
            {info && (
              <Button icon={<FolderOpen className="size-3.5" />} onClick={() => ea.reveal(info.files.env)}>
                Reveal file
              </Button>
            )}
            <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing({ key: '', value: '', isNew: true })}>
              Add variable
            </Button>
          </>
        }
      />
      <Access />
      <Card>
        {data?.length ? (
          <div className="divide-y divide-line">
            {data.map((e) => (
              <div key={e.key} className="grid grid-cols-[260px_minmax(0,1fr)_auto] items-center gap-4 px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-[13px] font-medium">{e.key}</span>
                  {e.blocked && (
                    <Badge tone="red" className="shrink-0">
                      <span title={e.reason}>not passed</span>
                    </Badge>
                  )}
                </div>
                <div className="selectable truncate font-mono text-[13px] text-fg-2">{shown.has(e.key) ? e.value : e.masked}</div>
                <div className="flex items-center gap-0.5">
                  <Button variant="ghost" size="sm" onClick={() => toggle(e.key)} title={shown.has(e.key) ? 'Hide' : 'Reveal'}>
                    {shown.has(e.key) ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </Button>
                  <CopyButton text={e.value} className="p-1.5" />
                  <Button variant="ghost" size="sm" onClick={() => setEditing({ key: e.key, value: e.value, isNew: false })}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => confirm(`Remove ${e.key}?`) && act(() => call('env_delete', { key: e.key }), 'Removed').then(reload)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon={<KeyRound className="size-4" />} title="No variables" description="Add a token or import from Hermes." />
        )}
      </Card>
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.isNew ? 'Add variable' : `Edit ${editing?.key}`}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!editing?.key}
              onClick={() =>
                act(async () => {
                  const r = await call<{ note?: string }>('env_set', { key: editing!.key, value: editing!.value })
                  setEditing(null)
                  await reload()
                  if (r.note) alert(r.note)
                }, 'Saved')
              }
            >
              Save
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-3">
            <Field label="Key">
              <Input mono autoFocus={editing.isNew} disabled={!editing.isNew} value={editing.key} onChange={(e) => setEditing({ ...editing, key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} />
            </Field>
            <Field label="Value">
              <Input mono autoFocus={!editing.isNew} value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>
    </>
  )
}
