import { useState } from 'react'
import { call, ea, useOp } from '@/lib/api'
import { Button, Card, Field, Input, PageHeader } from '@/components/ui'
import { useAction } from '@/components/toast'
import type { AuthStatus } from '@shared/types'
import { SubscriptionLogin } from '@/components/SubscriptionLogin'

type Profile = { id: string; name: string; role: 'admin' | 'member'; enabled: boolean; handles: string[]; slackUsers: string[] }
export function Profiles() {
  const { data, reload, error } = useOp<Profile[]>('profiles_list')
  const act = useAction()
  const [name, setName] = useState(''), [id, setId] = useState(''), [phone, setPhone] = useState(''), [slack, setSlack] = useState('')
  const [login, setLogin] = useState<{ profile: Profile; provider: 'claude' | 'codex' } | null>(null)
  const [auth, setAuth] = useState<Record<string, AuthStatus>>({})
  const create = async () => {
    const result = await act(() => call('profiles_create', { id, name, handles: phone.trim() ? [phone.trim()] : [], slackUsers: slack.trim() ? [slack.trim()] : [] }), 'Profile created')
    if (result) { setName(''); setId(''); setPhone(''); setSlack(''); await reload() }
  }
  const scoped = <T,>(p: Profile, op: string, args = {}) => p.id === 'owner' ? ea.invoke<T>(op, args) : ea.invoke<T>('profiles_call', { id: p.id, op, args })
  const connect = (p: Profile, provider: 'claude' | 'codex') => setLogin({ profile: p, provider })
  return <div className="mx-auto max-w-4xl space-y-6 p-6">
    <PageHeader title="Profiles" description="The owner administers the shared assistant. Everyone has their own memory, conversations, schedules and subscriptions." />
    {error && <p className="text-red">{error}</p>}
    <p className="text-sm text-fg-2">Profiles are for trusted people on this Mac. The owner can manage every profile. Member conversations use direct messages, and shell execution is disabled for members by default.</p>
    {(data ?? []).map((p) => <Card key={p.id} className="space-y-3 p-4">
      <div className="flex items-center justify-between"><strong>{p.name} <span className="font-normal text-fg-3">· {p.role}{!p.enabled && ' · disabled'}</span></strong>
        {p.enabled && <Button onClick={() => { sessionStorage.setItem('jarvis-profile', p.id); window.location.hash = '/chat'; window.location.reload() }}>Manage profile</Button>}
      </div>
      <div className="text-sm text-fg-2">{[...p.handles, ...p.slackUsers].join(' · ') || 'No contacts assigned'}</div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => connect(p, 'claude')}>Connect Claude</Button>
        <Button onClick={() => connect(p, 'codex')}>Connect ChatGPT (Codex)</Button>
        <Button onClick={() => act(() => scoped<AuthStatus>(p, 'auth_status', { refresh: true })).then((a) => a && setAuth((xs) => ({ ...xs, [p.id]: a })))}>Check login</Button>
        {p.role !== 'admin' && <>
          <Button onClick={() => act(() => call('profiles_update', { id: p.id, enabled: !p.enabled }), p.enabled ? 'Profile disabled' : 'Profile enabled').then(reload)}>{p.enabled ? 'Disable' : 'Enable'}</Button>
          {p.handles.length > 0 && <Button onClick={() => act(() => call('profiles_invite', { id: p.id, gateway: 'imessage' }), 'Invitation sent')}>Invite by iMessage</Button>}
          {p.slackUsers.length > 0 && <Button onClick={() => act(() => call('profiles_invite', { id: p.id, gateway: 'slack' }), 'Invitation sent')}>Invite by Slack</Button>}
        </>}
      </div>
      {auth[p.id] && <div className="text-xs text-fg-2">Claude: {auth[p.id].claude.detail}<br />Codex: {auth[p.id].codex.detail}</div>}
    </Card>)}
    {login && <SubscriptionLogin key={`${login.profile.id}:${login.provider}`} profile={login.profile} provider={login.provider} onClose={() => setLogin(null)}
      onDone={(i) => { if (i.state === 'connected') void scoped<AuthStatus>(login.profile, 'auth_status', { refresh: true }).then((a) => setAuth((xs) => ({ ...xs, [login.profile.id]: a })), () => undefined) }} />}
    <Card className="space-y-3 p-4"><strong>Add a profile</strong>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name"><Input value={name} onChange={(e) => { setName(e.target.value); if (!id) setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')) }} placeholder="Ethan" /></Field>
        <Field label="Profile ID"><Input value={id} onChange={(e) => setId(e.target.value)} placeholder="ethan" /></Field>
        <Field label="Phone number or iMessage email"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        <Field label="Slack member ID"><Input value={slack} onChange={(e) => setSlack(e.target.value)} placeholder="U…" /></Field>
      </div>
      <Button variant="primary" disabled={!name.trim() || !id.trim()} onClick={() => void create()}>Create profile</Button>
    </Card>
  </div>
}
