import { getCommonBounds, newElementWith } from '@excalidraw/excalidraw'
import type { CanvasScene } from './scene'

export type ImageArrangement = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' | 'horizontal' | 'vertical'

export function arrangeImages(scene: CanvasScene, action: ImageArrangement): void {
  const selected = scene.selected
  const distribute = action === 'horizontal' || action === 'vertical'
  if (selected.length < 2 || selected.some(el => el.type !== 'image')) throw new Error('Select images to arrange.')
  if (new Set(selected.map(el => el.frameId)).size > 1) throw new Error('Arrange images within the same frame.')
  const ids = new Set(selected.map(el => el.id))
  const groups = new Map<string, typeof selected>()
  for (const el of selected) {
    const key = el.groupIds.at(-1) ?? el.id
    if (el.groupIds.length && scene.elements.some(other => other.groupIds.includes(key) && !ids.has(other.id))) throw new Error('Select the complete image group to arrange it.')
    groups.set(key, [...(groups.get(key) ?? []), el])
  }
  const units = [...groups.values()].map(elements => ({ elements, bounds: getCommonBounds(elements) }))
  if (units.length < (distribute ? 3 : 2)) throw new Error(distribute ? 'Select at least three images or groups to distribute.' : 'Select at least two images or groups to align.')
  const axis = ['left', 'center', 'right', 'horizontal'].includes(action) ? 0 : 1
  const bounds = getCommonBounds(selected), start = bounds[axis], end = bounds[axis + 2]!
  const arranged = new Map<string, (typeof selected)[number]>()
  let cursor = start
  // Rotated bounds and image groups come from the engine. Distribution uses
  // equal visible gaps; an overlapping selection expands from its leading edge.
  const total = units.reduce((sum, unit) => sum + unit.bounds[axis + 2]! - unit.bounds[axis], 0)
  const gap = Math.max(12, (end - start - total) / (units.length - 1))
  if (distribute) units.sort((a, b) => a.bounds[axis] - b.bounds[axis])
  for (const unit of units) {
    const low = unit.bounds[axis], high = unit.bounds[axis + 2]!
    const delta = distribute ? cursor - low : ['left', 'top'].includes(action) ? start - low : ['right', 'bottom'].includes(action) ? end - high : (start + end - low - high) / 2
    for (const el of unit.elements) arranged.set(el.id, newElementWith(el, axis === 0 ? { x: el.x + delta } : { y: el.y + delta }))
    cursor += high - low + gap
  }
  scene.replace(scene.elements.map(el => arranged.get(el.id) ?? el))
}
