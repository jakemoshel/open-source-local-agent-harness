import { useEffect, useState } from 'react'
import type { ProviderLogin } from '@shared/types'
import { call } from '@/lib/api'
import { Button, Card, CopyButton, ErrorNote, Input, Spinner } from '@/components/ui'
import { useAction } from '@/components/toast'

export type LoginTarget = { id: string; name: string; handles: string[]; slackUsers: string[] }

const scoped = <T,>(profile: string, op: string, args: Record<string, unknown> = {}) =>
  profile === 'owner' ? call<T>(op, args) : call<T>('profiles_call', { id: profile, op, args })

/**
 * Starts a subscription sign-in on the Mac mini and shows the link. Whoever owns the subscription opens it on
 * their own device, here or after it is sent to them, so nobody has to sit at the Mac mini.
 */
export function SubscriptionLogin({ profile, provider, onDone, onClose }: { profile: LoginTarget; provider: ProviderLogin['provider']; onDone?: (info: ProviderLogin) => void; onClose: () => void }) {
  const act = useAction()
  const [info, setInfo] = useState<ProviderLogin | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const active = info?.state === 'waiting' || info?.state === 'verifying'
  const label = provider === 'claude' ? 'Claude' : 'ChatGPT'

  useEffect(() => {
    let cancelled = false
    setInfo(null); setError(null); setCode('')
    scoped<ProviderLogin>(profile.id, 'profiles_login', { provider })
      .then((i) => { if (!cancelled) setInfo(i) }, (err: Error) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [profile.id, provider])

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      scoped<ProviderLogin | null>(profile.id, 'profiles_login_status', { provider }).then((i) => i && setInfo(i), () => undefined)
    }, 2000)
    return () => clearInterval(timer)
  }, [active, profile.id, provider])

  useEffect(() => { if (info && !active) onDone?.(info) }, [info?.state])

  const submit = async () => {
    setSubmitting(true)
    try {
      const result = await act(() => scoped<ProviderLogin>(profile.id, 'profiles_login_code', { code }))
      if (result) { setInfo(result); setCode('') }
    } finally { setSubmitting(false) }
  }
  const send = (gateway: 'imessage' | 'slack') =>
    act(() => scoped<ProviderLogin>(profile.id, 'profiles_login', { provider, notify: gateway }), `Sign-in link sent to ${profile.name}`).then((i) => i && setInfo(i))

  return <Card className="space-y-3 p-4">
    <div className="flex items-center justify-between">
      <strong>Connect {profile.name}’s {label} subscription</strong>
      <Button size="sm" onClick={() => { if (active) void scoped(profile.id, 'profiles_login_cancel', { provider }); onClose() }}>{active ? 'Cancel' : 'Close'}</Button>
    </div>
    <ErrorNote error={error} />
    {!info && !error && <div className="flex items-center gap-2 text-sm text-fg-2"><Spinner /> Starting sign-in…</div>}
    {info && active && info.url && <>
      <p className="text-sm text-fg-2">
        {profile.name} opens this link on any device and signs in with their own {label} account.
        {provider === 'codex' ? ' Then they enter the code below.' : ' After they approve, Claude shows a code: paste it below, or they can send it to Jarvis as a message.'}
      </p>
      <div className="flex items-center gap-2 rounded bg-bg-2 p-2">
        <a className="selectable min-w-0 flex-1 truncate font-mono text-xs text-accent" href={info.url} target="_blank" rel="noreferrer">{info.url}</a>
        <CopyButton text={info.url} />
      </div>
      {info.userCode && <div className="flex items-center gap-2"><span className="selectable font-mono text-2xl tracking-widest">{info.userCode}</span><CopyButton text={info.userCode} /></div>}
      {info.needsCode && <div className="flex gap-2">
        <Input mono className="flex-1" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code from Claude’s approval page" onKeyDown={(e) => e.key === 'Enter' && code.trim() && void submit()} />
        <Button variant="primary" loading={submitting} disabled={!code.trim()} onClick={() => void submit()}>Connect</Button>
      </div>}
      {info.state === 'verifying' && <div className="flex items-center gap-2 text-sm text-fg-2"><Spinner /> {info.detail}</div>}
      {profile.id !== 'owner' && (profile.handles.length > 0 || profile.slackUsers.length > 0) && <div className="flex flex-wrap gap-2">
        {profile.handles.length > 0 && <Button size="sm" onClick={() => void send('imessage')}>Send link by iMessage</Button>}
        {profile.slackUsers.length > 0 && <Button size="sm" onClick={() => void send('slack')}>Send link by Slack</Button>}
      </div>}
      <p className="text-xs text-fg-3">Expires at {new Date(info.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>
    </>}
    {info && !active && <p className={info.state === 'connected' ? 'text-sm text-green' : 'text-sm text-red'}>
      {info.state === 'connected' ? `Connected: ${info.detail}` : info.detail}
    </p>}
  </Card>
}
