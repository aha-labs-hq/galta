import { getCommonBounds } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { relatedElementIds } from './relationships'
import { CANVAS_PAGE_MAX, canvasBoundsSchema, type CanvasBounds } from '@galta/canvas'

export type CanvasRegion = { x: number; y: number; width: number; height: number }
export type CanvasObservation = { ids: string[]; bounds?: CanvasRegion; scope: 'canvas' | 'elements' | 'region' }

/** Use the editor's geometric bounds for both discovery and spatial context.
 * Native x/y are editable origins, not necessarily the top-left of a path. */
export function elementBounds(element: ExcalidrawElement): CanvasBounds {
  const [left, top, right, bottom] = getCommonBounds([element])
  try { return canvasBoundsSchema.parse({ x: left, y: top, width: right - left, height: bottom - top }) }
  catch (error) { throw new Error(`Invalid bounds for canvas element ${element.id}`, { cause: error }) }
}

export function parseRegion(value: unknown): CanvasRegion {
  const r = value as CanvasRegion
  if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) throw new Error('region requires finite x, y and positive width, height')
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}
export function inRegion(elements: readonly ExcalidrawElement[], region: CanvasRegion): ExcalidrawElement[] {
  return elements.filter(el => {
    const bounds = elementBounds(el)
    return bounds.x + bounds.width >= region.x && bounds.x <= region.x + region.width && bounds.y + bounds.height >= region.y && bounds.y <= region.y + region.height
  })
}

/** Explicit targeting, shared by coverage and rendering. A region is a crop
 * of the live composition, including overlapping background and text. */
export function observeCanvas(elements: readonly ExcalidrawElement[], input: Record<string, unknown>, selection: readonly string[]): CanvasObservation {
  const selectors = ['element', 'ids', 'region', 'scope'].filter(key => input[key] !== undefined)
  if (selectors.length > 1) throw new Error('Choose one view target: element, ids, region or scope')
  if (input.include !== undefined && !['exact', 'related'].includes(String(input.include))) throw new Error('Invalid view include mode')
  if (input.include !== undefined && (input.region !== undefined || input.scope === 'canvas')) throw new Error('include applies only to element, ids or selection views')
  if (input.region !== undefined) {
    const bounds = parseRegion(input.region)
    return { ids: inRegion(elements, bounds).map(el => el.id), bounds, scope: 'region' }
  }
  if (input.scope !== undefined && !['canvas', 'selection'].includes(String(input.scope))) throw new Error('Invalid canvas view scope')
  let ids: string[]
  if (input.element !== undefined) {
    if (typeof input.element !== 'string' || !input.element) throw new Error('Invalid element id')
    ids = [input.element]
  } else if (input.ids !== undefined) {
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > CANVAS_PAGE_MAX || !input.ids.every(id => typeof id === 'string' && id.length) || new Set(input.ids).size !== input.ids.length) throw new Error(`ids must contain 1 to ${CANVAS_PAGE_MAX} unique element ids`)
    ids = input.ids
  } else if (input.scope === 'selection' || (input.scope === undefined && selection.length)) {
    ids = [...selection]
    if (!ids.length) throw new Error('The selection is empty. Use scope canvas to view the whole canvas.')
  } else return { ids: elements.map(el => el.id), scope: 'canvas' }
  const present = new Set(elements.map(el => el.id))
  const missing = ids.filter(id => !present.has(id))
  if (missing.length) throw new Error(`No canvas elements have these ids: ${missing.join(', ')}`)
  return { ids: [...(input.include === 'exact' ? new Set(ids) : relatedElementIds(elements, ids, true))], scope: 'elements' }
}
