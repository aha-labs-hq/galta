import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { CanvasBounds } from '@galta/canvas'
import { elementBounds } from './observation'

/** More numbers than this stop helping a reader and start hiding the work. */
export const CAPTURE_MARKS_MAX = 40

export type CaptureMark = { label: string; ids: string[]; groupId?: string; bounds: CanvasBounds }

/** Number what a person would point at in a view: each outermost native group,
 * or each ungrouped element, with text bound to a container counted as part of
 * its container. The numbers follow reading order, so the same layout keeps
 * the same numbers. When a view holds more objects than CAPTURE_MARKS_MAX, the
 * largest are numbered and `total` says how many there were.
 *
 * A model cannot reliably tie an element ID to the pixels it belongs to when
 * objects overlap; a printed number next to each object, repeated beside its
 * IDs, removes that guess. */
export function captureMarks(elements: readonly ExcalidrawElement[], ids: readonly string[]): { marks: CaptureMark[]; total: number } {
  const wanted = new Set(ids), byId = new Map(elements.map(element => [element.id, element]))
  const objects = new Map<string, { ids: string[]; groupId?: string; left: number; top: number; right: number; bottom: number }>()
  for (const element of elements) {
    if (!wanted.has(element.id)) continue
    const containerId = 'containerId' in element ? element.containerId : null
    const container = containerId && wanted.has(containerId) ? byId.get(containerId) : undefined
    const owner = container ?? element
    const groupId = owner.groupIds.at(-1)
    const key = groupId ? `group:${groupId}` : `element:${owner.id}`
    const { x, y, width, height } = elementBounds(element)
    const object = objects.get(key)
    if (object) {
      object.ids.push(element.id)
      object.left = Math.min(object.left, x); object.top = Math.min(object.top, y)
      object.right = Math.max(object.right, x + width); object.bottom = Math.max(object.bottom, y + height)
    } else objects.set(key, { ids: [element.id], ...(groupId ? { groupId } : {}), left: x, top: y, right: x + width, bottom: y + height })
  }
  const all = [...objects.values()]
  const kept = all.length > CAPTURE_MARKS_MAX
    ? [...all].sort((a, b) => (b.right - b.left) * (b.bottom - b.top) - (a.right - a.left) * (a.bottom - a.top)).slice(0, CAPTURE_MARKS_MAX)
    : all
  // Reading order: objects whose tops fall within half the row's shortest
  // height share a row, read left to right.
  const rows: (typeof kept)[] = []
  for (const object of [...kept].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const row = rows.at(-1)
    const reach = row && Math.min(...row.map(item => item.bottom - item.top), object.bottom - object.top) / 2
    if (row && object.top - row[0]!.top <= reach!) row.push(object)
    else rows.push([object])
  }
  const marks = rows.flatMap(row => row.sort((a, b) => a.left - b.left)).map((object, index) => ({
    label: String(index + 1), ids: object.ids, ...(object.groupId ? { groupId: object.groupId } : {}),
    bounds: { x: object.left, y: object.top, width: object.right - object.left, height: object.bottom - object.top }
  }))
  return { marks, total: all.length }
}
