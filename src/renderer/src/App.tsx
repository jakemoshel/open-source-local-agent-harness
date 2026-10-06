import { lazy, Suspense, useEffect } from 'react'
import type { HarnessConfig } from '@shared/types'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Shell } from './components/Shell'
import { ea, useOp } from './lib/api'
import { Chat } from './pages/Chat'

// Chat is the landing page; everything else loads on first visit to keep startup light.
const Profiles = lazy(() => import('./pages/Profiles').then((m) => ({ default: m.Profiles })))
const Overview = lazy(() => import('./pages/Overview').then((m) => ({ default: m.Overview })))
const Runs = lazy(() => import('./pages/Runs').then((m) => ({ default: m.Runs })))
const RunDetail = lazy(() => import('./pages/RunDetail').then((m) => ({ default: m.RunDetail })))
const Schedules = lazy(() => import('./pages/Schedules').then((m) => ({ default: m.Schedules })))
const Gateways = lazy(() => import('./pages/Gateways').then((m) => ({ default: m.Gateways })))
const Integrations = lazy(() => import('./pages/Integrations').then((m) => ({ default: m.Integrations })))
const Skills = lazy(() => import('./pages/Skills').then((m) => ({ default: m.Skills })))
const Memory = lazy(() => import('./pages/Memory').then((m) => ({ default: m.Memory })))
const Env = lazy(() => import('./pages/Env').then((m) => ({ default: m.Env })))
const Safeguards = lazy(() => import('./pages/Safeguards').then((m) => ({ default: m.Safeguards })))
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })))
const Import = lazy(() => import('./pages/Import').then((m) => ({ default: m.Import })))
const SystemPage = lazy(() => import('./pages/System').then((m) => ({ default: m.SystemPage })))
const Terminal = lazy(() => import('./pages/Terminal').then((m) => ({ default: m.Terminal })))
const Welcome = lazy(() => import('./pages/Welcome').then((m) => ({ default: m.Welcome })))
const Activity = lazy(() => import('./pages/Activity').then((m) => ({ default: m.Activity })))

function useTheme(data: HarnessConfig | null | undefined) {
  const theme = data?.ui.theme ?? 'light'
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => (document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme)
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}

export function App() {
  const navigate = useNavigate()
  useEffect(() => ea.onNavigate((p) => navigate(p)), [navigate])
  const { pathname } = useLocation()
  const { data: config } = useOp<HarnessConfig>('config_get', {}, { refreshOn: ['config:changed'] })
  useTheme(config)
  // First run opens on setup; only the owner's own window is redirected.
  const owner = (sessionStorage.getItem('jarvis-profile') || 'owner') === 'owner'
  if (config && !config.ui.onboarded && owner && !sessionStorage.getItem('jarvis-onboarded') && pathname !== '/welcome') return <Navigate to="/welcome" replace />
  return (
    <Routes>
      <Route path="welcome" element={<Suspense fallback={null}><Welcome /></Suspense>} />
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/chat" replace />} />
        <Route path="chat" element={<Chat />} />
        <Route path="chat/:key" element={<Chat />} />
        <Route path="overview" element={<Overview />} />
        <Route path="runs" element={<Runs />} />
        <Route path="runs/:id" element={<RunDetail />} />
        <Route path="schedules" element={<Schedules />} />
        <Route path="gateways" element={<Gateways />} />
        <Route path="integrations" element={<Integrations />} />
        <Route path="skills" element={<Skills />} />
        <Route path="memory" element={<Memory />} />
        <Route path="env" element={<Env />} />
        <Route path="safeguards" element={<Safeguards />} />
        <Route path="profiles" element={<Profiles />} />
        <Route path="settings" element={<Settings />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="import" element={<Import />} />
        <Route path="activity" element={<Activity />} />
        <Route path="terminal" element={<Terminal />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Route>
    </Routes>
  )
}
