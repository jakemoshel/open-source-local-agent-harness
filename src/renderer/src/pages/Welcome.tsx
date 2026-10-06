import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Globe, KeyRound, MessageSquare, PackageOpen, ShieldCheck } from 'lucide-react'
import type { AuthStatus, PermissionStatus } from '@shared/types'
import { call, useOp } from '@/lib/api'
import { cx } from '@/lib/cx'
import { Badge, Button, Card, Field, Input, Mark, Spinner } from '@/components/ui'
import { useAction } from '@/components/toast'
import { SubscriptionLogin, type LoginTarget } from '@/components/SubscriptionLogin'
import { Import } from './Import'

const BROWSEROS_URL = 'http://127.0.0.1:9010/mcp'
const BLUEBUBBLES_REPO = 'https://github.com/BlueBubblesApp/bluebubbles-server'

const steps = [
  { id: 'import', label: 'Import', icon: PackageOpen },
  { id: 'agents', label: 'Agents', icon: KeyRound },
  { id: 'permissions', label: 'Permissions', icon: ShieldCheck },
  { id: 'browser', label: 'Browser', icon: Globe },
  { id: 'imessage', label: 'iMessage', icon: MessageSquare }
] as const

/** What agents launched by Jarvis can reach; each is granted to the app itself in System Settings. */
const permissions = [
  { key: 'fullDiskAccess', pane: 'fullDiskAccess', label: 'Full Disk Access', why: 'Read Messages, Mail and your files, like Terminal can. Recommended.' },
  { key: 'accessibility', pane: 'accessibility', label: 'Accessibility', why: 'Click and type in other apps for you.' },
  { key: 'screenRecording', pane: 'screenRecording', label: 'Screen Recording', why: 'Take screenshots to see what is on screen.' }
] as const

function Permissions() {
  const { data, reload } = useOp<PermissionStatus>('permissions_status')
  // macOS reports a grant only once the person toggles it in System Settings, so keep checking.
  useEffect(() => { const t = setInterval(() => void reload(), 2000); return () => clearInterval(t) }, [reload])
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-2">Agents run as part of Jarvis, so they get the access you give the app. Add <strong>Mac Mini Jarvis</strong> in each pane and switch it on. All optional.</p>
      {permissions.map((p) => (
        <Card key={p.key} className="flex items-center gap-3 p-4">
          <div className="flex-1">
            <div className="text-sm font-semibold">{p.label}</div>
            <div className="text-xs text-fg-3">{p.why}</div>
          </div>
          {data?.[p.key] ? <Badge tone="green">Granted</Badge> : <Button onClick={() => void call('open_settings_pane', { pane: p.pane })}>Open Settings</Button>}
        </Card>
      ))}
      {data && !data.packaged && <p className="text-xs text-fg-3">Development build: grants apply to {data.appPath}.</p>}
    </div>
  )
}

const firstPrompt = (phone: string | null) => `Help me set up BlueBubbles so I can text you from iMessage. The server is here: ${BLUEBUBBLES_REPO}

Walk me through it one step at a time, and check each step yourself where you can before moving on:
1. Install the BlueBubbles server on this Mac and grant the permissions it asks for.
2. Set a server password and confirm the server answers locally.
3. Save BLUEBUBBLES_SERVER_URL and BLUEBUBBLES_PASSWORD in your environment (env_set), then enable the iMessage gateway with the bluebubbles backend.
4. Send me a test iMessage.
${phone ? `My iMessage number is ${phone}.` : 'I haven’t added my phone number yet: remind me to add it under Gateways → Owner, since only that number can message you.'}`

