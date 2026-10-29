import { InkPen, newWork } from './inkPen'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { CaptureUpdateAction, Excalidraw, getCommonBounds } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, FileId } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { VIDEO_LINK, isVideoLink, type CanvasAssets } from '@galta/canvas'
import { themeColor, themeEasing, themeLength, themeTime } from '../design/theme'
import { cloneCanvasElement } from './cloneSnapshot'
import { documentEquals } from './documentEquality'
import { normalizeFreeDraw } from './freeDraw'
import { HTML_EMBED_LINK, HtmlEmbed, htmlDocument } from './htmlEmbed'
import { ObjectLabels } from './ObjectLabels'
import type { SceneSnapshot } from './sceneSnapshot'
import { readableDocument } from './historyTimeline'
import { touches } from './historyHit'
import { videoData } from './video'

/** The live editor's camera and box: client = (world + scroll) × zoom + offset. */
export type LiveView = { scrollX: number; scrollY: number; zoom: number; offsetLeft: number; offsetTop: number; width: number; height: number }
export type StageCamera = { scrollX: number; scrollY: number; zoom: number }
export type Bounds = { x: number; y: number; width: number; height: number }
export type HistoryStageHandle = {
  /** Glide the camera back to the live editor's. */
  fly(to: 'live', duration: number, easing: string): Promise<void>
  camera(): StageCamera
  /** Draw what the stage shows, transitions included, for a recording. */
  paint(context: CanvasRenderingContext2D): void
  /** Resolves once the pen has drawn the moment shown; at once without ink. */
  drawn(signal?: AbortSignal): Promise<void>
  finishDrawing(): void
  /** The stage's pixel size, for a recording. */
  size(): { width: number; height: number }
}

type Stage = { elements: ExcalidrawElement[]; files: BinaryFiles }

/**
 * Saved versions become the stage's own copies once. A copy is shared by every
 * version that holds the same object, so the engine's render caches carry from
 * version to version and a step repaints only what changed. The engine may
 * repair a copy's ordering index; saved artwork is never touched.
 */
class StageElements {
  private readonly copies = new WeakMap<object, ExcalidrawElement>()
  private readonly interned = new Map<string, { source: ExcalidrawElement; copy: ExcalidrawElement }[]>()
  get(source: ExcalidrawElement): ExcalidrawElement {
    let copy = this.copies.get(source)
    if (copy) return copy
    const key = `${source.id}:${source.version}:${source.versionNonce}`, candidates = this.interned.get(key) ?? []
    copy = candidates.find(candidate => documentEquals(candidate.source, source))?.copy
    if (!copy) {
      copy = stageCopy(source)
      candidates.push({ source, copy }); this.interned.set(key, candidates)
    }
    this.copies.set(source, copy)
    return copy
  }
}

/** A past video is its poster: the stage shows how the canvas looked, and a
 * recording needs every pixel on the engine's own canvas. */
function stageCopy(source: ExcalidrawElement): ExcalidrawElement {
  const video = videoData(source)
  if (video) return { ...cloneCanvasElement(source), type: 'image', fileId: video.posterId as FileId, status: 'saved', scale: [1, 1], crop: null, link: null, customData: {} } as ExcalidrawElement
  const copy = normalizeFreeDraw(cloneCanvasElement(source))
  return isVideoLink(copy.link) && copy.link !== VIDEO_LINK ? { ...copy, link: VIDEO_LINK } : copy
}

/** Fields a step may change for an object to glide between its two places. */
const GEOMETRY = new Set(['x', 'y', 'width', 'height', 'angle', 'version', 'versionNonce', 'updated', 'index'])
const GLIDES = new Set(['rectangle', 'ellipse', 'diamond', 'image', 'text', 'frame', 'magicframe', 'embeddable', 'iframe'])
const GLIDE_LIMIT = 40
/** The objects a step only moved, resized or turned, when that is all the
 * step changed; otherwise none, and the step dissolves instead. */
