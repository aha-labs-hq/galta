import { exportToBlob, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, ExcalidrawFrameElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types'
import { AssetURLs, type CanvasAssets } from '@galta/canvas'
import { themeColor } from '../design/theme'
import { cloneCanvasElement, cloneCanvasSnapshot } from './cloneSnapshot'
import { normalizeFreeDraw } from './freeDraw'
import type { CanvasScene } from './scene'
import { sceneDocument, validateSnapshot, type SceneSnapshot } from './sceneSnapshot'
import { withPosters } from './htmlPoster'
import { editorFiles } from './video'
import type { CanvasRegion } from './observation'
import type { CanvasWork } from './canvasWork'

/** Tools depend on document operations, never on an editor or its lifecycle. */
export type ToolScene = Pick<CanvasScene, 'disposed' | 'restorationVersion' | 'document' | 'elements' | 'files' | 'assets' | 'selectedIds' | 'snapshot' | 'prepare' | 'applyPrepared' | 'preview' | 'present' | 'clearPresentation' | 'prepareRender'> & { viewport: { x: number; y: number; width: number; height: number; zoom: number; center: { x: number; y: number } } }

export function prepareToolSnapshot(elements: readonly ExcalidrawElement[], files: CanvasAssets, view: SceneSnapshot['view']): SceneSnapshot {
  const normalized = restoreElements(elements.map(normalizeFreeDraw), null, { repairBindings: true })
  return cloneCanvasSnapshot(validateSnapshot({ engine: 'excalidraw', version: 1, document: sceneDocument(normalized, files), view }))
}

/** `unrendered` receives the IDs of pages drawn as their title, not their poster. */
export async function renderToolPreview(source: readonly ExcalidrawElement[], files: BinaryFiles, appState: Partial<AppState>, selectedIds: readonly string[], detail: 'low' | 'high', region?: CanvasRegion, unrendered?: string[]): Promise<Blob | undefined> {
  const ids = new Set(selectedIds)
  const elements = (ids.size ? source.filter(el => ids.has(el.id)) : source).map(cloneCanvasElement)
  if (!elements.length) return undefined
  const exportingFrame = region ? restoreElements([{ id: '__observation__', type: 'frame', ...region, angle: 0 } as ExcalidrawElement], null)[0] as ExcalidrawFrameElement : undefined
  const padding = region ? 0 : 20
  const budget = detail === 'high' ? 2800 : 1400
  return exportToBlob({ ...await withPosters(elements, { ...files }, unrendered), appState: { ...appState, exportBackground: true, viewBackgroundColor: themeColor('background'), exportWithDarkMode: false }, mimeType: 'image/jpeg', quality: .8, exportingFrame, exportPadding: padding,
    getDimensions: (width: number, height: number) => {
      // Raster density belongs to the observation, not the document's world
      // units. Render natively at this budget, including when zoomed in.
      const scale = budget / Math.max(width, height)
      return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale }
    } })
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
  async preview(ids = this.selectedIds, detail: 'low' | 'high' = 'low', region?: CanvasRegion, unrendered?: string[]) { return renderToolPreview(this.elements, this.files, {}, ids, detail, region, unrendered) }
  // Presentation and editor bitmap caches are view effects. Background tools
  // still observe cancellation at the same preparation boundaries.
  async present(_elements: readonly ExcalidrawElement[], _previous: { has(id: string): boolean }, work: CanvasWork) { work.check() }
  async prepareRender(_elements: readonly ExcalidrawElement[], work: CanvasWork) { work.check() }
  clearPresentation() {}
  close() { this.disposed = true; this.urls.release() }
}
