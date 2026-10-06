import { realpathSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { expandHome } from './paths'

export type FileMode = 'read' | 'write'

export interface FileLease {
  runId: string
  path: string
  mode: FileMode
  startedAt: number
}

export interface FileConflict {
  path: string
  requestedByRunId: string
  requestedMode: FileMode
  conflictingRunId: string
  conflictingMode: FileMode
  type: 'write-write' | 'write-read' | 'read-write'
}

class ConcurrencyTracker {
  private leases = new Map<string, FileLease[]>() // normalizedPath -> FileLease[]
  private runLeases = new Map<string, Set<string>>() // runId -> Set<normalizedPath>
  private conflictLog: FileConflict[] = []

  normalize(filePath: string, cwd?: string): string {
    const expanded = expandHome(filePath)
    const absolute = cwd ? resolve(cwd, expanded) : resolve(expanded)
    let parent = absolute
    for (;;) {
      try {
        // Writes may target missing files/directories. Resolve the existing
        // ancestor so aliases still share a lease before the target is created.
        return resolve(realpathSync(parent), relative(parent, absolute))
      } catch {
        const next = dirname(parent)
        if (next === parent) return absolute
        parent = next
      }
    }
  }

  /**
   * Check if accessing a file conflicts with another active run.
   * - write-write: another run is actively writing to this file.
   * - write-read: another run is actively reading while this run attempts to write.
   * - read-write: another run is actively writing while this run attempts to read.
   */
  checkConflict(runId: string, filePath: string, mode: FileMode, cwd?: string): FileConflict | null {
    return this.checkNormalizedConflict(runId, this.normalize(filePath, cwd), mode)
  }

  private checkNormalizedConflict(runId: string, norm: string, mode: FileMode): FileConflict | null {
    const existing = this.leases.get(norm) ?? []

    if (mode === 'write') {
      const writeLease = existing.find((l) => l.runId !== runId && l.mode === 'write')
      if (writeLease) {
        const conflict: FileConflict = {
          path: norm,
          requestedByRunId: runId,
          requestedMode: mode,
          conflictingRunId: writeLease.runId,
          conflictingMode: writeLease.mode,
          type: 'write-write'
        }
        this.recordConflict(conflict)
        return conflict
      }

      const readLease = existing.find((l) => l.runId !== runId && l.mode === 'read')
      if (readLease) {
        const conflict: FileConflict = {
          path: norm,
          requestedByRunId: runId,
          requestedMode: mode,
          conflictingRunId: readLease.runId,
          conflictingMode: readLease.mode,
          type: 'write-read'
        }
        this.recordConflict(conflict)
        return conflict
      }
    }

    if (mode === 'read') {
      const writeLease = existing.find((l) => l.runId !== runId && l.mode === 'write')
      if (writeLease) {
        const conflict: FileConflict = {
          path: norm,
          requestedByRunId: runId,
          requestedMode: mode,
          conflictingRunId: writeLease.runId,
          conflictingMode: writeLease.mode,
          type: 'read-write'
        }
        this.recordConflict(conflict)
        return conflict
      }
    }

    return null
  }

  /**
   * Acquire a file lease for a run.
   */
  acquire(runId: string, filePath: string, mode: FileMode, cwd?: string): { conflict: FileConflict | null } {
    const norm = this.normalize(filePath, cwd)
    const conflict = this.checkNormalizedConflict(runId, norm, mode)

    if (conflict?.type === 'write-write') {
      return { conflict }
    }

    const list = this.leases.get(norm) ?? []
    const existingIndex = list.findIndex((l) => l.runId === runId)
    if (existingIndex >= 0) {
      const existingMode = list[existingIndex].mode
      const effectiveMode: FileMode = existingMode === 'write' ? 'write' : mode
      list[existingIndex] = { runId, path: norm, mode: effectiveMode, startedAt: Date.now() }
    } else {
      list.push({ runId, path: norm, mode, startedAt: Date.now() })
    }
    this.leases.set(norm, list)

    let runSet = this.runLeases.get(runId)
    if (!runSet) {
      runSet = new Set()
      this.runLeases.set(runId, runSet)
    }
    runSet.add(norm)

    return { conflict }
  }

  /**
   * Release a specific file lease for a run.
   */
  release(runId: string, filePath: string, cwd?: string): void {
    const norm = this.normalize(filePath, cwd)
    const list = this.leases.get(norm)
    if (list) {
      const remaining = list.filter((l) => l.runId !== runId)
      if (remaining.length) this.leases.set(norm, remaining)
      else this.leases.delete(norm)
    }

    const runSet = this.runLeases.get(runId)
    if (runSet) {
      runSet.delete(norm)
      if (!runSet.size) this.runLeases.delete(runId)
    }
  }

  /**
   * Release all leases held by a finished or cancelled run.
   */
  releaseAllForRun(runId: string): void {
    const runSet = this.runLeases.get(runId)
    if (!runSet) return

    for (const norm of runSet) {
      const list = this.leases.get(norm)
      if (list) {
        const remaining = list.filter((l) => l.runId !== runId)
        if (remaining.length) this.leases.set(norm, remaining)
        else this.leases.delete(norm)
      }
    }

    this.runLeases.delete(runId)
  }

  private recordConflict(conflict: FileConflict): void {
    this.conflictLog.unshift(conflict)
    if (this.conflictLog.length > 50) this.conflictLog.pop()
  }

  /**
   * Get active files currently being touched across all active runs.
   */
  getActiveFiles(): FileLease[] {
    const out: FileLease[] = []
    for (const list of this.leases.values()) {
      out.push(...list)
    }
    return out
  }

  /**
   * Get recent conflict events.
   */
  getConflicts(): FileConflict[] {
    return [...this.conflictLog]
  }

  /**
   * Clear all leases (e.g. for test cleanup).
   */
  reset(): void {
    this.leases.clear()
    this.runLeases.clear()
    this.conflictLog = []
  }
}

export const concurrencyTracker = new ConcurrencyTracker()
