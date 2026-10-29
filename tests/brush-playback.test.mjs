import { test, expect } from 'bun:test'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../apps/extension/package.json', import.meta.url))
const { createFreeDrawPlayback, getFreeDrawSvgPath } = await import(require.resolve('@excalidraw/excalidraw/freeDrawPath'))

// Compare the actual drawing commands with native's SVG, before rasterization
// can conceal a pressure, cap, corner or two-decimal coordinate difference.
class RecordedPath {
  commands = []
  constructor(svg) { if (svg) this.commands.push(svg) }
  moveTo(...values) { this.commands.push('M', values.join(','), 'Q') }
  quadraticCurveTo(a, b, c, d) { this.commands.push(`${a},${b}`, `${c},${d}`) }
  lineTo(...values) { this.commands.push('L', values.join(',')) }
  closePath() { this.commands.push('Z') }
  toString() { return this.commands.join(' ') }
}
function withPath(run) {
  const original = globalThis.Path2D
  globalThis.Path2D = RecordedPath
  try { run() } finally { globalThis.Path2D = original }
}
function compare(points, simulatePressure, strokeWidth, counts) {
  const element = { points, pressures: points.map((_, i) => .5 + .49 * Math.sin(i * .73)), simulatePressure, strokeWidth, lastCommittedPoint: null }
  const before = JSON.stringify(element), cursor = createFreeDrawPlayback(element)
  for (const count of counts) {
    const a = points[count - 1], b = points[count] ?? a, fraction = .7
    const tip = [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction]
    const pressure = element.pressures[count - 1] + ((element.pressures[count] ?? element.pressures[count - 1]) - element.pressures[count - 1]) * fraction
    for (const intermediate of [false, true]) {
      const expected = getFreeDrawSvgPath({ ...element,
        points: [...points.slice(0, count), ...(intermediate ? [tip] : [])],
        pressures: [...element.pressures.slice(0, count), ...(intermediate ? [pressure] : [])] })
      expect(String(cursor.path(count, intermediate ? tip : undefined, intermediate ? pressure : undefined))).toBe(expected)
    }
  }
  expect(JSON.stringify(element)).toBe(before)
}

test('forward brush playback matches every native path command through corners, repeats and pressure changes', () => withPath(() => {
  let seed = 157
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32)
  for (const density of [.001, .1, 1, 10, 100]) {
    const points = []; let x = 0, y = 0
    for (let i = 0; i < 180; i++) { x += (random() - .45) * density; y += (random() - .5) * density; points.push(i % 17 ? [x, y] : points.at(-1) ?? [0, 0]) }
    const counts = [...Array.from({ length: 30 }, (_, i) => i + 1), 40, 60, 80, 120, 180]
    for (const width of [.5, 2, 10]) for (const simulated of [true, false]) compare(points, simulated, width, counts)
  }
}))

test('dense playback retains native geometry after the processed input window is released', () => withPath(() => {
  const points = Array.from({ length: 28000 }, (_, i) => [i / 28, Math.sin(i / 300) * 55])
  for (const simulated of [true, false]) compare(points, simulated, 2, [1, 2, 3, 16, 100, 1000, 5000, 10000, 16000, 21000, 28000])
}))

test('playback consumes old source points once instead of rescanning its growing prefix', () => withPath(() => {
  const points = Array.from({ length: 28000 }, (_, i) => [i / 28, Math.sin(i / 300) * 55]); let reads = 0
  const counted = new Proxy(points, { get(target, key) { if (/^\d+$/.test(String(key))) reads++; return Reflect.get(target, key) } })
  const cursor = createFreeDrawPlayback({ points: counted, pressures: [], simulatePressure: true, strokeWidth: 2, lastCommittedPoint: null })
  for (let count = 100; count <= points.length; count += 100) cursor.path(count)
  expect(reads).toBeLessThan(points.length * 2)
  expect(() => cursor.path(1)).toThrow('must advance')
  expect(() => cursor.path(points.length + 1)).toThrow('must advance')
}))
