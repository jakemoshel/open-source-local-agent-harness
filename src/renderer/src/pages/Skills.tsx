import { useEffect, useState } from 'react'
import { BookOpen, FolderOpen, Plus } from 'lucide-react'
import type { HarnessConfig, Skill } from '@shared/types'
import { call, ea, useOp } from '@/lib/api'
import { shortPath } from '@/lib/format'
import { cx } from '@/lib/cx'
import { Button, Card, Empty, Input, Modal, PageHeader, Textarea } from '@/components/ui'
import { useAction } from '@/components/toast'

const TEMPLATE = (name: string) => `---
name: ${name}
description: One line on when to use this skill.
---

# ${name}

1. Step one
2. Step two
`

export function Skills() {
  const { data: skills, reload } = useOp<Skill[]>('skills_list', {}, { refreshOn: ['audit:new'] })
  const { data: config } = useOp<HarnessConfig>('config_get', {}, {})
  const { data: usage } = useOp<{ name: string; suggested: number; loaded: number; succeeded: number; failed: number }[]>('skills_stats', {}, { refreshOn: ['run:update', 'audit:new'] })
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const act = useAction()

  useEffect(() => {
    if (!selected && skills?.length) setSelected(skills[0].name)
  }, [skills, selected])

  useEffect(() => {
    if (!selected) return
    // Clicking through skills quickly: only the one now selected may fill the editor.
    let current = true
    void call<{ content: string }>('skills_get', { name: selected })
      .then((r) => {
        if (!current) return
        setContent(r.content)
        setOriginal(r.content)
      })
      .catch(() => undefined)
    return () => { current = false }
  }, [selected])

  const current = skills?.find((s) => s.name === selected)

  return (
    <>
      <PageHeader
        title="Skills"
        description="Short core procedures, with detailed recipes in references/. Agents read only needed pages; search includes aliases and reference text. Add pinned: true to protect a skill."
        actions={
          <>
            {config && (
              <Button icon={<FolderOpen className="size-3.5" />} onClick={() => ea.open(config.skillsDir)}>
                Open folder
              </Button>
            )}
            <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
              New skill
            </Button>
          </>
        }
      />
      {skills?.length ? (
        <div className="grid grid-cols-[260px_minmax(0,1fr)] gap-6">
          <Card className="max-h-[70vh] overflow-y-auto p-1.5">
            {skills.map((s) => (
              <button key={s.dir} onClick={() => setSelected(s.name)} className={cx('block w-full rounded-md px-2.5 py-2 text-left', s.name === selected ? 'bg-bg-3' : 'hover:bg-hover')}>
                <div className="truncate text-[13px] font-medium">{s.name}</div>
                <div className="line-clamp-2 text-xs text-fg-3">{s.description}</div>
                <div className="mt-1 text-xs text-fg-3">{s.pinned ? 'Pinned · ' : ''}{usage?.find(u => u.name === s.name)?.loaded ?? 0} agent loads · {usage?.find(u => u.name === s.name)?.suggested ?? 0} suggestions</div>
              </button>
            ))}
          </Card>
          <Card>
            {current && <div className="border-b border-line px-4 py-2 text-xs text-fg-3">Tasks that loaded this skill: {usage?.find(u => u.name === current.name)?.succeeded ?? 0} succeeded · {usage?.find(u => u.name === current.name)?.failed ?? 0} failed</div>}
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <span className="truncate font-mono text-xs text-fg-3">{current && shortPath(current.path)}</span>
              <div className="flex gap-2">
                <Button size="sm" disabled={content === original} onClick={() => setContent(original)}>
                  Discard
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={content === original}
                  onClick={() =>
                    act(async () => {
                      await call('skills_save', { name: selected, content })
                      setOriginal(content)
                      void reload()
                    }, 'Skill saved')
                  }
                >
                  Save
                </Button>
              </div>
            </div>
            <Textarea mono value={content} onChange={(e) => setContent(e.target.value)} className="min-h-[60vh] resize-none rounded-none border-0 p-4 focus:border-0" />
          </Card>
        </div>
      ) : (
        <Card>
          <Empty icon={<BookOpen className="size-4" />} title="No skills yet" description="Jarvis writes these as it learns." />
        </Card>
      )}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New skill"
        footer={
          <Button
            variant="primary"
            disabled={!newName}
            onClick={() =>
              act(async () => {
                await call('skills_save', { name: newName, content: TEMPLATE(newName) })
                setCreating(false)
                await reload()
                setSelected(newName)
                setNewName('')
              }, 'Created')
            }
          >
            Create
          </Button>
        }
      >
        <Input mono autoFocus value={newName} onChange={(e) => setNewName(e.target.value.replace(/\s+/g, '-').toLowerCase())} placeholder="skill-name" />
      </Modal>
    </>
  )
}
