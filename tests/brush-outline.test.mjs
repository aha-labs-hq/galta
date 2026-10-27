import { test, expect } from 'bun:test'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../apps/extension/package.json', import.meta.url))
const { getFreeDrawSvgPath } = await import(require.resolve('@excalidraw/excalidraw/freeDrawPath'))
const coordinates = path => [...path.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)].map(match => Number(match[0]))

test('brush outlines preserve their shape when geometry and pen width scale together', () => {
  const strokes = [
    Array.from({ length: 14 }, (_, i) => [5 * i / 13, -11 * i / 13]),
    [[0, 0], [0, 6], [0, 12]],
    [[0, 0], [-10, -8], [0, 0], [3, -13]],
    [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
    [[0, 0]]
  ]
  for (const points of strokes) for (const simulatePressure of [false, true]) for (const lastCommittedPoint of [null, [0, 0]]) {
    const element = { points, strokeWidth: 1.6 / 4.25, simulatePressure, lastCommittedPoint, pressures: points.map((_, i) => .3 + .3 * i / points.length) }
    const before = structuredClone(element), reference = coordinates(getFreeDrawSvgPath(element))
    expect(reference.length).toBeGreaterThan(0)
    for (const scale of [.075, .2, 2, 5]) {
      const scaled = { ...element, points: points.map(([x, y]) => [x * scale, y * scale]), strokeWidth: element.strokeWidth * scale }
      const actual = coordinates(getFreeDrawSvgPath(scaled))
      expect(actual.length).toBe(reference.length)
      expect(Math.max(...actual.map((value, i) => Math.abs(value / scale - reference[i])))).toBeLessThan(.15)
    }
    expect(element).toEqual(before)
  }
})
