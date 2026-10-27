import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MediaKind, MediaProviderId } from '../../packages/canvas/src/capabilities/media'
import type { MediaFile } from './files'

export type JobStatus = 'running' | 'succeeded' | 'failed' | 'interrupted'
export type Job = {
  id: string; requestId: string; fingerprint: string
  kind: MediaKind; provider: MediaProviderId; model: string; prompt: string
  /** Where the outputs are written: the execution workspace's outputs, or Galta's own media files. */
  directory: string
  status: JobStatus
  /** The provider's task, once it has accepted one. A job with a task can always be resumed. */
  taskId?: string
  /** Finished outputs not yet downloaded. Saved before downloading so a failed download resumes. */
  pending?: string[]
  files: MediaFile[]
  progress?: number
  error?: string
  createdAt: string; updatedAt: string
}
export type Row = { job: Job; owner: number | null; version: number }

export const terminal = (job: Job) => job.status !== 'running'
/** Running with nothing to resume from: only the process that submitted it can finish it. */
export const unresumable = (job: Job) => job.status === 'running' && !job.taskId && !job.pending?.length

export function alive(pid: number | null): boolean {
  if (!pid) return false
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * One table shared by every Galta MCP process of this OS user, so Codex and
 * other agents see the same generations. A process owns a job while it talks
 * to the provider about it; ownership is taken with a version check, so two
 * processes never download the same output or overwrite each other.
 */
export class JobStore {
  private readonly db: Database
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, 'jobs.sqlite')
    this.db = new Database(file, { create: true, strict: true })
    chmodSync(file, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, owner INTEGER, version INTEGER NOT NULL, data TEXT NOT NULL)')
  }

  private row(value: { data: string; owner: number | null; version: number } | null): Row | undefined {
    return value ? { job: JSON.parse(value.data), owner: value.owner, version: value.version } : undefined
  }

  get(id: string): Row {
    const row = this.row(this.db.query<{ data: string; owner: number | null; version: number }, [string]>('SELECT data, owner, version FROM jobs WHERE id = ?').get(id))
    if (!row) throw new Error(`No generation ${id}`)
    return row
  }

  list(limit: number): Row[] {
    return this.db.query<{ data: string; owner: number | null; version: number }, [number]>('SELECT data, owner, version FROM jobs ORDER BY rowid DESC LIMIT ?').all(limit).map(row => this.row(row)!)
  }

  /** Create the job for a requestId, or return the one that already has it. */
  create(job: Job, maxRunning: number): { job: Job; fresh: boolean } {
    return this.db.transaction(() => {
      const existing = this.row(this.db.query<{ data: string; owner: number | null; version: number }, [string]>('SELECT data, owner, version FROM jobs WHERE request_id = ?').get(job.requestId))
      if (existing) {
        if (existing.job.fingerprint !== job.fingerprint) throw new Error('This requestId belongs to a different request. Use a new requestId for a new generation.')
        return { job: existing.job, fresh: false }
      }
      const running = this.db.query<{ data: string; owner: number | null; version: number }, []>("SELECT data, owner, version FROM jobs WHERE status = 'running'").all().map(row => this.row(row)!)
      if (running.filter(row => !unresumable(row.job) || alive(row.owner)).length >= maxRunning) {
        throw new Error(`${maxRunning} generations are already running. Wait for one with generation_get before starting another.`)
      }
      this.db.query('INSERT INTO jobs (id, request_id, status, owner, version, data) VALUES (?, ?, ?, ?, 1, ?)').run(job.id, job.requestId, job.status, process.pid, JSON.stringify(job))
      return { job, fresh: true }
    }).immediate()
  }

  /** Take ownership of the version that was read; fails if anything changed since. */
  claim(row: Row): boolean {
    return this.db.query('UPDATE jobs SET owner = ?, version = version + 1 WHERE id = ? AND version = ?').run(process.pid, row.job.id, row.version).changes === 1
  }

  save(job: Job) {
    job.updatedAt = new Date().toISOString()
    const result = this.db.query('UPDATE jobs SET status = ?, data = ?, version = version + 1 WHERE id = ? AND owner = ?').run(job.status, JSON.stringify(job), job.id, process.pid)
    if (result.changes !== 1) throw new Error(`Generation ${job.id} is being handled by another Galta process`)
  }

  release(id: string) {
    this.db.query('UPDATE jobs SET owner = NULL, version = version + 1 WHERE id = ? AND owner = ?').run(id, process.pid)
  }

  close() { this.db.close() }
}
