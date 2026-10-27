import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { GENERATION_SETTINGS, MEDIA_PROVIDERS, MEDIA_KINDS, type MediaKind, type MediaProviderId, type MediaToolInput } from '../../packages/canvas/src/capabilities/media'
import { mediaProviders, orList } from './providers'
import { ProviderError, redact, type MediaProvider, type MediaRequest, type ModelInfo, type Prepared, type ProviderUpdate } from './providers/provider'
import { JobStore, alive, terminal, unresumable, type Job, type Row } from './jobs'
import { MediaKeys } from './keys'
import { openOutput, saveMedia } from './files'
import { resolveReferences } from './references'
import { modelNote } from './notes'
import { generationGuide } from './guide'
import { selfCommand } from '../launch'

const MAX_RUNNING = 4
const POLL_MS = 4000
/** How often a waiting call looks at a job someone else is carrying. */
const CHECK_MS = 250
/** Consecutive failed steps, or hours, after which a worker leaves a task for generation_get to resume. */
const WORKER_FAILURES = 15
const WORKER_HOURS = 2
/** Set on a galta-mcp started as a generation worker; its payload arrives on stdin. */
export const MEDIA_WORKER_ENV = 'GALTA_MEDIA_WORKER'
/** A pause that ends early when the call it serves is cancelled. */
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
  const timer = setTimeout(done, Math.max(0, ms))
  signal?.addEventListener('abort', done, { once: true })
})
const UNCERTAIN = 'The request may have been accepted, so it was not sent again.'

type GenerateInput = { image: MediaToolInput<'generate_image'>; video: MediaToolInput<'generate_video'>; speech: MediaToolInput<'generate_speech'> }

/**
 * Generation with the user's own provider accounts. A paid request is
 * submitted at most once per requestId; anything after that (polling,
 * downloading, waiting) can be repeated safely by any Galta process.
 *
 * The one step that cannot be repeated, sending the paid request, runs in a
 * detached worker that carries the job until its files are saved. The agent's
 * host may close or kill this process at any time (a panel closing, an
 * extension reloading); the worker is outside its reach, so a result the user
 * paid for is never lost with it.
 */
export class MediaGeneration {
  readonly providers: Record<MediaProviderId, MediaProvider>
  readonly keys: MediaKeys
  private readonly jobs: JobStore
  /** Work this process is doing for a job, keyed by job id. */
  private readonly working = new Map<string, Promise<void>>()
  private readonly polled = new Map<string, number>()

  /** The command that starts a worker, or none to carry requests in this process. */
  private readonly worker: readonly string[] | undefined

  /** A worker reaches providers itself, so with an injected fetch the work stays here unless a worker is named. */
  constructor(readonly directory: string, fetcher: typeof fetch = fetch, options: { worker?: readonly string[] } = {}) {
    this.worker = options.worker ?? (fetcher === fetch ? workerCommand() : undefined)
    this.providers = mediaProviders(fetcher)
    this.keys = new MediaKeys(directory)
    this.jobs = new JobStore(directory)
  }

  /** Where generated files go when no canvas execution is bound. */
  get files() { return join(this.directory, 'files') }

  /** Only connected providers are asked for models: an unconnected provider's
   * catalogue would cost the agent context for nothing it can use. */
  async models(filter: MediaToolInput<'generation_models'>) {
    const status = await this.keys.status()
    const connected = (id: MediaProviderId) => status.find(state => state.id === id)!.connected
    const providers = MEDIA_PROVIDERS.filter(provider => !filter.provider || provider.id === filter.provider)
    const models: ModelInfo[] = [], errors: { provider: MediaProviderId; error: string }[] = []
    await Promise.all(providers.filter(({ id }) => connected(id)).flatMap(({ id, kinds }) => kinds.filter(kind => !filter.kind || kind === filter.kind).map(async kind => {
      const key = await this.keys.key(id)
      try {
        for (const model of await this.providers[id].models(kind, key)) {
          const bestFor = modelNote(model.id)
          models.push({ ...model, ...(bestFor ? { bestFor } : {}) })
        }
      }
      catch (error) { errors.push({ provider: id, error: redact(message(error), key) }) }
    })))
    const query = filter.query?.toLowerCase()
    const order = (model: ModelInfo) => MEDIA_PROVIDERS.findIndex(provider => provider.id === model.provider) * MEDIA_KINDS.length + MEDIA_KINDS.indexOf(model.kind)
    const matching = models.filter(model => !query || `${model.name} ${model.id}`.toLowerCase().includes(query)).sort((a, b) => order(a) - order(b))
    return {
      providers: providers.map(({ id, name, kinds }) => ({ id, name, kinds, connected: connected(id) })),
      models: matching.slice(0, filter.limit),
      total: matching.length,
      ...(filter.kind ? { guide: generationGuide(filter.kind) } : {}),
      ...(errors.length ? { errors } : {})
    }
  }

