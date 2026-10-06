import { Suspense, useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Command } from 'cmdk'
import { Play, Plus, Search, ShieldAlert } from 'lucide-react'
import type { Approval, AuthStatus, Run } from '@shared/types'
import { call, useOp } from '@/lib/api'
import { cx } from '@/lib/cx'
import { Button, Mark, StatusDot } from './ui'
import { NewRunModal } from './NewRun'
import { useAction } from './toast'

const tabs = [
  { to: '/chat', label: 'Chat' },
  { to: '/runs', label: 'Runs' },
  { to: '/schedules', label: 'Schedules' },
  { to: '/memory', label: 'Memory' },
  { to: '/skills', label: 'Skills' },
  { to: '/terminal', label: 'Terminal' },
  { to: '/settings', label: 'Settings' },
  { to: '/profiles', label: `Profile: ${sessionStorage.getItem('jarvis-profile') || 'owner'}` }
]

const settingsTabs = [
  { to: '/settings', label: 'General' },
  { to: '/profiles', label: 'Profiles' },
  { to: '/system', label: 'System' },
  { to: '/gateways', label: 'Gateways' },
  { to: '/integrations', label: 'Integrations' },
  { to: '/env', label: 'Env' },
  { to: '/safeguards', label: 'Safeguards' },
  { to: '/activity', label: 'Activity' }
]

const allPages = [...tabs, ...settingsTabs.slice(1), { to: '/overview', label: 'Overview' }, { to: '/import', label: 'Import' }]

/** Silent when both subscriptions are fine; only speaks up when something needs a sign-in. */
function AuthPill() {
  const { data } = useOp<AuthStatus>('auth_status', {}, { refreshOn: ['config:changed'] })
  if (!data || (data.claude.ok && data.codex.ok)) return null
  const some = data.claude.ok || data.codex.ok
  return (
    <NavLink to="/settings" className="no-drag flex h-7 items-center gap-2 rounded-full border border-line px-2.5 text-xs text-fg-2 hover:bg-hover">
      <span className={cx('size-2 rounded-full', some ? 'bg-amber' : 'bg-red')} />
      {some ? `${data.claude.ok ? 'Codex' : 'Claude'} signed out` : 'Sign in'}
    </NavLink>
  )
}

function ApprovalsBar() {
  const { data, reload } = useOp<Approval[]>('approvals_list', { status: 'pending' }, { refreshOn: ['approval:update'] })
  const act = useAction()
  const navigate = useNavigate()
  if (!data?.length) return null
  const a = data[0]
  const subject = typeof a.input.command === 'string' ? a.input.command : typeof a.input.file_path === 'string' ? a.input.file_path : JSON.stringify(a.input)
  return (
    <div className="flex items-center gap-3 border-b border-purple/30 bg-purple/8 px-6 py-2 text-[13px]">
      <ShieldAlert className="size-4 shrink-0 text-purple" />
      <div className="min-w-0 flex-1 truncate">
        <span className="font-medium">{a.tool}</span> <span className="font-mono text-fg-2">{subject}</span>
        {data.length > 1 && <span className="ml-2 text-fg-3">+{data.length - 1} more</span>}
      </div>
      <Button size="sm" variant="ghost" onClick={() => navigate(`/runs/${a.runId}`)}>
        View run
      </Button>
      <Button size="sm" onClick={() => act(() => call('approvals_resolve', { id: a.id, approve: false })).then(reload)}>
        Deny
      </Button>
      <Button size="sm" title="Approve, and stop asking about this exact action" onClick={() => act(() => call<{ allowedAlways?: string }>('approvals_resolve', { id: a.id, approve: true, always: true })).then(reload)}>
        Always allow
      </Button>
      <Button size="sm" variant="primary" onClick={() => act(() => call('approvals_resolve', { id: a.id, approve: true })).then(reload)}>
        Approve
      </Button>
    </div>
  )
}

