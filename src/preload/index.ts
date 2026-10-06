import { contextBridge, ipcRenderer } from 'electron'

const api = {
  invoke: async <T = unknown>(op: string, args?: unknown): Promise<T> => {
    const res = (await ipcRenderer.invoke('ops:invoke', op, args)) as { ok: boolean; result?: T; error?: string }
    if (!res.ok) throw new Error(res.error)
    return res.result as T
  },
  ops: () => ipcRenderer.invoke('ops:list'),
  open: (target: string) => ipcRenderer.invoke('shell:open', target),
  reveal: (target: string) => ipcRenderer.invoke('shell:reveal', target),
  on: (fn: (channel: string, payload: unknown, profile: string) => void) => {
    const handler = (_e: unknown, channel: string, payload: unknown, profile: string) => fn(channel, payload, profile)
    ipcRenderer.on('bus', handler)
    return () => ipcRenderer.removeListener('bus', handler)
  },
  onNavigate: (fn: (path: string) => void) => {
    const handler = (_e: unknown, path: string) => fn(path)
    ipcRenderer.on('navigate', handler)
    return () => ipcRenderer.removeListener('navigate', handler)
  }
}

contextBridge.exposeInMainWorld('ea', api)

export type EaApi = typeof api
