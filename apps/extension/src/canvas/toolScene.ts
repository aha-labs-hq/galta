import { exportToBlob, exportToCanvas, getCommonBounds, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, ExcalidrawFrameElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types'
import { AssetURLs, type CanvasAssets } from '@galta/canvas'
import { themeColor, themeFont } from '../design/theme'
import { cloneCanvasElement, cloneCanvasSnapshot } from './cloneSnapshot'
import { normalizeFreeDraw } from './freeDraw'
import type { CanvasScene } from './scene'
import { sceneDocument, validateSnapshot, type SceneSnapshot } from './sceneSnapshot'
import { withPosters } from './htmlPoster'
import { editorFiles } from './video'
import type { CanvasRegion } from './observation'
import type { CanvasWork } from './canvasWork'

/** Tools depend on document operations, never on an editor or its lifecycle. */
export type ToolScene = Pick<CanvasScene, 'disposed' | 'restorationVersion' | 'document' | 'elements' | 'files' | 'assets' | 'selectedIds' | 'snapshot' | 'prepare' | 'applyPrepared' | 'preview' | 'clearPresentation' | 'prepareRender'> & { viewport: { x: number; y: number; width: number; height: number; zoom: number; center: { x: number; y: number } } }

export function prepareToolSnapshot(elements: readonly ExcalidrawElement[], files: CanvasAssets, view: SceneSnapshot['view']): SceneSnapshot {
  const normalized = restoreElements(elements.map(normalizeFreeDraw), null, { repairBindings: true })
  return cloneCanvasSnapshot(validateSnapshot({ engine: 'excalidraw', version: 1, document: sceneDocument(normalized, files), view }))
}

/** Annotations drawn over a view for the reader, never into the document:
 * numbered object marks (see `captureMarks`) and a world-coordinate grid. */
export type PreviewOverlay = { marks: readonly { label: string; bounds: CanvasRegion }[]; grid: boolean }

/** `unrendered` receives the IDs of pages drawn as their title, not their poster. */
export async function renderToolPreview(source: readonly ExcalidrawElement[], files: BinaryFiles, appState: Partial<AppState>, selectedIds: readonly string[], detail: 'low' | 'high', region?: CanvasRegion, unrendered?: string[], overlay?: PreviewOverlay): Promise<Blob | undefined> {
  const ids = new Set(selectedIds)
  const elements = (ids.size ? source.filter(el => ids.has(el.id)) : source).map(cloneCanvasElement)
  if (!elements.length) return undefined
  const padding = 20
  // An overlay needs an exact world-to-pixel mapping. An explicit frame fixes
  // the raster's origin at its corner; without one the origin would follow
  // Excalidraw's root-element bounds, which this module does not own.
  const frame = region ?? (overlay ? padded(getCommonBounds(elements), padding) : undefined)
  const exportingFrame = frame ? restoreElements([{ id: '__observation__', type: 'frame', ...frame, angle: 0 } as ExcalidrawElement], null)[0] as ExcalidrawFrameElement : undefined
  const budget = detail === 'high' ? 2800 : 1400
  const options = { ...await withPosters(elements, { ...files }, unrendered), appState: { ...appState, exportBackground: true, viewBackgroundColor: themeColor('background'), exportWithDarkMode: false }, exportingFrame, exportPadding: frame ? 0 : padding,
    getDimensions: (width: number, height: number) => {
      // Raster density belongs to the observation, not the document's world
      // units. Render natively at this budget, including when zoomed in.
      const scale = budget / Math.max(width, height)
      return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale }
    } }
  if (!overlay || !frame) return exportToBlob({ ...options, mimeType: 'image/jpeg', quality: .8 })
  const canvas: HTMLCanvasElement = await exportToCanvas(options)
  drawOverlay(canvas, frame, overlay)
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob: Blob | null) => blob ? resolve(blob) : reject(new Error('Unable to encode the canvas view')), 'image/jpeg', .8))
}

function padded([left, top, right, bottom]: readonly [number, number, number, number], padding: number): CanvasRegion {
  return { x: left - padding, y: top - padding, width: right - left + padding * 2, height: bottom - top + padding * 2 }
}

/** A grid step that gives about ten lines across the longer side, on round
 * world values a reader can add up: 1, 2, 2.5 or 5 times a power of ten. */
function gridStep(extent: number): number {
  const raw = extent / 10, power = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 2.5, 5, 10].map(factor => factor * power).find(step => step >= raw)!
}

