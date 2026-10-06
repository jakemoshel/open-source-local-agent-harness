import { useState } from 'react'
import { Blocks, Pencil, Plus, Trash2, Zap } from 'lucide-react'
import type { McpServerEntry } from '@shared/types'
import { call, useOp } from '@/lib/api'
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Field, Input, Modal, PageHeader, Switch, Textarea } from '@/components/ui'
import { useAction } from '@/components/toast'

function Editor({ name: initialName, server, onClose }: { name: string; server: McpServerEntry; onClose: () => void }) {
  const [name, setName] = useState(initialName)
  const [json, setJson] = useState(JSON.stringify(server, null, 2))
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    try {
      const parsed = JSON.parse(json) as McpServerEntry & { mcpServers?: Record<string, McpServerEntry> }
      if (parsed.mcpServers) {
        for (const [n, s] of Object.entries(parsed.mcpServers)) await call('mcp_upsert', { name: n, server: s })
      } else {
        await call('mcp_upsert', { name, server: parsed })
        if (initialName && initialName !== name) await call('mcp_delete', { name: initialName })
      }
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={initialName ? `Edit ${initialName}` : 'Add MCP server'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ErrorNote error={error} />
        <Field label="Name">
          <Input mono value={name} onChange={(e) => setName(e.target.value)} placeholder="github" />
        </Field>
        <Field
          label="Config (JSON)"
          hint={
            <>
              stdio: <code>{'{"command":"npx","args":["-y","pkg"],"env":{}}'}</code> · remote: <code>{'{"type":"http","url":"https://…","headers":{}}'}</code> · You can also paste a whole{' '}
              <code>{'{"mcpServers":{…}}'}</code> block from Claude Code or Cursor. Optional <code>"providers":["claude"]</code>.
            </>
          }
        >
          <Textarea mono rows={12} value={json} onChange={(e) => setJson(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

export function Integrations() {
  const { data } = useOp<Record<string, McpServerEntry>>('mcp_list', {}, { refreshOn: ['config:changed'] })
  const [editing, setEditing] = useState<{ name: string; server: McpServerEntry } | null>(null)
  const act = useAction()
  const entries = Object.entries(data ?? {})
  return (
    <>
      <PageHeader
        title="Integrations"
        description="MCP servers on every run."
        actions={
          <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing({ name: '', server: { command: '', args: [] } })}>
            Add server
          </Button>
        }
      />
      <Card className="mb-6">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Zap className="size-4" /> harness <Badge>built-in</Badge>
            </span>
          }
          description="Lets Jarvis manage itself. Always on."
        />
      </Card>
      <Card>
        {entries.length ? (
          <div className="divide-y divide-line">
            {entries.map(([name, s]) => (
              <div key={name} className="flex items-center gap-4 px-4 py-3">
                <Blocks className="size-4 text-fg-3" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {name}
                    <Badge>{s.url ? (s.type ?? 'http') : 'stdio'}</Badge>
                    {s.providers?.map((p) => (
                      <Badge key={p} tone="blue">
                        {p} only
                      </Badge>
                    ))}
                  </div>
                  <div className="truncate font-mono text-xs text-fg-3">{s.url ?? `${s.command} ${(s.args ?? []).join(' ')}`}</div>
                </div>
                <Switch checked={s.enabled !== false} onChange={(v) => act(() => call('mcp_upsert', { name, server: { ...s, enabled: v } }))} />
                <Button variant="ghost" size="sm" onClick={() => setEditing({ name, server: s })}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => confirm(`Remove ${name}?`) && act(() => call('mcp_delete', { name }), 'Removed')}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon={<Blocks className="size-4" />} title="No MCP servers" description="Add one or import from Hermes." />
        )}
      </Card>
      {editing && <Editor name={editing.name} server={editing.server} onClose={() => setEditing(null)} />}
    </>
  )
}
