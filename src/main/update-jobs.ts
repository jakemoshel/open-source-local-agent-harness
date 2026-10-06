import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { paths } from './paths'
type UpdatePhase = 'queued' | 'building' | 'ready' | 'installing' | 'verifying' | 'succeeded' | 'rolled-back' | 'failed'
export interface UpdateJob {
  id: string; directory: string; source: string; target: string; commit: string; previousCommit: string
  appName: string; uid: number; serviceLabel: string; reopen: boolean; createdAt: number
  actor: 'user' | 'agent' | 'system'; callerRunId?: string
  reply?: { gateway: 'slack' | 'imessage'; target: string }
  signingIdentity?: string; localSigning?: { hash: string; keychain: string } | null
  environment: Record<string, string>
}
export interface UpdateJobState { jobId: string; commit: string; phase: UpdatePhase; message: string; updatedAt: number; workerPid?: number }
export const updateRoot = () => join(paths.data, 'updater')
export function readUpdateFile<T>(file: string): T | null {
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8')) as T
}
export function writeUpdateFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp'
  const fd = openSync(tmp, 'w', 0o600)
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
  const dir = openSync(dirname(file), 'r')
  try { fsyncSync(dir) } finally { closeSync(dir) }
}
export function currentUpdate(): { job: UpdateJob; state: UpdateJobState } | null {
  const current = readUpdateFile<{ id: string }>(join(updateRoot(), 'current.json'))
  if (!current || !/^[a-f0-9-]{36}$/.test(current.id)) return null
  const dir = join(updateRoot(), 'jobs', current.id)
  const job = readUpdateFile<UpdateJob>(join(dir, 'job.json'))
  const state = readUpdateFile<UpdateJobState>(join(dir, 'state.json'))
  if (!job || !state || job.id !== current.id || job.directory !== dir || state.jobId !== job.id) throw new Error('Update job record is incomplete; preserve the updater directory for repair')
  return { job, state }
}
export const finishedUpdate = (phase: UpdatePhase) => ['succeeded', 'rolled-back', 'failed'].includes(phase)
