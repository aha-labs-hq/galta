import { exportToCanvas } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, ExcalidrawFreeDrawElement } from '@excalidraw/excalidraw/element/types'
import { themeColor } from '../design/theme'
import { CanvasWork } from './canvasWork'
import { clonePreviewElement, previewGeometry } from './previewGeometry'
import { validateSnapshot } from './scene'
import { workspaceRepository } from './workspace'
import { AssetURLs } from '@galta/canvas'
import { withPosters } from './htmlPoster'
import { editorFiles } from './video'
import { snapshotReference } from '@galta/storage'

type Bitmap = HTMLCanvasElement | null
type CachedFrame = { bitmap: Bitmap; persisted: Promise<void>; pending?: Job }
type Job = {
  key: string; identity: string; snapshot: unknown; background: string
  users: Map<symbol, number>; bitmapUsers: Set<symbol>; abort: AbortController; promise: Promise<Bitmap>
  resolve(value: Bitmap): void; reject(error: unknown): void
  persisted: Promise<void>; saved(): void; failSave(error: unknown): void
}
const priority = (job: Job) => Math.min(...job.users.values())
const copy = (source: Bitmap, size: number): Bitmap => {
  if (!source) return null
  const scale = Math.min(1, size / Math.max(source.width, source.height)), canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(source.width * scale)); canvas.height = Math.max(1, Math.round(source.height * scale))
  const context = canvas.getContext('2d')!
  context.imageSmoothingQuality = 'high'; context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

/** Lossless preview frames of saved versions, such as the canvas picker's
 * thumbnails. Disk owns the disposable PNGs; this queue owns cold rendering
 * and a 32 MiB decoded cache.
 * Consumers receive their own bitmap. Preview work never edits document state.
 */
class CanvasPreviews {
  private readonly cache = new Map<string, CachedFrame>()
  private readonly jobs = new Map<string, Job>()
  private readonly queue = new Set<Job>()
  private bytes = 0
  private running = false
  private readonly persistence = new Map<Job, () => Promise<void>>()
  private writing = false
  private persisting: Job | undefined

  private activityAt = 0
  private readonly wake = new Set<() => void>()
  constructor() {
    const active = () => { this.activityAt = performance.now() }
    for (const event of ['pointerdown', 'pointermove', 'wheel', 'keydown']) window.addEventListener(event, active, { capture: true, passive: true })
  }