function Palette({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  // Each opening starts with an empty search and current runs.
  useEffect(() => { if (!open) setQ('') }, [open])
  if (!open) return null
  const go = (to: string) => {
    setOpen(false)
    navigate(to)
  }
  return <PaletteBody q={q} setQ={setQ} go={go} close={() => setOpen(false)} />
}

function PaletteBody({ q, setQ, go, close }: { q: string; setQ: (v: string) => void; go: (to: string) => void; close: () => void }) {
  const { data: runs } = useOp<Run[]>('runs_list', { limit: 30, q: q || undefined }, { throttleMs: 150 })

  return (
    <div className="no-drag fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[14vh] backdrop-blur-[2px]" onMouseDown={close}>
      <Command
        className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-bg shadow-[var(--shadow)]"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && close()}
        loop
      >
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="size-4 text-fg-3" />
          <Command.Input autoFocus value={q} onValueChange={setQ} placeholder="Search runs, pages and actions…" className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-fg-3" />
        </div>
        <Command.List className="max-h-[50vh] overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-fg-3">
          <Command.Empty className="px-3 py-6 text-center text-sm text-fg-3">No results</Command.Empty>
          <Command.Group heading="Actions">
            <Item
              onSelect={() => go('/chat')}
            >
              <Play className="size-3.5" /> New chat
            </Item>
            <Item onSelect={() => go('/import')}>Import from Hermes</Item>
          </Command.Group>
          <Command.Group heading="Pages">
            {allPages.map((t) => (
              <Item key={t.to} onSelect={() => go(t.to)}>
                {t.label}
              </Item>
            ))}
          </Command.Group>
          {!!runs?.length && (
            <Command.Group heading="Runs">
              {runs.map((r) => (
                <Item key={r.id} value={`${r.title} ${r.id}`} onSelect={() => go(`/runs/${r.id}`)}>
                  <StatusDot status={r.status} className="size-2" />
                  <span className="truncate">{r.title}</span>
                </Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </div>
  )
}

function Item({ children, onSelect, value }: { children: React.ReactNode; onSelect: () => void; value?: string }) {
  return (
    <Command.Item value={value} onSelect={onSelect} className="flex h-9 cursor-default items-center gap-2 rounded-md px-2 text-sm text-fg-2 data-[selected=true]:bg-hover data-[selected=true]:text-fg">
      {children}
    </Command.Item>
  )
}

export function Shell() {
  const [palette, setPalette] = useState(false)
  const [newRun, setNewRun] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  // Busy runs send many updates; recount at most once a second instead of once per update.
  const { data: running } = useOp<Run[]>('runs_list', { status: 'running', limit: 50 }, { refreshOn: ['run:update'], throttleMs: 1000 })
  const active = running?.length ?? 0
  const inSettings = settingsTabs.some((t) => location.pathname === t.to)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        setPalette((v) => !v)
      } else if (key === 'n') {
        e.preventDefault()
        if (e.shiftKey) setNewRun(true)
        else navigate('/chat')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  useEffect(() => {
    if (new URLSearchParams(location.search).get('new') === '1') {
      setNewRun(true)
      navigate(location.pathname, { replace: true })
    }
  }, [location, navigate])

  return (
    <div className="flex h-full flex-col">
      <header className="drag sticky top-0 z-40 border-b border-line bg-bg">
        <div className="flex h-12 items-center gap-2 pr-3 pl-[88px]">
          <Mark className="size-5" />
          <span className="text-sm font-semibold tracking-tight">Jarvis</span>
          {active > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-fg-3">
              <StatusDot status="running" className="size-1.5" /> {active}
            </span>
          )}
          <nav className="no-drag ml-4 flex gap-0.5">
            {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              className={({ isActive }) =>
                  cx('rounded-md px-2.5 py-1 text-[13px] transition-colors', isActive || (t.to === '/settings' && inSettings && location.pathname !== '/profiles') ? 'bg-hover text-fg' : 'text-fg-3 hover:text-fg')
                }
              >
                {t.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex-1" />
          <AuthPill />
          <button onClick={() => setPalette(true)} title="Search (⌘K)" className="no-drag flex size-8 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg">
            <Search className="size-4" />
          </button>
          <button onClick={() => navigate('/chat')} title="New chat (⌘N)" className="no-drag flex size-8 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg">
            <Plus className="size-4" />
          </button>
        </div>
        {inSettings && (
          <nav className="no-drag flex gap-4 px-[88px] pb-2 text-[13px]">
            {settingsTabs.map((t) => (
              <NavLink key={t.to} to={t.to} end className={({ isActive }) => (isActive ? 'text-fg' : 'text-fg-3 hover:text-fg')}>
                {t.label}
              </NavLink>
            ))}
          </nav>
        )}
      </header>
      <ApprovalsBar />
      {location.pathname.startsWith('/chat') ? (
        <main className="min-h-0 flex-1">
          <Suspense fallback={null}>
            <Outlet />
          </Suspense>
        </main>
      ) : (
        <main className="flex-1 overflow-y-auto bg-bg-2">
          <div className="mx-auto max-w-[1200px] px-6 py-8">
            <Suspense fallback={null}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      )}
      <Palette open={palette} setOpen={setPalette} />
      <NewRunModal open={newRun} onClose={() => setNewRun(false)} />
    </div>
  )
}