  /** The provider named, or else the first connected one that makes this kind. */
  private async provider(kind: MediaKind, named: MediaProviderId | undefined): Promise<{ provider: MediaProvider; key: string }> {
    const status = await this.keys.status()
    const candidates = MEDIA_PROVIDERS.filter(provider => (provider.kinds as readonly MediaKind[]).includes(kind) && (!named || provider.id === named))
    const chosen = candidates.find(provider => status.some(state => state.id === provider.id && state.connected))
    const key = chosen && await this.keys.key(chosen.id)
    if (!chosen || !key) {
      const name = named ? MEDIA_PROVIDERS.find(provider => provider.id === named)!.name : orList(candidates.map(provider => provider.name))
      throw new Error(`Connect ${name} under ${GENERATION_SETTINGS} to generate ${kind === 'speech' ? 'speech' : `${kind}s`}. Never ask for the key in the conversation.`)
    }
    return { provider: this.providers[chosen.id], key }
  }

  async generate<Kind extends MediaKind>(kind: Kind, input: GenerateInput[Kind], directory: string, waitSeconds: number, signal?: AbortSignal): Promise<Job> {
    const { provider, key } = await this.provider(kind, input.provider)
    const request = await this.resolve({ kind, input } as MediaRequest)
    const prepared = await provider.prepare(request, key)
    const now = new Date().toISOString()
    const { job, fresh } = this.jobs.create({
      id: crypto.randomUUID(), requestId: input.requestId, fingerprint: fingerprint(provider.id, kind, prepared),
      kind, provider: provider.id, model: prepared.model, prompt: 'text' in input ? input.text : input.prompt,
      directory, status: 'running', files: [], createdAt: now, updatedAt: now
    }, MAX_RUNNING)
    if (fresh) this.begin(job, provider, prepared, key)
    // Images and speech usually finish within the wait. A video takes minutes,
    // so it returns as soon as the provider has its task.
    return this.wait(job.id, waitSeconds, kind === 'video' ? submitted => Boolean(submitted.taskId) : undefined, signal)
  }

  private async resolve(request: MediaRequest): Promise<MediaRequest> {
    if (request.kind === 'speech') return request
    if (request.kind === 'image') return { kind: 'image', input: { ...request.input, references: await resolveReferences(request.input.references) } }
    // Frames and references share one size budget, so resolve them together.
    const { firstFrame, lastFrame, references } = request.input
    const frames = [firstFrame, lastFrame].filter((value): value is string => Boolean(value))
    const resolved = await resolveReferences([...references, ...frames])
    const [first, last] = resolved.slice(references.length)
    return { kind: 'video', input: { ...request.input, references: resolved.slice(0, references.length), ...(firstFrame ? { firstFrame: first } : {}), ...(lastFrame ? { lastFrame: last } : {}) } }
  }

  /** Wait until the job finishes (or is `enough`), the time is up or the call is cancelled, advancing it on the way. */
  async wait(id: string, seconds: number, enough?: (job: Job) => boolean, signal?: AbortSignal): Promise<Job> {
    const deadline = Date.now() + seconds * 1000
    for (;;) {
      this.advance(this.jobs.get(id))
      const work = this.working.get(id)
      if (work && Date.now() < deadline && !signal?.aborted) await Promise.race([work, sleep(Math.min(CHECK_MS, deadline - Date.now()), signal)])
      const row = this.jobs.get(id), { job } = row
      if (terminal(job) || enough?.(job) || Date.now() >= deadline || signal?.aborted) return job
      // Another live process carrying it saves its progress as it goes; look often. Otherwise go at the provider's pace.
      const carried = row.owner !== null && row.owner !== process.pid && alive(row.owner)
      if (!this.working.has(id)) await sleep(Math.min(carried ? CHECK_MS : POLL_MS, deadline - Date.now()), signal)
    }
  }