function drawOverlay(canvas: HTMLCanvasElement, frame: CanvasRegion, overlay: PreviewOverlay) {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Unable to annotate the canvas view')
  // Export leaves its render scale on the context; annotate in raster pixels.
  // The frame is the whole raster, so its size fixes the scale exactly.
  context.setTransform(1, 0, 0, 1, 0, 0)
  const scale = canvas.width / frame.width
  const ink = themeColor('mark-ink'), paper = themeColor('mark-paper')
  // Sizes follow the raster, so a low and a high view read alike once resized.
  const unit = Math.max(canvas.width, canvas.height) / 1400, pad = Math.round(4 * unit)
  context.textBaseline = 'top'
  const px = (x: number) => (x - frame.x) * scale, py = (y: number) => (y - frame.y) * scale
  const label = (text: string, left: number, top: number, size: number) => {
    context.font = `600 ${size}px ${themeFont('font-ui')}`
    const width = context.measureText(text).width + pad * 2, height = size + pad * 2
    const x = Math.min(Math.max(0, left), canvas.width - width), y = Math.min(Math.max(0, top), canvas.height - height)
    context.fillStyle = ink; context.fillRect(x, y, width, height)
    context.fillStyle = paper; context.fillText(text, x + pad, y + pad)
  }
  if (overlay.grid) {
    const step = gridStep(Math.max(frame.width, frame.height)), size = Math.round(12 * unit)
    const xs: number[] = [], ys: number[] = []
    for (let x = Math.ceil(frame.x / step) * step; x <= frame.x + frame.width; x += step) xs.push(x)
    for (let y = Math.ceil(frame.y / step) * step; y <= frame.y + frame.height; y += step) ys.push(y)
    // Difference against paper inverts whatever lies beneath, so a line reads
    // on light paper, dark ink and saturated fills alike.
    context.save()
    context.globalCompositeOperation = 'difference'; context.globalAlpha = .5
    context.strokeStyle = paper; context.lineWidth = Math.max(1, unit)
    context.beginPath()
    for (const x of xs) { context.moveTo(px(x), 0); context.lineTo(px(x), canvas.height) }
    for (const y of ys) { context.moveTo(0, py(y)); context.lineTo(canvas.width, py(y)) }
    context.stroke()
    context.restore()
    // World values along the top and left edges, leaving the corner empty so
    // the two rows never cover each other.
    const band = size + pad * 2
    for (const x of xs) if (px(x) >= band * 3) label(String(Math.round(x)), px(x) + unit, 0, size)
    for (const y of ys) if (py(y) >= band * 2) label(String(Math.round(y)), 0, py(y) + unit, size)
  }
  if (overlay.marks.length) {
    context.save()
    context.strokeStyle = ink; context.globalAlpha = .55; context.lineWidth = Math.max(1, 1.5 * unit)
    context.setLineDash([6 * unit, 4 * unit])
    for (const mark of overlay.marks) context.strokeRect(px(mark.bounds.x), py(mark.bounds.y), mark.bounds.width * scale, mark.bounds.height * scale)
    context.restore()
    for (const mark of overlay.marks) label(mark.label, px(mark.bounds.x) + pad, py(mark.bounds.y) + pad, Math.round(16 * unit))
  }
}

/** A task's document projection. IndexedDB remains authoritative; native
 * geometry and export are shared with the editor without mounting React. */
export class TaskScene implements ToolScene {
  private value: SceneSnapshot
  private readonly urls = new AssetURLs()
  disposed = false
  restorationVersion = 0
  constructor(snapshot: SceneSnapshot, readonly selectedIds: string[], private seen: ToolScene['viewport']) {
    this.value = cloneCanvasSnapshot(validateSnapshot(snapshot))
  }
  /** What the reader can see: the submitted view, then each view the canvas
   * reports while the task runs (`view`). */
  get viewport() { return this.seen }
  view({ x, y, width, height, zoom }: Omit<ToolScene['viewport'], 'center'>) {
    this.seen = { x, y, width, height, zoom, center: { x: x + width / 2, y: y + height / 2 } }
  }
  get document() { return this.value.document }
  get elements() { return this.document.elements.filter(el => !el.isDeleted) }
  get assets() { return this.document.files }
  get files() { return editorFiles(this.assets, this.urls) }
  snapshot() { return cloneCanvasSnapshot(this.value) }
  restore(snapshot: SceneSnapshot) { this.value = cloneCanvasSnapshot(validateSnapshot(snapshot)); this.restorationVersion++; this.urls.release() }
  prepare(elements: readonly ExcalidrawElement[], files = this.assets) { return prepareToolSnapshot(elements, files, this.value.view) }
  applyPrepared(snapshot: SceneSnapshot, undoable?: boolean, appState?: Partial<AppState>, reveal?: { previous: { has(id: string): boolean }; work: CanvasWork }) { this.restore(snapshot) }
  async preview(ids = this.selectedIds, detail: 'low' | 'high' = 'low', region?: CanvasRegion, unrendered?: string[], overlay?: PreviewOverlay) { return renderToolPreview(this.elements, this.files, {}, ids, detail, region, unrendered, overlay) }
  // Presentation and editor bitmap caches are view effects. Background tools
  // still observe cancellation at the same preparation boundaries.
  async prepareRender(_elements: readonly ExcalidrawElement[], work: CanvasWork) { work.check() }
  clearPresentation() {}
  close() { this.disposed = true; this.urls.release() }
}