  private async idle(job: Job) {
    // Background preparation may consume idle time, never the user's gesture.
    // A selected frame wakes this wait immediately and takes over the queue.
    while (priority(job) === 2 && !this.next(2)) {
      job.abort.signal.throwIfAborted()
      const quiet = performance.now() - this.activityAt >= 120
      const available = await new Promise<boolean>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined, idle: number | undefined
        const finish = (available = false) => {
          if (timer !== undefined) clearTimeout(timer)
          if (idle !== undefined) cancelIdleCallback(idle)
          this.wake.delete(wake); job.abort.signal.removeEventListener('abort', wake); resolve(available)
        }
        const wake = () => finish()
        this.wake.add(wake); job.abort.signal.addEventListener('abort', wake, { once: true })
        if (quiet) idle = requestIdleCallback(deadline => finish(deadline.timeRemaining() >= 5))
        else timer = setTimeout(wake, Math.max(1, 120 - (performance.now() - this.activityAt)))
      })
      if (available && performance.now() - this.activityAt >= 120) return
    }
  }

  acquire(identity: string, snapshot: unknown, size: number, importance = 0) {
    return this.request(identity, snapshot, importance, true, bitmap => copy(bitmap, size))
  }

  private request(identity: string, snapshot: unknown, importance: number, bitmapNeeded: boolean, project: (bitmap: Bitmap) => Bitmap) {
    const background = themeColor('background'), key = JSON.stringify([identity, background])
    if (this.cache.has(key)) {
      const frame = this.cache.get(key)!
      this.cache.delete(key); this.cache.set(key, frame)
      if (!frame.pending) return { promise: Promise.resolve(project(frame.bitmap)), persisted: frame.persisted, release() {} }
    }
    let job = this.jobs.get(key)
    if (!job || job.abort.signal.aborted) {
      let resolve!: Job['resolve'], reject!: Job['reject']
      const promise = new Promise<Bitmap>((yes, no) => { resolve = yes; reject = no })
      let saved!: () => void, failSave!: (error: unknown) => void
      const persisted = new Promise<void>((yes, no) => { saved = yes; failSave = no })
      // The service reports failures once. Consumers may await either phase;
      // the unobserved phase must not produce an unhandled rejection.
      void promise.catch(() => {}); void persisted.catch(() => {})
      job = { key, identity, snapshot, background, users: new Map(), bitmapUsers: new Set(), abort: new AbortController(), promise, resolve, reject, persisted, saved, failSave }
      const created = job
      created.abort.signal.addEventListener('abort', () => {
        if (this.persisting !== created && this.persistence.delete(created)) this.fail(created, created.abort.signal.reason, 'persist')
      }, { once: true })
      this.jobs.set(key, job); this.queue.add(job)
      queueMicrotask(() => { void this.drain() })
    }
    const token = Symbol(), request = job
    request.users.set(token, importance)
    if (bitmapNeeded) request.bitmapUsers.add(token)
    if (importance < 2) for (const wake of this.wake) wake()
    let owner: Job | undefined = request, released = false
    void request.persisted.then(() => { owner = undefined }, () => { owner = undefined })
    const promise = request.promise.then(bitmap => released ? null : project(bitmap))
    return { promise, persisted: request.persisted, release() {
      if (released) return
      released = true
      owner?.users.delete(token); owner?.bitmapUsers.delete(token)
      if (owner && !owner.users.size) owner.abort.abort(new DOMException('Preview no longer needed', 'AbortError'))
    } }
  }

  private forget(key: string) {
    const frame = this.cache.get(key)
    this.cache.delete(key)
    if (!frame) return
    if (frame.bitmap) {
      this.bytes -= frame.bitmap.width * frame.bitmap.height * 4
      // The one active encoder owns its source until completion. Queued
      // encoders borrow cache entries and cannot pin an unbounded backlog.
      if (!frame.pending || this.persisting !== frame.pending) frame.bitmap.width = frame.bitmap.height = 0
    }
    if (frame.pending && this.persisting !== frame.pending && this.persistence.has(frame.pending)) frame.pending.abort.abort(new DOMException('Preview cache budget reclaimed', 'AbortError'))
  }

  private remember(job: Job, bitmap: Bitmap) {
    this.forget(job.key)
    this.cache.set(job.key, { bitmap, persisted: job.persisted, pending: job }); this.bytes += bitmap ? bitmap.width * bitmap.height * 4 : 0
    while (this.bytes > 32 * 1024 * 1024 || this.cache.size > 256) {
      this.forget(this.cache.keys().next().value!)
    }
  }

  private next(before = Infinity) {
    let next: Job | undefined, best = before
    for (const job of this.queue) {
      if (job.abort.signal.aborted) return job
      const rank = priority(job)
      if (rank < best) { next = job; best = rank }
    }
    return next
  }

  private async render(job: Job): Promise<{ bitmap?: Bitmap; blob?: Blob; persist?: () => Promise<void> }> {
    const work = new CanvasWork(job.abort.signal)
    let idleAt = 0
    const checkpoint = async () => {
      await work.checkpoint()
      if (priority(job) === 2 && performance.now() >= idleAt) { await this.idle(job); idleAt = performance.now() + 4 }
      // A selected frame preempts thumbnails and background preparation at the
      // same native checkpoints. At most one job per priority can be suspended.
      let urgent: Job | undefined
      while ((urgent = this.next(priority(job)))) await this.run(urgent)
      work.check()
    }
    const [projectId, commitId, reference, elementId] = JSON.parse(job.identity) as [string, string, string | null, string | null]
    if (!reference) throw new Error('This saved canvas preview has no persisted snapshot.')
    const appearance = JSON.stringify(['native-png-3', job.background, elementId])
    const stored = await workspaceRepository.readPreview(projectId, commitId, appearance)
    if (stored.snapshotRef !== reference) throw new Error('This saved canvas changed before its preview was rendered.')
    await checkpoint()
    if (stored.blob) {
      return stored.empty ? { bitmap: null } : { blob: stored.blob }
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0)); await checkpoint()
    const { document } = validateSnapshot(job.snapshot), elements: ExcalidrawElement[] = []
    for (const element of document.elements) {
      await checkpoint()
      if (!element.isDeleted) elements.push(clonePreviewElement(element))
    }
    // Empty frames are real history too, represented by the same background.
    let canvas: HTMLCanvasElement
    if (elements.length) { const urls = new AssetURLs(); try { canvas = await exportToCanvas({ ...await withPosters(elements, editorFiles(document.files, urls)),
      appState: { exportBackground: true, viewBackgroundColor: job.background, exportWithDarkMode: false },
      exportPadding: 24, maxWidthOrHeight: 1400, checkpoint, prepareFreeDraw: (element: ExcalidrawFreeDrawElement) => previewGeometry.prepare(element, job.abort.signal) }) } finally { urls.release() } }
    else { canvas = window.document.createElement('canvas'); canvas.width = canvas.height = 1; const context = canvas.getContext('2d')!; context.fillStyle = job.background; context.fillRect(0, 0, 1, 1) }
    work.check()
    return { bitmap: elements.length ? canvas : null, persist: async () => {
      try {
        work.check()
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Unable to encode canvas preview')), 'image/png'))
        work.check()
        if (!await workspaceRepository.savePreview(projectId, commitId, appearance, stored.snapshotRef, blob, !elements.length)) throw new Error('The saved canvas changed while its preview was rendering.')
        work.check()
      } finally { if (!elements.length) canvas.width = canvas.height = 0 }
    } }
  }

  private async run(job: Job) {
    this.queue.delete(job)
    try {
      job.abort.signal.throwIfAborted()
      const frame = await this.render(job)
      if (frame.blob && job.bitmapUsers.size > 0) {
        const image = await createImageBitmap(frame.blob)
        try {
          job.abort.signal.throwIfAborted()
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
          canvas.getContext('2d')!.drawImage(image, 0, 0); frame.bitmap = canvas
        } finally { image.close() }
      }
      if (frame.bitmap !== undefined) this.remember(job, frame.bitmap)
      job.resolve(frame.bitmap ?? null)
      if (frame.persist) {
        this.persistence.set(job, frame.persist)
        void this.drainPersistence()
      } else {
        job.saved(); this.finish(job)
      }
    } catch (error) { this.fail(job, error, 'render') }
  }

  private finish(job: Job) {
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key)
    const frame = this.cache.get(job.key)
    if (frame?.pending === job) delete frame.pending
  }

  private fail(job: Job, error: unknown, phase: 'render' | 'persist') {
    job.reject(error); job.failSave(error)
    if (job.abort.signal.aborted) {
      if (this.cache.get(job.key)?.pending === job) this.forget(job.key)
    } else {
      const [projectId, commitId] = JSON.parse(job.identity)
      console.warn('Canvas preview unavailable', { projectId, commitId, phase, error: String(error) })
    }
    this.finish(job)
  }

  private async drainPersistence() {
    if (this.writing) return
    this.writing = true
    try {
      while (this.persistence.size) {
        let next: Job | undefined, best = Infinity
        for (const job of this.persistence.keys()) if (priority(job) < best) { next = job; best = priority(job) }
        const job = next!, persist = this.persistence.get(job)!, bitmap = this.cache.get(job.key)?.bitmap
        this.persistence.delete(job); this.persisting = job
        try {
          // Delivery and persistence have separate completion boundaries.
          // A slow cache write cannot block rendering the next selected frame.
          await new Promise<void>(resolve => setTimeout(resolve, 0))
          await persist(); job.saved(); this.finish(job)
        } catch (error) { this.fail(job, error, 'persist') }
        finally {
          if (bitmap && this.cache.get(job.key)?.bitmap !== bitmap) bitmap.width = bitmap.height = 0
          this.persisting = undefined
        }
      }
    } finally { this.writing = false }
  }

  private async drain() {
    if (this.running) return
    this.running = true
    try { let job: Job | undefined; while ((job = this.next())) await this.run(job) }
    finally { this.running = false }
  }
}

export const canvasPreviews = new CanvasPreviews()
export const previewIdentity = (projectId: string, commitId: string, snapshot: unknown, elementId?: string) => JSON.stringify([projectId, commitId, snapshotReference(snapshot), elementId])