  list(limit: number): Job[] {
    return this.jobs.list(limit).map(row => { this.settle(row); return this.jobs.get(row.job.id).job })
  }

  /** Start the next step for a job nobody is working on: download, poll, or settle. */
  private advance(row: Row) {
    const { job } = row
    if (terminal(job) || this.working.has(job.id) || (row.owner !== process.pid && alive(row.owner))) return
    if (unresumable(job)) return this.settle(row)
    if (!job.pending?.length && Date.now() - (this.polled.get(job.id) ?? 0) < POLL_MS) return
    if (!this.jobs.claim(row)) return
    this.work(job, async () => {
      const provider = this.providers[job.provider]
      const key = await this.keys.key(job.provider)
      if (!key) throw new Error(`Connect ${provider.name} under ${GENERATION_SETTINGS} to finish this generation; it resumes without paying again.`)
      await this.step(job, provider, key)
    })
  }

  /** Download what is ready, or ask the provider how the task is doing. Safe to repeat. */
  private async step(job: Job, provider: MediaProvider, key: string) {
    this.polled.set(job.id, Date.now())
    await this.apply(job, job.pending?.length ? { status: 'succeeded', outputs: job.pending.map(url => ({ url })) } : await provider.poll(job.taskId!, key), provider, key)
  }

