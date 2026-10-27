import { getCommonBounds, newElementWith } from '@excalidraw/excalidraw'
import type { CanvasScene } from './scene'

/** Compact, deterministic columns in scene units. Excalidraw keeps ownership
 * of element IDs, image bytes, rotation and undo; only geometry changes. */
export function tidySelectedImages(scene: CanvasScene): void {
  const images = scene.selected
  if (images.length < 2 || images.some(el => el.type !== 'image')) throw new Error('Select at least two images to tidy.')
  if (new Set(images.map(el => el.frameId)).size > 1) throw new Error('Tidy images within the same frame.')
  const bounds = images.map(el => getCommonBounds([el]))
  const widths = bounds.map(([left, , right]) => right - left).sort((a, b) => a - b)
  const columnWidth = widths[Math.floor(widths.length / 2)]!
  if (!Number.isFinite(columnWidth) || columnWidth <= 0) throw new Error('The selected images have invalid dimensions.')
  const [left, top] = getCommonBounds(images)
  const columns = Math.ceil(Math.sqrt(images.length)), gap = 12
  const heights = Array<number>(columns).fill(top)
  const arranged = new Map(images.map((el, i) => {
    const [x1, y1, x2, y2] = bounds[i]!
    const scale = columnWidth / (x2 - x1)
    const column = heights.indexOf(Math.min(...heights))
    const width = el.width * scale, height = el.height * scale
    const scaledBoundsHeight = (y2 - y1) * scale
    const centerX = left + column * (columnWidth + gap) + columnWidth / 2
    const centerY = heights[column]! + scaledBoundsHeight / 2
    heights[column] = heights[column]! + scaledBoundsHeight + gap
    return [el.id, newElementWith(el, { x: centerX - width / 2, y: centerY - height / 2, width, height })]
  }))
  scene.replace(scene.elements.map(el => arranged.get(el.id) ?? el))
}
