import { CaptureUpdateAction, getCommonBounds, prepareFreeDrawElement, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { VIDEO_LINK, normalizeAsset, normalizeAssets, AssetURLs, type CanvasAssets } from '@galta/canvas'
import { videoData, editorFiles } from './video'
import { inRegion, type CanvasRegion } from './observation'
import { refreshRelationships } from './relationships'
import { normalizeFreeDraw } from './freeDraw'
import { InkPresentation } from './inkPen'
import { CanvasWork } from './canvasWork'
import { flightPath, MAX_ZOOM, MIN_ZOOM, type CanvasView } from './flight'
import { themeTime } from '../design/theme'
import { cloneCanvasElement, cloneCanvasSnapshot, rememberSavedElement, saveCanvasSnapshot } from './cloneSnapshot'
import { documentEquals } from './documentEquality'
import { prepareToolSnapshot, renderToolPreview, type PreviewOverlay } from './toolScene'

import { sceneDocument, validateSnapshot, type SceneSnapshot } from './sceneSnapshot'
export { sceneDocument, validateSnapshot, type SceneSnapshot } from './sceneSnapshot'

export type CanvasFrame = { left: number; top: number; width: number; height: number }
/** The editor's copy of a restored element. Until the editor changes it, a
 * capture is history's own object, so a new version shares it by identity. */
function restored(copy: ExcalidrawElement, saved: ExcalidrawElement) {
  const ready = normalizeFreeDraw(copy)
  rememberSavedElement(saved, ready === copy ? copy : undefined)
  return ready
}
function documentStamp(document: SceneSnapshot['document']): string {
  return document.elements.map(el => `${el.id}:${el.version}:${el.versionNonce}:${el.isDeleted}:${el.index}`).join('|')
}

/** Excalidraw is the sole live-state owner. This boundary owns snapshots,
 * programmatic edits and their persistence provenance, not a second editor. */
export class CanvasScene {
  // System ink uses the real editor, but never becomes a document merely by
  // being displayed or edited. Ownership is by installed identity, not metadata
  // copied from a file. Native duplication gives the copy a new, user-owned ID.
  private guideIds = new Set<string>()
  private guideActive = false
  isGuideElement = (id: string) => this.guideIds.has(id)
  get hasGuide() { return this.guideActive }
  private artwork(elements: readonly ExcalidrawElement[]) { return this.guideIds.size ? elements.filter(el => !this.isGuideElement(el.id)) : elements }
  showGuide(elements: readonly ExcalidrawElement[]) {
    if (this.disposed || this.elements.length) return
    for (const el of elements) this.guideIds.add(el.id)
    this.guideActive = true
    this.api.updateScene({ elements: [...this.artwork(this.api.getSceneElementsIncludingDeleted()), ...elements], captureUpdate: CaptureUpdateAction.NEVER })
  }
  dismissGuide() {
    this.guideActive = false
    if (this.disposed) return
    const current = this.api.getSceneElementsIncludingDeleted(), elements = this.artwork(current)
    if (current.length === elements.length) return
    const state = this.api.getAppState()
    this.api.updateScene({ elements, appState: {
      selectedElementIds: Object.fromEntries(Object.entries(state.selectedElementIds).filter(([id]) => !this.isGuideElement(id))),
      selectedGroupIds: {}, editingGroupId: null,
      editingTextElement: state.editingTextElement && this.isGuideElement(state.editingTextElement.id) ? null : state.editingTextElement
    }, captureUpdate: CaptureUpdateAction.NEVER })
    // Only guide experiments existed. The first real drawing gets a fresh undo
    // stack; clearing a guide must never erase an existing artwork's history.
    if (!elements.length) this.api.history.clear()
  }
  private readonly urls = new AssetURLs()
  private resources: CanvasAssets = {}
  private closed = false
  private zoomPreparation: AbortController | undefined
  private zoomTimer: ReturnType<typeof setTimeout> | undefined
  get disposed() { return this.closed }
  set disposed(value: boolean) {
    this.closed = value
    if (value) { this.urls.release(); this.resources = {}; this.zoomPreparation?.abort(); clearTimeout(this.zoomTimer); this.presentation?.dispose() }
  }
  restorationVersion = 0
  private observed = ''
  private observedFiles = new Map<string, string>()
  private restoredDocument: { saved: SceneSnapshot['document']; applied: string; files: CanvasAssets } | undefined
  private presentation?: InkPresentation
  private seen: (() => CanvasFrame) | undefined
  /** `editor` holds the engine. A scene without one presents nothing. */
  constructor(readonly api: ExcalidrawImperativeAPI, editor?: HTMLElement) {
    if (editor) this.presentation = new InkPresentation(api, editor)
  }
  /** Land an edit's new work in turn. Presentation never decides an edit: if
   * it fails, everything committed shows at once. */
  private present(elements: readonly ExcalidrawElement[], previous: { has(id: string): boolean }, work: CanvasWork) {
    try { this.presentation?.show(elements, previous, this.surface, work) }
    catch (error) {
      console.error('Galta canvas presentation failed; showing committed content', error)
      this.clearPresentation()
    }
  }
  /** Land everything being presented at once. */
  clearPresentation() { this.presentation?.clear() }
  /** Fill the editor's own brush caches cooperatively before its atomic swap.
   * Keep the exact prepared objects: these caches are keyed by element identity. */
  async prepareRender(elements: readonly ExcalidrawElement[], work: CanvasWork, view = this.surface, appState?: AppState) {
    const map = new Map(elements.map(el => [el.id, el]))
    for (const el of elements) {
      await work.checkpoint()
      if (this.disposed) throw new Error('The canvas has been closed')
      if (el.isDeleted || el.type !== 'freedraw') continue
      const [x1, y1, x2, y2] = getCommonBounds([el]), v = view
      const padding = el.strokeWidth * 4.25
      if (x2 + padding < v.x || y2 + padding < v.y || x1 - padding > v.x + v.width || y1 - padding > v.y + v.height) continue
      prepareFreeDrawElement(el, map, appState ?? this.api.getAppState())
    }
  }
  get elements() { return this.artwork(this.api.getSceneElements()) }
  get visibleElements() { return inRegion(this.elements, this.surface) }
  get selectedIds() { return Object.keys(this.api.getAppState().selectedElementIds).filter(id => this.api.getAppState().selectedElementIds[id] && !this.isGuideElement(id)) }
  get selected() { const ids = new Set(this.selectedIds); return this.elements.filter(el => ids.has(el.id)) }
  get files() { return this.api.getFiles() }
  asset(id: string) { const file = this.files[id] ?? this.resources[id]; return file ? normalizeAsset(file) : undefined }
  get assets(): CanvasAssets { return { ...this.resources, ...normalizeAssets(this.files) } }
  importAssets(files: CanvasAssets) {
    const normalized = normalizeAssets(files)
    this.resources = { ...this.resources, ...normalized }
    return editorFiles(normalized, this.urls)
  }
  /** Image files for another view of this canvas, such as Time Machine. They
   * share this scene's URLs, so each image decodes once. */
  editorFiles(files: CanvasAssets): BinaryFiles { return editorFiles(files, this.urls) }
  /** The view tells the scene which part of the editor its reader can see
   * (visibleCanvasFrame). Without one, as in a bare editor, all of it. */
  seenThrough(frame: () => CanvasFrame) {
    this.seen = frame
    return () => { if (this.seen === frame) this.seen = undefined }
  }
  /** The part of the canvas the reader can see, in scene units. Agent work and
   * imports without a place of their own land and size within it. */
  get viewport() {
    const s = this.api.getAppState(), z = s.zoom.value, frame = this.seen?.() ?? { left: 0, top: 0, width: s.width, height: s.height }
    const x = frame.left / z - s.scrollX, y = frame.top / z - s.scrollY, width = frame.width / z, height = frame.height / z
    return { x, y, width, height, zoom: z, center: { x: x + width / 2, y: y + height / 2 } }
  }
  /** The whole editor, which rendering, presentation and a request's submitted
   * view cover. It does not change as the conversation opens and closes. */
  get surface() {
    const s = this.api.getAppState(), z = s.zoom.value
    return { x: -s.scrollX, y: -s.scrollY, width: s.width / z, height: s.height / z, zoom: z, center: { x: s.width / z / 2 - s.scrollX, y: s.height / z / 2 - s.scrollY } }
  }
  point(client: { x: number; y: number }) { return viewportCoordsToSceneCoords({ clientX: client.x, clientY: client.y }, this.api.getAppState()) }
  /** Read-only document projection, including preserved historical geometry. */
  get document(): SceneSnapshot['document'] {
    const live = sceneDocument(this.artwork(this.api.getSceneElementsIncludingDeleted()), this.assets)
    return this.restoredDocument && this.restoredDocument.applied === documentStamp(live) && documentEquals(this.restoredDocument.files, live.files) ? this.restoredDocument.saved : live
  }
  get view() {
    const s = this.api.getAppState()
    return { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value }
  }
  /** A read-only capture: unchanged elements are the copies history already holds. */
  snapshot(): SceneSnapshot {
    const s = this.api.getAppState()
    return saveCanvasSnapshot({ engine: 'excalidraw', version: 1, document: this.document, view: { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value } })
  }
  restore(value: unknown) {
    // History's immutable objects stay the saved document; the editor gets copies.
    const s = validateSnapshot(value)
    this.restorationVersion++
    // Saved text measurements are artwork. Only new edits need preparation.
    // The engine may repair old ordering indexes; retain the saved document
    // while its applied scene is unchanged so browsing cannot create a commit.
    // Old programmatic brushes also need native local geometry. Convert only
    // the applied copy: historical exports/revisions remain exactly intact.
    const applied = cloneCanvasSnapshot(s)
    applied.document.elements = applied.document.elements.map((copy, i) => restored(copy, s.document.elements[i]!))
    this.applyRestored(s, applied)
  }
  /** Startup prepares native caches before publishing the restored scene. The
   * saved document and mutable applied copy remain separate throughout. */
  async restoreCooperatively(value: unknown, work: CanvasWork) {
    const source = validateSnapshot(value), saved: ExcalidrawElement[] = [], applied: ExcalidrawElement[] = []
    for (const element of source.document.elements) {
      await work.checkpoint()
      if (this.disposed) throw new Error('The canvas has been closed')
      saved.push(element); applied.push(restored(cloneCanvasElement(element), element))
    }
    const s = { ...source, view: { ...source.view }, document: { elements: saved, files: { ...source.document.files } } }
    const ready = { ...s, document: { elements: applied, files: { ...source.document.files } } }
    const state = this.api.getAppState(), { scrollX, scrollY, zoom } = s.view
    // Native bitmap preparation uses the restored camera's zoom. The live
    // scene remains read-only and empty until the complete restore is ready.
    this.api.updateScene({ appState: { scrollX, scrollY, zoom: { value: zoom as AppState['zoom']['value'] } }, captureUpdate: CaptureUpdateAction.NEVER })
    await this.prepareRender(applied, work, { x: -scrollX, y: -scrollY, width: state.width / zoom, height: state.height / zoom, zoom: zoom as AppState['zoom']['value'], center: { x: state.width / zoom / 2 - scrollX, y: state.height / zoom / 2 - scrollY } })
    work.check()
    if (this.disposed) throw new Error('The canvas has been closed')
    this.restorationVersion++
    this.applyRestored(s, ready)
  }
  private applyRestored(s: SceneSnapshot, applied: SceneSnapshot) {
    this.applyPrepared(applied, false, { scrollX: s.view.scrollX, scrollY: s.view.scrollY, zoom: { value: s.view.zoom as AppState['zoom']['value'] }, selectedElementIds: {}, croppingElementId: null, isCropping: false })
    this.restoredDocument = { saved: s.document, applied: documentStamp(sceneDocument(this.api.getSceneElementsIncludingDeleted(), this.assets)), files: sceneDocument(this.api.getSceneElementsIncludingDeleted(), this.assets).files }
    this.api.history.clear()
  }
  replace(elements: readonly ExcalidrawElement[], files: CanvasAssets = this.assets, undoable = true, appState: Partial<AppState> = {}) {
    const previous = new Map(this.elements.map(el => [el.id, el]))
    const draft = elements.map(cloneCanvasElement)
    const changed = new Set(draft.filter(el => {
      const before = previous.get(el.id)
      return !el.isDeleted && before && (['x', 'y', 'width', 'height', 'angle'] as const).some(key => el[key] !== before[key])
    }).map(el => el.id))
    // Selection actions share the native relationship update path with tools.
    // Work on a draft because native geometry functions mutate related records.
    refreshRelationships(draft, changed)
    this.applyPrepared(this.prepare(draft, files), undoable, appState)
  }
  prepare(elements: readonly ExcalidrawElement[], files: CanvasAssets = this.assets): SceneSnapshot {
    if (this.disposed) throw new Error('The canvas has been closed')
    // Creation and relationship edits measure their own text. Re-measuring
    // the entire document here would also alter unrelated saved artwork.
    return prepareToolSnapshot(elements, files, this.view)
  }
  /** Apply a prepared document without normalizing again, keeping the live camera.
   * `reveal` lands the edit's new work in turn without changing the document. */
  applyPrepared(snapshot: SceneSnapshot, undoable = true, appState: Partial<AppState> = {}, reveal?: { previous: { has(id: string): boolean }; work: CanvasWork }) {
    if (this.disposed) throw new Error('The canvas has been closed')
    const { document } = validateSnapshot(snapshot)
    this.restoredDocument = undefined
    this.resources = { ...this.resources, ...normalizeAssets(document.files) }
    const files = editorFiles(document.files, this.urls)
    const elements = document.elements.map(el => videoData(el) && el.link !== VIDEO_LINK ? { ...el, link: VIDEO_LINK } : el)
    // The native paint takes over now, even if history activation is still
    // saving. A reveal holds this edit's new work back before the scene shows
    // it, after the work still landing; any other apply lands everything now.
    if (reveal) this.present(elements, reveal.previous, reveal.work)
    else this.clearPresentation()
    this.observe(elements, files)
    try {
      this.api.updateScene({ elements, appState: { ...this.api.getAppState(), ...appState }, captureUpdate: undoable ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.NEVER })
      // addFiles builds image caches for elements currently in the scene. Calling
      // it before updateScene leaves new/history images as placeholders until
      // Excalidraw's delayed failsafe refresh, despite valid persisted bytes.
      this.api.addFiles(Object.values(files))
    } catch (error) {
      // Never present work the scene does not hold.
      this.clearPresentation()
      throw error
    }
  }
  observe(elements: readonly ExcalidrawElement[], files: BinaryFiles): boolean {
    // A native undo may refer to a retired guide. It cannot resurrect system
    // content after drawing has started, nor leak it into a saved snapshot.
    if (!this.guideActive && elements.some(el => !el.isDeleted && this.isGuideElement(el.id))) this.dismissGuide()
    elements = this.artwork(elements)
    // onChange also fires for pointer/selection movement. Native versions avoid
    // repeatedly serializing embedded image bytes during these interactions.
    const fingerprint = elements.map(el => `${el.id}:${el.version}:${el.versionNonce}:${el.isDeleted}:${el.index}`).join('|')
    const used = new Set(elements.flatMap(el => el.type === 'image' && el.fileId ? [el.fileId] : []))
    const nextFiles = new Map([...used].map(id => [id, files[id]?.dataURL ?? '']))
    const changed = fingerprint !== this.observed || nextFiles.size !== this.observedFiles.size || [...nextFiles].some(([id, data]) => this.observedFiles.get(id) !== data)
    this.observed = fingerprint
    this.observedFiles = nextFiles
    return changed
  }
  select(ids: string[]) {
    // Programmatic pointers keep their exact IDs. Unlike a native group click,
    // they must not expand a partial selection to the rest of its group.
    // Still tell the editor about complete groups so its own Ungroup works.
    const selected = new Set(ids), elements = this.elements
    const included = (el: ExcalidrawElement) => selected.has(el.id) || el.type === 'text' && Boolean(el.containerId && selected.has(el.containerId))
    const groups = new Map<string, { count: number; complete: boolean }>()
    for (const el of elements) for (const id of el.groupIds) {
      const group = groups.get(id) ?? { count: 0, complete: true }
      group.count++; group.complete &&= included(el); groups.set(id, group)
    }
    const selectedGroups = new Set<string>()
    for (const el of elements) if (included(el)) {
      const id = [...el.groupIds].reverse().find(id => groups.get(id)!.complete && groups.get(id)!.count > 1)
      if (id) selectedGroups.add(id)
    }
    this.api.updateScene({ appState: {
      selectedElementIds: Object.fromEntries(ids.map(id => [id, true])),
      selectedGroupIds: Object.fromEntries([...selectedGroups].map(id => [id, true])), editingGroupId: null
    }, captureUpdate: CaptureUpdateAction.NEVER })
  }
  captureViewport(frame: CanvasFrame) {
    const state = this.api.getAppState(), zoom = state.zoom.value
    return { center: { x: (frame.left + frame.width / 2) / zoom - state.scrollX, y: (frame.top + frame.height / 2) / zoom - state.scrollY }, span: Math.min(frame.width, frame.height) / zoom }
  }
  frameViewport({ center, span }: CanvasView, frame: CanvasFrame, moving = false) {
    // Preserve the world span of the shorter edge. Unlike repeatedly fitting
    // both dimensions, this is reversible when switching portrait/landscape.
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(frame.width, frame.height) / span))
    // A moving camera reuses the tiles already drawn; settling restores exact rendering.
    const shouldCacheIgnoreZoom = moving || this.api.getAppState().shouldCacheIgnoreZoom
    this.api.updateScene({ appState: { zoom: { value: zoom as AppState['zoom']['value'] }, scrollX: (frame.left + frame.width / 2) / zoom - center.x, scrollY: (frame.top + frame.height / 2) / zoom - center.y, shouldCacheIgnoreZoom }, captureUpdate: CaptureUpdateAction.NEVER })
  }
  fit() { this.api.scrollToContent(this.elements.length ? this.elements : this.api.getSceneElements(), { fitToContent: true, viewportZoomFactor: .65, animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches }) }
  zoomBy(factor: number) {
    const v = this.surface, zoom = Math.min(5, Math.max(.1, v.zoom * factor))
    const s = this.api.getAppState()
    this.api.updateScene({ appState: { zoom: { value: zoom as AppState['zoom']['value'] }, scrollX: s.width / zoom / 2 - v.center.x, scrollY: s.height / zoom / 2 - v.center.y, shouldCacheIgnoreZoom: true }, captureUpdate: CaptureUpdateAction.NEVER })
    this.settleZoom(zoom, 120)
  }
  /** Travel to a view along the smooth zoom path, framing it in `frame`. A long
   * move zooms out, travels and zooms in. Aborting leaves the camera where it
   * is; reduced motion arrives at once. The camera is the reader's: only an
   * explicit request flies it. */
  async flyTo(target: CanvasView, frame: CanvasFrame, signal: AbortSignal) {
    const path = flightPath(this.captureViewport(frame), target)
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0
      : Math.min(themeTime('--motion-flight-max'), Math.max(themeTime('--motion-flight-min'), Math.abs(path.length) * themeTime('--motion-flight-unit')))
    this.zoomPreparation?.abort(); clearTimeout(this.zoomTimer)
    const startedAt = performance.now()
    await new Promise<void>(resolve => {
      const step = (now: number) => {
        if (signal.aborted || this.disposed) return resolve()
        const t = duration ? Math.min(1, (now - startedAt) / duration) : 1
        // Symmetric ease: the camera gathers speed, travels, and settles.
        const eased = t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2
        this.frameViewport(t < 1 ? path.at(eased) : target, frame, true)
        if (t < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
    if (!this.disposed) this.settleZoom(this.api.getAppState().zoom.value, 0)
  }
  /** Native zoom reuses drawn tiles while the camera moves. Refresh visible brushes
   * in slices before returning to exact-resolution rendering at `zoom`. */
  private settleZoom(zoom: number, delay: number) {
    this.zoomPreparation?.abort(); clearTimeout(this.zoomTimer)
    const controller = new AbortController(); this.zoomPreparation = controller
    this.zoomTimer = setTimeout(() => {
      void (async () => {
        const state = this.api.getAppState()
        if (this.disposed || state.zoom.value !== zoom) return
        await this.prepareRender(this.elements, new CanvasWork(controller.signal), this.surface, { ...state, shouldCacheIgnoreZoom: false })
        controller.signal.throwIfAborted()
        if (!this.disposed && this.api.getAppState().zoom.value === zoom) this.api.updateScene({ appState: { shouldCacheIgnoreZoom: false }, captureUpdate: CaptureUpdateAction.NEVER })
      })().catch(error => {
        if (controller.signal.aborted || this.disposed) return
        this.api.updateScene({ appState: { shouldCacheIgnoreZoom: false }, captureUpdate: CaptureUpdateAction.NEVER })
        console.error('Unable to prepare canvas zoom', { zoom, error: String(error) })
      })
    }, delay)
  }
  async preview(selectedIds: readonly string[] = this.selectedIds, detail: 'low' | 'high' = 'low', region?: CanvasRegion, unrendered?: string[], overlay?: PreviewOverlay): Promise<Blob | undefined> {
    return renderToolPreview(this.elements, this.files, this.api.getAppState(), selectedIds, detail, region, unrendered, overlay)
  }
}
