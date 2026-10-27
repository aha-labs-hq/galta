import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'

type Points = readonly (readonly [number, number])[]
const linear = (element: ExcalidrawElement): Points | undefined => {
  const points = (element as { points?: Points }).points
  return points?.length && (element.type === 'arrow' || element.type === 'line' || element.type === 'freedraw') ? points : undefined
}

/** The point an object turns about, as the engine draws it: the centre of a
 * line's or stroke's own points, or of any other object's box. */
function centre(element: ExcalidrawElement): [number, number] {
  const points = linear(element)
  if (!points) return [element.x + element.width / 2, element.y + element.height / 2]
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of points) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
  return [element.x + (minX + maxX) / 2, element.y + (minY + maxY) / 2]
}

/** Whether a world point touches an object as it is drawn: a line or stroke
 * along its path, anything else inside its turned box, within `reach`. */
export function touches(element: ExcalidrawElement, x: number, y: number, reach: number): boolean {
  const [cx, cy] = centre(element), cos = Math.cos(-element.angle), sin = Math.sin(-element.angle)
  const px = cx + (x - cx) * cos - (y - cy) * sin, py = cy + (x - cx) * sin + (y - cy) * cos
  const points = linear(element)
  if (points) {
    const lx = px - element.x, ly = py - element.y, near = reach + element.strokeWidth / 2
    if (points.length === 1) return Math.hypot(lx - points[0]![0], ly - points[0]![1]) <= near
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1]!, [bx, by] = points[i]!, dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy
      const t = length ? Math.max(0, Math.min(1, ((lx - ax) * dx + (ly - ay) * dy) / length)) : 0
      if (Math.hypot(lx - ax - t * dx, ly - ay - t * dy) <= near) return true
    }
    return false
  }
  return px >= element.x - reach && px <= element.x + element.width + reach && py >= element.y - reach && py <= element.y + element.height + reach
}
