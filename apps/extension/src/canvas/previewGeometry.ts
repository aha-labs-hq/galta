import type { ExcalidrawElement, ExcalidrawFreeDrawElement } from '@excalidraw/excalidraw/element/types'

export type BrushRequest = { coordinates: Float64Array; pressures: Float64Array; simulatePressure: boolean; strokeWidth: number; lastCommittedPoint: boolean }

/** Private copies isolate native export from immutable saved artwork. Sharing
 * these copies across previews also lets moved strokes reuse their exact path. */
const copiedArrays = new WeakMap<object, number[] | number[][]>()
function copyArray<T extends readonly number[] | readonly (readonly number[])[]>(value: T): T {
  let copy = copiedArrays.get(value)
  if (!copy) { copy = value.map(item => Array.isArray(item) ? [...item] : item) as number[] | number[][]; copiedArrays.set(value, copy) }
  return copy as unknown as T
}
export function clonePreviewElement(element: ExcalidrawElement): ExcalidrawElement {
  if (!('points' in element)) return structuredClone(element)
  if (element.type === 'freedraw') {
    const { points, pressures, ...metadata } = element
    return { ...structuredClone(metadata), points: copyArray(points), pressures: copyArray(pressures) }
  }
  const { points, ...metadata } = element
  return { ...structuredClone(metadata), points: copyArray(points) }
}

/** One native outline algorithm, one worker, bounded derived-string cache.
 * Jobs are requested sequentially by the preview scheduler. Cancelling a job
 * terminates its computation; an actual worker failure is surfaced, not retried.
 */
class PreviewGeometry {
  private worker: Worker | undefined
  private failure?: Error
  private sequence = 0
  private readonly ids = new WeakMap<object, number>()
  private readonly paths = new Map<string, string>()
  private bytes = 0
  private id(value: object) { let id = this.ids.get(value); if (id === undefined) { id = ++this.sequence; this.ids.set(value, id) }; return id }

  async prepare(element: ExcalidrawFreeDrawElement, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (this.failure) throw this.failure
    const key = JSON.stringify([this.id(element.points), this.id(element.pressures), element.simulatePressure, element.strokeWidth, !!element.lastCommittedPoint])
    const cached = this.paths.get(key)
    if (cached !== undefined) { this.paths.delete(key); this.paths.set(key, cached); return cached }
    const coordinates = new Float64Array(element.points.length * 2)
    element.points.forEach(([x, y], i) => { coordinates[i * 2] = x; coordinates[i * 2 + 1] = y })
    const pressures = new Float64Array(element.pressures)
    const worker = this.worker ??= new Worker(new URL('./freeDrawPath.worker.ts', import.meta.url), { type: 'module', name: 'Canvas preview geometry' })
    const path = await new Promise<string>((resolve, reject) => {
      const finish = () => { signal.removeEventListener('abort', abort); worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null }
      const abort = () => { finish(); worker.terminate(); this.worker = undefined; reject(signal.reason) }
      const fail = (message: string) => { finish(); worker.terminate(); this.worker = undefined; this.failure = new Error(message); reject(this.failure) }
      signal.addEventListener('abort', abort, { once: true })
      worker.onmessage = ({ data }: MessageEvent<{ path?: string; error?: string }>) => {
        if (typeof data.path !== 'string') { fail(data.error ?? 'Invalid preview geometry response'); return }
        finish(); resolve(data.path)
      }
      worker.onerror = event => { event.preventDefault(); fail(event.message || 'Preview geometry worker failed') }
      worker.onmessageerror = () => fail('Unable to receive preview geometry')
      try { worker.postMessage({ coordinates, pressures, simulatePressure: element.simulatePressure, strokeWidth: element.strokeWidth, lastCommittedPoint: !!element.lastCommittedPoint } satisfies BrushRequest, [coordinates.buffer, pressures.buffer]) }
      catch (error) { fail(String(error)) }
    })
    signal.throwIfAborted()
    this.paths.set(key, path); this.bytes += path.length * 2
    while (this.bytes > 16 * 1024 * 1024 || this.paths.size > 4096) {
      const [oldest, value] = this.paths.entries().next().value!
      this.paths.delete(oldest); this.bytes -= value.length * 2
    }
    return path
  }
}
export const previewGeometry = new PreviewGeometry()