  /** Hand a fresh paid job to a detached worker. Its payload goes on stdin,
   * never argv or env: it can carry 32 MB of references. When the worker is
   * gone, a job still ours and untouched was never sent (the worker could not
   * start, or ended before claiming it), so it is claimed and carried here. */
  private begin(job: Job, provider: MediaProvider, prepared: Prepared, key: string) {
    const here = () => this.work(job, () => this.submit(job, provider, prepared, key))
    if (!this.worker) return here()
    const [command, ...args] = this.worker
    const child = spawn(command!, args, { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, [MEDIA_WORKER_ENV]: '1' } })
    const gone = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()) })
    child.stdin!.on('error', () => undefined)
    child.stdin!.end(JSON.stringify({ directory: this.directory, job: job.id, prepared }))
    child.unref()
    this.working.set(job.id, gone.then(() => {
      this.working.delete(job.id)
      const row = this.jobs.get(job.id)
      if (row.owner === process.pid && unresumable(row.job) && this.jobs.claim(row)) here()
    }).catch(() => undefined))
  }

  /**
   * In a worker: claim the job the asking process created, send it once, and
   * carry it until its files are saved; a video through its task and download
   * too, so a finished one is kept even if nobody asks before its links
   * expire. A job anyone else has settled, or a payload that does not match
   * what was recorded, is left alone and nothing is sent.
   */
  async carry(id: string, prepared: Prepared) {
    const row = this.jobs.get(id), { job } = row
    if (!unresumable(job) || fingerprint(job.provider, job.kind, prepared) !== job.fingerprint || !this.jobs.claim(row)) return
    const provider = this.providers[job.provider]
    try {
      const key = await this.keys.key(job.provider)
      if (!key) { job.status = 'failed'; job.error = `Connect ${provider.name} under ${GENERATION_SETTINGS}; nothing was sent.`; return this.jobs.save(job) }
      const answer = await this.send(job, provider, prepared, key)
      if (!answer) return
      // The answer, then each later step: a failed download or poll is tried again, within bounds.
      const until = Date.now() + WORKER_HOURS * 3_600_000
      for (let failures = 0, next: ProviderUpdate | undefined = answer; ; next = undefined) {
        try { await (next ? this.apply(job, next, provider, key) : this.step(job, provider, key)); failures = 0 }
        catch (error) { failures++; job.error = redact(message(error), key); this.jobs.save(job) }
        if (job.status !== 'running' || !(job.taskId || job.pending?.length) || failures >= WORKER_FAILURES || Date.now() > until) break
        await sleep(POLL_MS)
      }
      // An answer with no task and nothing kept leaves nothing to resume.
      if (unresumable(job)) { job.status = 'failed'; job.error ??= 'The provider answered without a task or files to keep.'; this.jobs.save(job) }
    } catch (error) {
      if (unresumable(job)) job.status = 'failed'
      job.error = redact(message(error), undefined)
      this.jobs.save(job)
    } finally { this.jobs.release(job.id) }
  }

  /** A job whose submitting process is gone, with no task to resume from. */
  private settle(row: Row) {
    if (!unresumable(row.job) || alive(row.owner) || !this.jobs.claim(row)) return
    try {
      row.job.status = 'interrupted'
      row.job.error = `Galta stopped before the provider answered. ${UNCERTAIN}`
      this.jobs.save(row.job)
    } finally { this.jobs.release(row.job.id) }
  }

  private work(job: Job, step: () => Promise<void>) {
    const done = step()
      .catch(error => {
        // The provider answered but the output could not be kept: nothing left to resume.
        if (unresumable(job)) job.status = 'failed'
        job.error = redact(message(error), undefined)
        this.jobs.save(job)
      })
      .finally(() => { this.jobs.release(job.id); this.working.delete(job.id) })
      .catch(() => undefined)
    this.working.set(job.id, done)
  }

  private async submit(job: Job, provider: MediaProvider, prepared: Prepared, key: string) {
    const answer = await this.send(job, provider, prepared, key)
    if (answer) await this.apply(job, answer, provider, key)
  }

  /** Send the paid request, once. A refusal charged nothing; a lost answer may have been accepted, so it is never resent. */
  private async send(job: Job, provider: MediaProvider, prepared: Prepared, key: string): Promise<ProviderUpdate | undefined> {
    try { return await provider.submit(job.kind, prepared, key) }
    catch (error) {
      const refused = error instanceof ProviderError && error.refused
      job.status = refused ? 'failed' : 'interrupted'
      job.error = refused ? redact(message(error), key) : `${redact(message(error), key)}. ${UNCERTAIN}`
      this.jobs.save(job)
      return undefined
    }
  }

  private async apply(job: Job, update: ProviderUpdate, provider: MediaProvider, key: string) {
    delete job.error
    if (update.status === 'failed') { job.status = 'failed'; job.error = update.error; return this.jobs.save(job) }
    if (update.status === 'running') {
      if (update.taskId) job.taskId = update.taskId
      if (update.progress !== undefined) job.progress = Math.max(0, Math.min(100, update.progress))
      return this.jobs.save(job)
    }
    const urls = update.outputs.flatMap(output => 'url' in output ? [output.url] : [])
    if (urls.length) { job.pending = urls; this.jobs.save(job) }
    for (const [index, output] of update.outputs.entries()) {
      if (index < job.files.length) continue
      const stem = `${job.kind}-${job.id.slice(0, 8)}${index ? `-${index + 1}` : ''}`
      const source = 'bytes' in output ? output.bytes : await openOutput(output.url, url => provider.open(url, key))
      job.files.push(await saveMedia(job.directory, stem, job.kind, source))
      this.jobs.save(job)
    }
    job.status = 'succeeded'
    delete job.pending; delete job.progress
    this.jobs.save(job)
  }

  /** Resolves once the work this process started, a handed-off job included, has settled. */
  async idle() { while (this.working.size) await Promise.all(this.working.values()) }

  close() { this.jobs.close() }
}

/** A worker is this MCP started again: the same executable and role when
 * compiled, or Bun and the MCP entry from source. */
function workerCommand(): string[] {
  return selfCommand ?? [process.execPath, join(import.meta.dir, '..', 'mcp', 'main.ts')]
}

function fingerprint(provider: MediaProviderId, kind: MediaKind, prepared: Prepared) {
  return createHash('sha256').update(JSON.stringify({ provider, kind, prepared })).digest('hex')
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
