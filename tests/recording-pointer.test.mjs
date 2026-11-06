import { test, expect } from 'bun:test'
import { PointerTrail } from '../apps/extension/src/recording/PointerTrail'

const trail = () => new PointerTrail(180, 96, 1.8)
const centers = value => Array.from({ length: value.count / 2 }, (_, i) => {
  const v = i * 10
  return [(value.vertices[v] + value.vertices[v + 5]) / 2, (value.vertices[v + 1] + value.vertices[v + 6]) / 2]
})

test('a high-rate sweep stays bounded and ends at actual input without prediction', () => {
  const value = trail()
  for (let i = 0; i <= 8000; i++) value.add(i, 100, i / 8)
  value.update(1000)
  const points = centers(value)
  expect(points[0]).toEqual([8000, 100])
  expect(points.at(-1)).toEqual([7904, 100])
  expect(value.count).toBeLessThanOrEqual(256)
  expect(value.update(1180)).toBe(0)
})

test('stationary fade does not rebuild or upload geometry', () => {
  const value = trail()
  for (let i = 0; i <= 120; i += 20) value.add(i / 2, 0, i)
  value.update(120)
  const vertices = value.vertices.slice(), version = value.version
  for (const t of [150, 200, 250, 299]) { value.update(t); expect(value.vertices).toEqual(vertices); expect(value.version).toBe(version) }
  expect(value.update(300)).toBe(0)
})

test('display refresh cadence cannot change the curve', () => {
  const sixty = new PointerTrail(360, 220, 2.4, 3, 6), high = new PointerTrail(360, 220, 2.4, 3, 6)
  for (let i = 0; i <= 1000; i++) {
    sixty.add(Math.cos(i / 100) * 80, Math.sin(i / 100) * 80, i)
    high.add(Math.cos(i / 100) * 80, Math.sin(i / 100) * 80, i)
    if (i % 16 === 0) sixty.update(i)
    if (i % 8 === 0) high.update(i)
  }
  sixty.update(1050); high.update(1050)
  expect(sixty.count).toBe(high.count)
  // The fixed buffer retains unused storage from earlier frames; only count
  // vertices are rendered. Compare the live geometry and its surface bounds.
  expect(sixty.vertices.subarray(0, sixty.count * 5)).toEqual(high.vertices.subarray(0, high.count * 5))
  expect(sixty.bounds).toEqual(high.bounds)
})

test('reversals, duplicate and stale events produce only finite bounded geometry', () => {
  const value = trail()
  for (let i = 0; i < 1000; i++) value.add(i % 2 ? 0 : 10, 0, i)
  value.add(0, 0, 999); value.add(10000, 10000, 3); value.add(NaN, 0, 1000)
  value.update(1000)
  expect(value.vertices.every(Number.isFinite)).toBe(true)
  expect(centers(value).every(([x, y]) => x >= -.01 && x <= 10.01 && Math.abs(y) < .01)).toBe(true)
  value.clear(); expect(value.update(1000)).toBe(0)
})

test('uneven sampling on a straight line cannot create sideways loops or knots', () => {
  const value = trail()
  for (const [x, t] of [[0, 0], [1, 1], [30, 2], [31, 3], [32, 4], [80, 5], [81, 6]]) value.add(x, 10, t)
  value.update(6)
  const points = centers(value)
  expect(points.every((p, i) => Math.abs(p[1] - 10) < .001 && (!i || p[0] <= points[i - 1][0]))).toBe(true)
})

test('the longer laser retains its full reach and fits beside the voice field', () => {
  const value = new PointerTrail(360, 220, 2.4, 3, 6)
  for (let i = 0; i <= 2000; i++) value.add(i, 100, i / 4)
  value.update(500)
  const points = centers(value), head = points[0]
  expect(head).toEqual([2000, 100])
  expect(points.at(-1)).toEqual([1780, 100])
  const { left, right, top, bottom } = value.bounds
  const padding = 2 * (1.2 + 3 + 1)
  expect(Math.max(right, head[0] + 64) - Math.min(left, head[0] - 64) + padding).toBeLessThan(304)
  expect(Math.max(bottom, head[1] + 64) - Math.min(top, head[1] - 64) + padding).toBeLessThan(304)
  expect(value.update(859)).toBeGreaterThan(0)
  expect(value.update(860)).toBe(0)
})