function glides(before: Stage, after: Stage): Map<string, ExcalidrawElement> | undefined {
  const previous = new Map(before.elements.map(element => [element.id, element])), moved = new Map<string, ExcalidrawElement>()
  if (before.elements.length !== after.elements.length) return undefined
  for (const element of after.elements) {
    const was = previous.get(element.id)
    if (!was) return undefined
    if (was === element) continue
    const a = was as unknown as Record<string, unknown>, b = element as unknown as Record<string, unknown>
    if (!GLIDES.has(element.type) || was.type !== element.type) return undefined
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!GEOMETRY.has(key) && !documentEquals(a[key], b[key])) return undefined
    moved.set(element.id, was)
    if (moved.size > GLIDE_LIMIT) return undefined
  }
  return moved.size ? moved : undefined
}

/** Whether a change is in view: all of it when it fits, else at least half. */
function seen(change: Bounds, view: Bounds, margin: number): boolean {
  const width = Math.max(0, Math.min(change.x + change.width, view.x + view.width - margin) - Math.max(change.x, view.x + margin))
  const height = Math.max(0, Math.min(change.y + change.height, view.y + view.height - margin) - Math.max(change.y, view.y + margin))
  const fits = change.width <= view.width - margin * 2 && change.height <= view.height - margin * 2
  const visible = width * height, area = Math.max(1, change.width * change.height)
  return fits ? visible >= area * .98 : visible >= area * .5
}
export function elementBounds(elements: readonly ExcalidrawElement[]): Bounds | null {
  if (!elements.length) return null
  const [x1, y1, x2, y2] = getCommonBounds(elements)
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

/**
 * Time Machine's stage is a read-only canvas laid exactly over the live one,
 * with its camera: opening changes no pixel, and the hands that move the
 * canvas move the past the same way. Each step repaints only what changed,
 * dissolving from the frame before; when a change happened out of view, the
 * camera makes the smallest move that shows it, and a light traces it once.
 */
export const HistoryStage = forwardRef<HistoryStageHandle, {
  /** The saved version shown, as `data-version` for its readers. */
  version: string
  snapshot: SceneSnapshot | undefined
  /** Where this moment changed the canvas: shown when it settles. */
  focus: Bounds | null
  /** Whether that change is lit once in view: a stepped moment is, a played
   * one only follows. */
  light: boolean
  /** Whose hands the light shows. */
  by: 'agent' | 'user'
  /** A settled step dissolves, follows and lights; a scrub only cuts. */
  settled: boolean
  label: string
  live: () => LiveView | undefined
  files: (assets: CanvasAssets) => BinaryFiles
  /** The parts of the stage the caption and controls cover. */
  insets: { top: number; bottom: number }
  selected: readonly string[]
  onSelect: (ids: string[], additive: boolean) => void
  onReady: () => void
}>(function HistoryStage({ version, snapshot, focus, light, by, settled, label, live, files, insets, selected, onSelect, onReady }, handle) {
  const [engine, setEngine] = useState<ExcalidrawImperativeAPI | null>(null)
  // The engine replaces its scene once when it finishes loading; the stage
  // starts showing artwork only after that.
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  useEffect(() => {
    if (!engine) return
    const loaded = () => { if (!engine.getAppState().isLoading) setApi(engine) }
    const stop = engine.onChange(loaded)
    loaded()
    return stop
  }, [engine])
  const [box, setBox] = useState(() => live())
  const host = useRef<HTMLDivElement>(null), fade = useRef<HTMLCanvasElement>(null)
  /** The pen that lands a step's new work, and whether that was all the step changed. */
  const pen = useRef<InkPen | undefined>(undefined), inked = useRef(false)
  const elements = useRef(new StageElements()), added = useRef(new Set<string>()), shown = useRef<Stage | undefined>(undefined)
  // A camera move that another replaces still completes: whoever awaits it
  // must never wait forever.
  const motion = useRef<{ frame: number; done(): void } | undefined>(undefined), following = useRef(Promise.resolve()), fading = useRef<Animation | undefined>(undefined), gliding = useRef(0)
  const [camera, setCamera] = useState<StageCamera>(() => box ? { scrollX: box.scrollX, scrollY: box.scrollY, zoom: box.zoom } : { scrollX: 0, scrollY: 0, zoom: 1 })
  const [mark, setMark] = useState<{ key: number; bounds: Bounds; by: 'agent' | 'user' } | null>(null)
  /** Why the shown version cannot be displayed, if it cannot. */
  const [failure, setFailure] = useState<string | null>(null)
  const ready = useRef(onReady), select = useRef(onSelect), liveRef = useRef(live)
  ready.current = onReady; select.current = onSelect; liveRef.current = live
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  const staticCanvas = () => host.current?.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.static') ?? null

  useEffect(() => () => {
    cancelAnimationFrame(gliding.current); fading.current?.cancel()
    if (motion.current) { cancelAnimationFrame(motion.current.frame); motion.current.done(); motion.current = undefined }
  }, [])

  useEffect(() => {
    if (!api) return
    const value = new InkPen(api, staticCanvas)
    pen.current = value
    return () => { value.dispose(); if (pen.current === value) pen.current = undefined }
  }, [api])

  // The stage keeps the live editor's box through resizes, read once the
  // live editor has measured its own new size.
  useEffect(() => {
    let frame = 0
    const resize = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { const next = liveRef.current(); if (next) setBox(next) }) }) }
    addEventListener('resize', resize)
    return () => { removeEventListener('resize', resize); cancelAnimationFrame(frame) }
  }, [])

  useEffect(() => {
    if (!api) return
    let frame = 0
    // The overlays follow the camera at most once per frame.
    const stop = api.onChange((_, state: AppState) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setCamera(current => current.scrollX === state.scrollX && current.scrollY === state.scrollY && current.zoom === state.zoom.value ? current : { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value }))
    })
    return () => { stop(); cancelAnimationFrame(frame) }
  }, [api])

  const move = (to: StageCamera, duration: number, easing: (t: number) => number) => new Promise<void>(resolve => {
    if (!api) { resolve(); return }
    if (motion.current) { cancelAnimationFrame(motion.current.frame); motion.current.done() }
    motion.current = undefined
    const s = api.getAppState(), from = { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value }, width = s.width, height = s.height
    if (duration <= 0 || reduced()) { api.updateScene({ appState: { scrollX: to.scrollX, scrollY: to.scrollY, zoom: { value: to.zoom as AppState['zoom']['value'] }, shouldCacheIgnoreZoom: false }, captureUpdate: CaptureUpdateAction.NEVER }); resolve(); return }
    // Interpolate the world point at the centre and zoom in log space, so a
    // move reads as one even push or pull rather than a swoop.
    const centre = (c: StageCamera) => ({ x: width / 2 / c.zoom - c.scrollX, y: height / 2 / c.zoom - c.scrollY })
    const a = centre(from), b = centre(to), start = performance.now()
    const current = { frame: 0, done: () => {
      // A pointer, replacement flight or unmount also ends cache reuse.
      if (host.current?.isConnected) api.updateScene({ appState: { shouldCacheIgnoreZoom: false }, captureUpdate: CaptureUpdateAction.NEVER })
      resolve()
    } }
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration), k = easing(t), zoom = from.zoom * (to.zoom / from.zoom) ** k
      const x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k
      // Follow native camera flights: reuse tiles while zooming, then finish
      // at the exact scale. Re-rasterizing every intermediate scale wastes
      // the frame on pixels the next frame immediately replaces.
      api.updateScene({ appState: { scrollX: width / 2 / zoom - x, scrollY: height / 2 / zoom - y, zoom: { value: zoom as AppState['zoom']['value'] }, shouldCacheIgnoreZoom: t < 1 }, captureUpdate: CaptureUpdateAction.NEVER })
      if (t < 1) current.frame = requestAnimationFrame(step)
      else { if (motion.current === current) motion.current = undefined; resolve() }
    }
    current.frame = requestAnimationFrame(step)
    motion.current = current
  })

  useImperativeHandle(handle, () => ({
    fly(_to, duration, easing) {
      const view = liveRef.current()
      return view ? move({ scrollX: view.scrollX, scrollY: view.scrollY, zoom: view.zoom }, duration, cubic(easing)) : Promise.resolve()
    },
    // A moment has landed when the camera shows its change and its ink is drawn.
    drawn(signal) { return Promise.all([following.current, pen.current?.drawn(signal)]).then(() => undefined) },
    finishDrawing() { pen.current?.finish() },
    camera() { const s = api?.getAppState(); return s ? { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value } : camera },
    paint(context) {
      const source = staticCanvas(), overlay = fade.current
      if (!source) return
      context.drawImage(source, 0, 0, context.canvas.width, context.canvas.height)
      const opacity = overlay ? Number(getComputedStyle(overlay).opacity) : 0
      // the dissolving frame carries its paper (on screen, history.css), so a recording gives it the paper's colour too
      if (overlay && opacity > 0) {
        context.globalAlpha = opacity; context.fillStyle = themeColor('background'); context.fillRect(0, 0, context.canvas.width, context.canvas.height)
        context.drawImage(overlay, 0, 0, context.canvas.width, context.canvas.height); context.globalAlpha = 1
      }
    },
    size() { const source = staticCanvas(); return { width: source?.width ?? 0, height: source?.height ?? 0 } }
  }), [api, camera])

  // Show the moment: a settled step dissolves from the frame before it.
  useEffect(() => {
    if (!api || !snapshot) return
    const first = !shown.current
    cancelAnimationFrame(gliding.current)
    // Any step ends the drawing of the one before.
    pen.current?.finish(); inked.current = false
    // A version that cannot be read or prepared shows its notice, never a
    // blank or stale canvas, and never takes the page down.
    const document = readableDocument(snapshot)
    let next: Stage | undefined
    try { if (document) next = { elements: document.elements.filter(element => !element.isDeleted).map(element => elements.current.get(element)), files: files(document.files) } }
    catch (error) {
      next = undefined
      console.warn('Time Machine could not show a version', { version, error: error instanceof Error ? error.message : String(error) })
    }
    if (!next) {
      setFailure(document ? 'This moment can’t be prepared. The rest of history is intact.' : 'This moment can’t be shown. The rest of history is intact.'); shown.current = { elements: [], files: {} }
      api.updateScene({ elements: [], captureUpdate: CaptureUpdateAction.NEVER })
      if (first) requestAnimationFrame(() => ready.current())
      return
    }
    setFailure(null)
    const previous = shown.current
    // A step that only moved objects glides them from where they were; any
    // other settled step dissolves from the frame before.
    const moved = !first && settled && !reduced() && previous ? glides(previous, next) : undefined
    const source = staticCanvas(), overlay = fade.current
    if (!moved && !first && settled && !reduced() && source && overlay && source.width) {
      overlay.width = source.width; overlay.height = source.height
      overlay.getContext('2d')!.drawImage(source, 0, 0)
      fading.current?.cancel()
      fading.current = overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: themeTime('--motion-history-dissolve'), easing: themeEasing('--ease-out'), fill: 'forwards' })
    }
    // A settled step's new work lands in turn, held back from the tiles before
    // the scene shows it.
    if (pen.current && settled && previous && !first) {
      const before = new Map(previous.elements.map(element => [element.id, element]))
      const added = next.elements.filter(element => !before.has(element.id)), taken = pen.current.draw(newWork(next.elements, before))
      inked.current = taken.size > 0 && next.elements.length - added.length === before.size
        && next.elements.every(element => taken.has(element.id) || before.get(element.id) === element)
    }
    shown.current = next
    if (moved) {
      const duration = Math.min(themeTime('--motion-history-move'), themeTime('--motion-history-step') * .9), easing = cubic(themeEasing('--ease-out')), start = performance.now()
      const frame = (now: number) => {
        const t = Math.min(1, (now - start) / duration), k = easing(t)
        api.updateScene({ elements: t < 1 ? next.elements.map(element => {
          const was = moved.get(element.id)
          if (!was) return element
          const mix = (a: number, b: number) => a + (b - a) * k
          return { ...element, x: mix(was.x, element.x), y: mix(was.y, element.y), width: mix(was.width, element.width), height: mix(was.height, element.height), angle: was.angle + (((element.angle - was.angle) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI) * k } as ExcalidrawElement
        }) : next.elements, captureUpdate: CaptureUpdateAction.NEVER })
        if (t < 1) gliding.current = requestAnimationFrame(frame)
      }
      gliding.current = requestAnimationFrame(frame)
    } else api.updateScene({ elements: next.elements, captureUpdate: CaptureUpdateAction.NEVER })
    // addFiles builds image caches for elements already in the scene.
    const fresh = Object.values(next.files).filter(file => !added.current.has(file.id))
    if (fresh.length) { api.addFiles(fresh); for (const file of fresh) added.current.add(file.id) }
    if (first) requestAnimationFrame(() => requestAnimationFrame(() => ready.current()))
  }, [api, snapshot])

  // A settled change out of view brings the camera the least way to it, then
  // lights it once.
  useEffect(() => {
    if (!api || !settled || !focus) { setMark(null); following.current = Promise.resolve(); return }
    setMark(null)
    const s = api.getAppState(), z = s.zoom.value, margin = themeLength('--space-8')
    const view = { x: -s.scrollX, y: -s.scrollY + insets.top / z, width: s.width / z, height: (s.height - insets.top - insets.bottom) / z }
    let target: StageCamera | undefined
    if (!seen(focus, view, margin / z)) {
      const room = { width: Math.max(1, view.width - margin * 2 / z), height: Math.max(1, view.height - margin * 2 / z) }
      // Keep the zoom unless the change cannot fit, and keep the view's centre
      // unless the change lies outside: the smallest move that shows it.
      const zoom = Math.max(.1, Math.min(z, z * room.width / Math.max(1, focus.width), z * room.height / Math.max(1, focus.height)))
      const w = s.width / zoom, h = (s.height - insets.top - insets.bottom) / zoom, m = margin / zoom
      const centre = { x: view.x + view.width / 2, y: view.y + view.height / 2 }
      const left = Math.min(Math.max(centre.x - w / 2, focus.x + focus.width + m - w), focus.x - m)
      const top = Math.min(Math.max(centre.y - h / 2, focus.y + focus.height + m - h), focus.y - m)
      target = { zoom, scrollX: -left, scrollY: -(top - insets.top / zoom) }
    }
    let cancelled = false
    // Where the pen landed all the step changed, the pen was its light.
    const shine = () => { if (!cancelled && light && !inked.current) setMark({ key: performance.now(), bounds: focus, by }) }
    following.current = target ? move(target, themeTime('--motion-history-follow'), cubic(themeEasing('--ease-sheet'))) : Promise.resolve()
    void following.current.then(shine)
    return () => { cancelled = true }
  }, [api, snapshot, settled, focus, light])

  // A click without a drag points at an object in the past; a drag pans.
  const down = useRef<{ x: number; y: number; t: number } | undefined>(undefined)
  const hit = (clientX: number, clientY: number): string[] => {
    const stage = shown.current, s = api?.getAppState()
    if (!stage || !s) return []
    const x = (clientX - s.offsetLeft) / s.zoom.value - s.scrollX, y = (clientY - s.offsetTop) / s.zoom.value - s.scrollY, reach = 6 / s.zoom.value
    const byId = new Map(stage.elements.map(element => [element.id, element]))
    for (let i = stage.elements.length - 1; i >= 0; i--) {
      let element = stage.elements[i]!
      if (!touches(element, x, y, reach)) continue
      const container = (element as { containerId?: string | null }).containerId
      if (container && byId.has(container)) element = byId.get(container)!
      const group = element.groupIds.at(-1)
      const members = group ? stage.elements.filter(other => other.groupIds.includes(group)) : [element]
      const ids = new Set(members.map(member => member.id))
      for (const member of stage.elements) {
        const owner = (member as { containerId?: string | null }).containerId
        if (owner && ids.has(owner) || member.frameId && ids.has(member.frameId)) ids.add(member.id)
      }
      return [...ids]
    }
    return []
  }
  const selection = elementBounds((shown.current?.elements ?? []).filter(element => selected.includes(element.id)))
  const screen = (b: Bounds) => box && { left: (b.x + camera.scrollX) * camera.zoom, top: (b.y + camera.scrollY) * camera.zoom, width: b.width * camera.zoom, height: b.height * camera.zoom }
  const pad = themeLength('--space-2')

  // The user's own hands take the camera from any move the stage is making.
  const letGo = () => { if (motion.current) { cancelAnimationFrame(motion.current.frame); motion.current.done(); motion.current = undefined } }

  return <div ref={host} className="history-canvas" role="img" aria-label={label} data-version={version} data-state={failure ? 'error' : api && shown.current ? 'ready' : 'loading'}
    style={box ? { left: box.offsetLeft, top: box.offsetTop, width: box.width, height: box.height } : undefined}
    // The engine's own menu would copy, select and change the past; here a
    // click points and Bring back takes.
    onContextMenuCapture={event => { event.preventDefault(); event.stopPropagation() }}
    onWheelCapture={letGo}
    // A hand on the stage also lands the step's work at once; the wheel only
    // moves the camera, as on the live canvas.
    onPointerDownCapture={() => { pen.current?.finish(); letGo() }}
    onPointerDown={event => { if (event.button === 0) down.current = { x: event.clientX, y: event.clientY, t: event.timeStamp } }}
    onPointerUp={event => {
      const start = down.current; down.current = undefined
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 || event.timeStamp - start.t > 600) return
      select.current(hit(event.clientX, event.clientY), event.shiftKey || event.metaKey)
    }}>
    <div className="history-engine">{box && <Excalidraw excalidrawAPI={setEngine} langCode="en" theme="light" zenModeEnabled viewModeEnabled
      initialData={{ appState: { viewBackgroundColor: 'transparent', scrollX: box.scrollX, scrollY: box.scrollY, zoom: { value: box.zoom as AppState['zoom']['value'] } } }}
      UIOptions={{ allowKeyboardShortcut: () => false, canvasActions: { changeViewBackgroundColor: false, clearCanvas: false, export: false, loadScene: false, saveToActiveFile: false, toggleTheme: false } }}
      validateEmbeddable={link => link === HTML_EMBED_LINK || isVideoLink(link) ? true : undefined}
      renderEmbeddable={element => { const document = htmlDocument(element); return document ? <HtmlEmbed html={document.html} /> : null }}
      // A link in the past never opens: not a new tab, and never in place of the page.
      onLinkOpen={(_, event) => event.preventDefault()} />}{api && host.current && <ObjectLabels api={api} root={host.current} />}</div>
    <canvas ref={fade} className="history-dissolve" aria-hidden="true" />
    {failure && <p className="history-unreadable" role="alert">{failure}</p>}
    <svg className="history-overlay" aria-hidden="true">
      {selection && (() => { const r = screen(selection)!; return <rect className="history-selection" x={r.left - pad} y={r.top - pad} width={r.width + pad * 2} height={r.height + pad * 2} /> })()}
      {mark && (() => {
        const r = screen(mark.bounds)!, width = r.width + pad * 2, height = r.height + pad * 2
        return <g key={mark.key} className={`history-mark history-mark-${mark.by}`} onAnimationEnd={event => { if (event.animationName === 'history-mark-life') setMark(null) }}>
          {mark.by === 'agent' && <rect className="history-mark-wash" x={r.left - pad} y={r.top - pad} width={width} height={height} pathLength="1000" />}
          <rect className="history-mark-line" x={r.left - pad} y={r.top - pad} width={width} height={height} pathLength="1000" />
        </g>
      })()}
    </svg>
  </div>
})

/** A CSS cubic-bezier as a function of time. */
function cubic(easing: string) {
  if (easing.trim() === 'linear') return (t: number) => t
  const match = /cubic-bezier\(([^)]+)\)/.exec(easing)
  if (!match) throw new Error(`Time Machine needs a cubic-bezier or linear easing token, not ${easing}`)
  const [x1, y1, x2, y2] = match[1]!.split(',').map(Number) as [number, number, number, number]
  return (t: number) => {
    let u = t
    for (let i = 0; i < 6; i++) {
      const x = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u ** 2 * x2 + u ** 3 - t
      const dx = 3 * (1 - u) ** 2 * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u ** 2 * (1 - x2)
      if (Math.abs(dx) < 1e-6) break
      u = Math.min(1, Math.max(0, u - x / dx))
    }
    return 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u ** 2 * y2 + u ** 3
  }
}
