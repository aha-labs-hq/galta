import type { ExcalidrawElement, ExcalidrawFreeDrawElement } from '@excalidraw/excalidraw/element/types'

/** One synchronous validation pass may reuse immutable geometry across saved
 * versions. Callers create a fresh scope; mutable live arrays never enter it. */
export type BrushValidation = { points: WeakSet<object>; pressures: WeakSet<object> }
export function validateFreeDraw(element: ExcalidrawFreeDrawElement, checked?: BrushValidation): void {
  const { points, pressures, simulatePressure } = element
  if (!Array.isArray(points) || (!element.isDeleted && points.length < 1) || (!checked?.points.has(points) && !points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))) throw new Error(`Invalid brush points: ${element.id}`)
  if (typeof simulatePressure !== 'boolean' || !Array.isArray(pressures) || (!checked?.pressures.has(pressures) && !pressures.every(p => Number.isFinite(p) && p >= 0 && p <= 1)) || (!simulatePressure && pressures.length !== points.length)) throw new Error(`Brush ${element.id} requires one pressure per point, or simulatePressure: true`)
  checked?.points.add(points); checked?.pressures.add(pressures)
}

/** The native pointer tool starts at [0, 0] and derives size from the points.
 * restoreElements/newElementWith do neither for freedraw. Own that conversion
 * at our input boundary, not in the renderer. The absolute point bounds (also
 * the native rotation center) stay fixed, so this preserves rotated artwork.
 * Return canonical/native strokes untouched; do not change history metadata. */
export function normalizeFreeDraw<T extends ExcalidrawElement>(element: T): T {
  if (element.type !== 'freedraw') return element
  validateFreeDraw(element)
  if (!element.points.length) return element
  const [ox, oy] = element.points[0]!
  const points = ox === 0 && oy === 0 ? element.points : element.points.map(([x, y]) => [x - ox, y - oy] as const)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y)
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
  }
  const width = maxX - minX, height = maxY - minY
  if (![element.x + ox, element.y + oy, width, height].every(Number.isFinite)) throw new Error(`Invalid brush geometry: ${element.id}`)
  if (ox === 0 && oy === 0 && width === element.width && height === element.height) return element
  return { ...element, x: element.x + ox, y: element.y + oy, width, height, points,
    lastCommittedPoint: element.lastCommittedPoint ? [element.lastCommittedPoint[0] - ox, element.lastCommittedPoint[1] - oy] : null }
}