test('streamlining suppresses fine historical jitter without moving the current hotspot', () => {
  const raw = new PointerTrail(360, 220, 2.4), smooth = new PointerTrail(360, 220, 2.4, 3, 6)
  for (let i = 0; i < 200; i++) { raw.add(i, i % 2 ? 1 : -1, i); smooth.add(i, i % 2 ? 1 : -1, i) }
  raw.update(199); smooth.update(199)
  const deviation = value => centers(value).filter(([x]) => x > 20 && x < 180).reduce((sum, [, y]) => sum + Math.abs(y), 0)
  expect(centers(smooth)[0]).toEqual([199, 1])
  expect(deviation(smooth)).toBeLessThan(deviation(raw) * .2)
})

test('dense coalesced history never exhausts the mesh and jumps to its oldest point', () => {
  const value = new PointerTrail(360, 220, 2.4, 3, 6)
  for (let i = 0; i < 512; i++) value.add(i * .3, i % 2 ? 1 : -1, i / 2)
  value.add(220, 0, 257)
  value.update(257)
  const points = centers(value)
  const gaps = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]))
  expect(Math.max(...gaps)).toBeLessThan(8)
  expect(value.vertices.every(Number.isFinite)).toBe(true)
  expect(value.count * 5).toBeLessThanOrEqual(value.vertices.length)
})

// Independent Barry-Goldman construction checks the displayed centerline
// against the continuous curve, not a particular subdivision strategy.
const curve = (p0, p1, p2, p3, u) => {
  const times = [0]
  for (const [a, b] of [[p0, p1], [p1, p2], [p2, p3]]) times.push(times.at(-1) + Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])))
  const t = times[1] + u * (times[2] - times[1])
  const mix = (a, b, start, end) => a.map((v, i) => ((end - t) * v + (t - start) * b[i]) / (end - start))
  const a = mix(p0, p1, times[0], times[1]), b = mix(p1, p2, times[1], times[2]), c = mix(p2, p3, times[2], times[3])
  return mix(mix(a, b, times[0], times[2]), mix(b, c, times[1], times[3]), times[1], times[2])
}
const distanceToSegment = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], d = dx * dx + dy * dy
  const t = d ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / d)) : 0
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t)
}
for (const scale of [1, 2]) test(`adaptive tessellation respects a quarter physical pixel on bends and uneven input at ${scale}x`, () => {
  for (const input of [ [[0, 0], [10, 30], [65, -20], [80, 20]], [[0, 0], [1, 1], [110, 15], [111, 14]], [[0, 0], [60, 0], [10, 2], [65, 4]] ]) {
    const value = new PointerTrail(360, 220, 2.4, 3, 0, scale)
    input.forEach(([x, y], i) => value.add(x, y, i * 8)); value.update(24)
    const path = centers(value)
    for (let i = 0; i <= 256; i++) {
      const p = curve(...input, i / 256)
      const error = Math.min(...path.slice(1).map((b, j) => distanceToSegment(p, path[j], b)))
      expect(error * scale).toBeLessThan(.25)
    }
    expect(value.count * 5).toBeLessThanOrEqual(value.vertices.length)
  }
})

test('a long straight span has no redundant two-pixel subdivisions', () => {
  const value = new PointerTrail(360, 220, 2.4)
  for (let i = 0; i < 5; i++) value.add(i * 50, 100, i * 8)
  value.update(32)
  expect(centers(value)).toHaveLength(5)
  expect(centers(value)[0]).toEqual([200, 100])
  expect(centers(value).at(-1)).toEqual([0, 100])
})


test('the fixed error-bound capacity covers dense jitter, pauses and reversals at both densities', () => {
  let seed = 17
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
  for (const scale of [1, 2]) for (let run = 0; run < 40; run++) {
    const value = new PointerTrail(360, 220, 2.4, 3, run % 3 ? 6 : 0, scale)
    let x = 0, y = 0
    for (let i = 0; i < 600; i++) {
      x += (random() - .5) * (run % 4 ? 2 : 40)
      y += (random() - .5) * (run % 4 ? 2 : 40)
      value.add(x, y, Math.floor(i / 4))
    }
    value.update(150)
    expect(value.count * 5).toBeLessThanOrEqual(value.vertices.length)
    expect(value.vertices.subarray(0, value.count * 5).every(Number.isFinite)).toBe(true)
  }
})
