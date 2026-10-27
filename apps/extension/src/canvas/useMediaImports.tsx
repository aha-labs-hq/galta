import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { LoaderCircle, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { prepareVideo, createVideoElement, replaceVideo, videoData } from './video'
import { MAX_VIDEO_BYTES, readResponseBlob, videoFile } from '@galta/canvas'
import { prepareImage, placeImage, replaceImage, type ImageReplacement } from './imageImport'
import type { ImageReference } from './referenceDrop'
import type { CanvasScene } from './scene'
import { useSceneSelection } from './useSceneSelection'

type ImportJob = { id: string; reference: ImageReference; point: { x: number; y: number }; replacement?: ImageReplacement; placed?: boolean; error?: string }
type ImportResult = { ok: true } | { ok: false; error: string }

/** A lease survives ordinary edits, but expires on history/workspace restore. */
export function useMediaImports(sceneRef: RefObject<CanvasScene | null>, onPlaced: (reference: ImageReference) => Promise<void>) {
  const [jobs, setJobs] = useState<ImportJob[]>([])
  const epoch = useRef(0)
  const controllers = useRef(new Map<string, AbortController>())
  const isPending = useCallback(() => controllers.current.size > 0, [])
  const cancel = useCallback(() => {
    epoch.current++
    const count = controllers.current.size
    for (const controller of controllers.current.values()) controller.abort()
    controllers.current.clear(); setJobs([])
    return count
  }, [])
  useEffect(() => () => { epoch.current++; for (const controller of controllers.current.values()) controller.abort(); controllers.current.clear() }, [])
  const start = useCallback(async (reference: ImageReference, point: { x: number; y: number }, replacement?: ImageReplacement): Promise<ImportResult> => {
    const scene = sceneRef.current
    if (!scene || scene.disposed) return { ok: false, error: 'The canvas is unavailable.' }
    const lease = epoch.current, id = crypto.randomUUID(), controller = new AbortController()
    controllers.current.set(id, controller)
    setJobs(jobs => [...jobs, { id, reference, point, ...(replacement ? { replacement } : {}) }])
    let placed = false
    try {
      const isVideo = reference.kind === 'video' || videoFile(reference.file?.name ?? reference.url.split('?')[0]!, reference.file?.type)
      if (replacement) {
        const old = scene.elements.find(el => el.id === replacement.id)
        if (!old || Boolean(videoData(old)) !== isVideo) throw new Error('Choose the same media type to replace this object.')
      }
      let place: () => void
      if (isVideo) {
        const response = reference.file ? null : await fetch(reference.url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) })
        if (response && !response.ok) throw new Error(`Unable to download video (${response.status})`)
        const prepared = await prepareVideo(reference.file ?? await readResponseBlob(response!, MAX_VIDEO_BYTES, 'Choose a video under 128 MB.'), reference.file?.name ?? new URL(reference.url).pathname.split('/').at(-1) ?? 'Video', controller.signal)
        const v = scene.viewport, scale = Math.min(1, 520 / prepared.video.width, 520 / prepared.video.height, v.width * .65 / prepared.video.width, v.height * .65 / prepared.video.height)
        const width = prepared.video.width * scale, height = prepared.video.height * scale
        const element = createVideoElement(prepared.video, { x: point.x - width / 2, y: point.y - height / 2, width, height }, reference.sourceUrl ? { sourceUrl: reference.sourceUrl } : {})
        place = () => replacement ? replaceVideo(scene, prepared, replacement) : scene.replace([...scene.elements, element], { ...scene.assets, ...prepared.files }, true, { selectedElementIds: { [element.id]: true } })
      } else {
        const image = await prepareImage(scene, reference, controller.signal)
        place = () => replacement ? replaceImage(scene, image, replacement) : void placeImage(scene, image, point)
      }
      if (lease !== epoch.current || sceneRef.current !== scene || scene.disposed) return { ok: false, error: 'The canvas changed before this import finished.' }
      controller.signal.throwIfAborted()
      place()
      placed = true
      await onPlaced(reference)
      if (lease === epoch.current) setJobs(jobs => jobs.filter(job => job.id !== id))
      return { ok: true }
    } catch (error) {
      const message = (placed ? `Media ${replacement ? 'replaced' : 'added'}, but not saved. ` : '') + (error instanceof Error ? error.message : 'Unable to load this media.')
      if (lease === epoch.current && !controller.signal.aborted) setJobs(jobs => jobs.map(job => job.id === id ? { ...job, placed, error: message } : job))
      return { ok: false, error: message }
    } finally { controllers.current.delete(id) }
  }, [sceneRef, onPlaced])
  const dismiss = (id: string) => setJobs(jobs => jobs.filter(job => job.id !== id))
  const retry = async (job: ImportJob): Promise<ImportResult> => {
    if (!job.placed) { dismiss(job.id); return start(job.reference, job.point, job.replacement) }
    const lease = epoch.current
    setJobs(jobs => jobs.map(item => { if (item.id !== job.id) return item; const { error: _, ...pending } = item; return pending }))
    try { await onPlaced(job.reference); if (lease === epoch.current) dismiss(job.id); return { ok: true } }
    catch (error) {
      const message = `Media ${job.replacement ? 'replaced' : 'added'}, but not saved. ${String(error)}`
      if (lease === epoch.current) setJobs(jobs => jobs.map(item => item.id === job.id ? { ...item, error: message } : item))
      return { ok: false, error: message }
    }
  }
  return { jobs, start, cancel, dismiss, retry, isPending }
}

export function ImportFeedback({ scene, imports }: { scene: CanvasScene; imports: ReturnType<typeof useMediaImports> }) {
  const { state } = useSceneSelection(scene)
  return <div className="pointer-events-none absolute inset-0 z-(--layer-context)" aria-label="Media imports">{imports.jobs.map(job => <div key={job.id} className="pending-image glass-surface absolute flex w-44 -translate-x-1/2 -translate-y-1/2 flex-wrap items-center gap-2 rounded-2xl p-3 text-xs" style={{ left: (job.point.x + state.scrollX) * state.zoom.value, top: (job.point.y + state.scrollY) * state.zoom.value }} role={job.error ? 'alert' : 'status'}>
    {job.error ? <><p className="w-full leading-relaxed text-destructive">{job.error}</p><div className="pointer-events-auto flex w-full justify-end gap-1">{(job.placed || job.reference.file || /^https?:/.test(job.reference.url)) && <Button variant="ghost" size="icon" aria-label={job.placed ? 'Retry saving media' : 'Retry media import'} onClick={() => void imports.retry(job)}><RotateCcw /></Button>}<Button variant="ghost" size="icon" aria-label="Dismiss media import" onClick={() => imports.dismiss(job.id)}><X /></Button></div></> : <><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{job.placed ? 'Saving media…' : job.replacement ? 'Replacing media…' : 'Adding media…'}</>}
  </div>)}</div>
}