/** First run: optional Hermes import, required Claude/Codex sign-in, optional browser, then an agent run that sets up BlueBubbles. */
export function Welcome() {
  const navigate = useNavigate()
  const act = useAction()
  const [step, setStep] = useState(0)
  const [hermes, setHermes] = useState<boolean | null>(null)
  const { data: auth, reload: reloadAuth } = useOp<AuthStatus>('auth_status', { refresh: true })
  const { data: profiles } = useOp<LoginTarget[]>('profiles_list')
  const [signIn, setSignIn] = useState<'claude' | 'codex' | null>(null)
  const [installing, setInstalling] = useState(false)
  const [browser, setBrowser] = useState<'browseros' | 'skip'>('browseros')
  const [browserUrl, setBrowserUrl] = useState(BROWSEROS_URL)
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const owner = profiles?.find((p) => p.id === 'owner') ?? null
  const connected = !!auth && (auth.claude.ok || auth.codex.ok)

  useEffect(() => { void call<unknown[]>('hermes_detect').then((f) => setHermes(f.length > 0), () => setHermes(false)) }, [])

  const finish = async (start: boolean) => {
    setBusy(true)
    try {
      const done = await act(async () => {
        let saved: string | null = null
        if (start && phone.trim()) saved = (await call<{ phone: string | null }>('owner_set', { phone })).phone
        await call('config_update', { patch: { ui: { onboarded: true } } })
        // The config refresh can land after navigation; don't bounce back here meanwhile.
        sessionStorage.setItem('jarvis-onboarded', '1')
        if (!start) return '/chat'
        const key = `ui:${crypto.randomUUID()}`
        const sent = await call<{ conversationKey?: string }>('chat_send', { prompt: firstPrompt(saved), conversationKey: key })
        return `/chat/${encodeURIComponent(sent.conversationKey ?? key)}`
      })
      if (done) navigate(done, { replace: true })
    } finally { setBusy(false) }
  }

  const next = async () => {
    if (steps[step].id === 'browser' && browser === 'browseros') {
      const ok = await act(() => call('mcp_upsert', { name: 'browseros', server: { type: 'http', url: browserUrl.trim() } }), 'BrowserOS connected')
      if (ok === undefined) return
    }
    setStep((s) => s + 1)
  }

  const install = async () => {
    setInstalling(true)
    try { await act(() => call('auth_install_missing')); await reloadAuth() } finally { setInstalling(false) }
  }

  const id = steps[step].id
  return (
    <div className="flex h-screen flex-col bg-bg">
      <div className="drag h-12 shrink-0" />
      <div className="mx-auto flex w-full max-w-2xl min-h-0 flex-1 flex-col px-6 pb-8">
        <div className="mb-8 flex items-center gap-3">
          <Mark className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">Set up Jarvis</h1>
            <p className="text-[13px] text-fg-2">Only signing in to Claude or Codex is required. Everything else can be skipped.</p>
          </div>
        </div>

        <ol className="mb-6 flex gap-2">
          {steps.map((s, i) => (
            <li key={s.id} className={cx('flex flex-1 items-center gap-2 rounded-md border px-3 py-2 text-[13px]', i === step ? 'border-accent text-fg' : 'border-line text-fg-3')}>
              {i < step ? <Check className="size-3.5 text-green" /> : <s.icon className="size-3.5" />}
              {s.label}
            </li>
          ))}
        </ol>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {id === 'import' && (hermes === null ? <Spinner /> : hermes
            ? <div className="space-y-3"><p className="text-sm text-fg-2">Found a Hermes install. Import its identity, memories, skills, MCP servers, BlueBubbles setup and jobs, or skip.</p><Import /></div>
            : <Card className="p-4 text-sm text-fg-2">No Hermes install found in <code className="font-mono">~/.hermes</code>. Nothing to import, so continue.</Card>)}

          {id === 'agents' && (
            <div className="space-y-3">
              <p className="text-sm text-fg-2">Jarvis runs on your Claude and ChatGPT subscriptions, never API keys. Connect at least one.</p>
              {auth && (!auth.claude.installed || !auth.codex.installed) && <Button variant="primary" loading={installing} onClick={() => void install()}>Install missing CLIs</Button>}
              {(['claude', 'codex'] as const).map((p) => (
                <Card key={p} className="flex items-center gap-3 p-4">
                  <div className="flex-1">
                    <div className="text-sm font-semibold">{p === 'claude' ? 'Claude Code' : 'Codex (ChatGPT)'}</div>
                    <div className="text-xs text-fg-3">{auth ? auth[p].detail : 'Checking…'}</div>
                  </div>
                  {auth?.[p].ok ? <Badge tone="green">Connected</Badge>
                    : <Button disabled={!auth?.[p].installed || !owner} onClick={() => setSignIn(p)}>Sign in</Button>}
                </Card>
              ))}
              {signIn && owner && <SubscriptionLogin profile={owner} provider={signIn} onDone={() => void reloadAuth()} onClose={() => { setSignIn(null); void reloadAuth() }} />}
            </div>
          )}

          {id === 'permissions' && <Permissions />}

          {id === 'browser' && (
            <div className="space-y-3">
              <p className="text-sm text-fg-2">How should Jarvis use a browser? A browser it can drive with your logins makes it far more useful.</p>
              <Card className={cx('cursor-pointer p-4', browser === 'browseros' && 'border-accent')} onClick={() => setBrowser('browseros')}>
                <div className="flex items-center gap-2 text-sm font-semibold">BrowserOS <Badge tone="blue">Recommended</Badge></div>
                <p className="mt-1 text-[13px] text-fg-2">
                  Connects the BrowserOS MCP server you set up. Get it at{' '}
                  <a className="text-accent" href="https://www.browseros.com" target="_blank" rel="noreferrer">browseros.com</a>.
                </p>
                {browser === 'browseros' && <Field label="MCP URL" className="mt-3"><Input mono value={browserUrl} onChange={(e) => setBrowserUrl(e.target.value)} /></Field>}
              </Card>
              <Card className={cx('cursor-pointer p-4', browser === 'skip' && 'border-accent')} onClick={() => setBrowser('skip')}>
                <div className="text-sm font-semibold">Skip for now</div>
                <p className="mt-1 text-[13px] text-fg-2">Add one later under Integrations.</p>
              </Card>
            </div>
          )}

          {id === 'imessage' && (
            <div className="space-y-3">
              <p className="text-sm text-fg-2">
                Last step. Jarvis opens a chat and walks you through setting up <a className="text-accent" href={BLUEBUBBLES_REPO} target="_blank" rel="noreferrer">BlueBubbles</a> on this Mac, so you can text it from your phone.
              </p>
              <Field label="Your iMessage number (optional)" hint="Only this number can message Jarvis. You can add it later under Gateways.">
                <Input mono value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+15551234567" />
              </Field>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-line pt-4">
          {step > 0 ? <Button variant="ghost" onClick={() => setStep(step - 1)} disabled={busy}>Back</Button> : <span />}
          {id === 'imessage'
            ? <div className="flex gap-2"><Button disabled={busy} onClick={() => void finish(false)}>Skip</Button><Button variant="primary" loading={busy} onClick={() => void finish(true)}>Set up BlueBubbles</Button></div>
            : <Button variant="primary" disabled={id === 'agents' && !connected} onClick={() => void next()}>{id === 'import' ? (hermes ? 'Continue' : 'Next') : id === 'browser' && browser === 'skip' ? 'Skip' : 'Continue'}</Button>}
        </div>
      </div>
    </div>
  )
}
