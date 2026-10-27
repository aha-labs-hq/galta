import { test, expect } from 'bun:test'
import { normalizeFreeDraw } from '../apps/extension/src/canvas/freeDraw.ts'

const stroke = (points, extra = {}) => ({ type: 'freedraw', id: 'brush', x: 50, y: 655, width: 200, height: 140, angle: .7,
  points, pressures: [], simulatePressure: true, lastCommittedPoint: points?.at(-1),
  version: 7, versionNonce: 42, updated: 123, seed: 90, groupIds: ['dog'], customData: { note: 'keep' }, ...extra })

test('normalizing brush coordinates preserves every rotated world point and metadata', () => {
  const world = e => {
    const xs = e.points.map(p => p[0]), ys = e.points.map(p => p[1])
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2
    return e.points.map(([x, y]) => [e.x + cx + (x - cx) * Math.cos(e.angle) - (y - cy) * Math.sin(e.angle), e.y + cy + (x - cx) * Math.sin(e.angle) + (y - cy) * Math.cos(e.angle)])
  }
  for (const points of [
    [[31, 106], [14, 219], [90, 150]], [[-90, -150], [-14, -219], [-31, -106]],
    [[0, 0], [-17, 113], [59, 44]], [[20, 40], [20, 140]], [[20, 40], [120, 40]], [[10, 10], [10, 10]],
    [[.1, .2], [.3, .9], [-.07, -.31]]
  ]) {
    const old = stroke(points), original = structuredClone(old), next = normalizeFreeDraw(old)
    expect(old).toEqual(original)
    expect(next.points[0]).toEqual([0, 0])
    const after = world(next)
    world(old).forEach((p, i) => p.forEach((n, axis) => expect(after[i][axis]).toBeCloseTo(n, 10)))
    expect([next.x + next.lastCommittedPoint[0], next.y + next.lastCommittedPoint[1]]).toEqual([old.x + old.lastCommittedPoint[0], old.y + old.lastCommittedPoint[1]])
    for (const key of ['id', 'angle', 'pressures', 'simulatePressure', 'version', 'versionNonce', 'updated', 'seed', 'groupIds', 'customData']) expect(next[key]).toEqual(old[key])
    expect(normalizeFreeDraw(next)).toBe(next)
  }
})

test('bad points and active pressure mismatch fail; simulated pressure data is preserved', () => {
  for (const points of [undefined, [], [[NaN, 0]], [[0, Infinity]], [[1]], [[1, 2, 3]]]) expect(() => normalizeFreeDraw(stroke(points, { lastCommittedPoint: null }))).toThrow()
  for (const extra of [{ pressures: [2] }, { pressures: undefined }, { simulatePressure: false, pressures: [.5] }]) expect(() => normalizeFreeDraw(stroke([[0, 0], [10, 10]], extra))).toThrow()
  const e = stroke([[0, 0], [10, 10]], { pressures: [.5], simulatePressure: true })
  expect(normalizeFreeDraw(e).pressures).toEqual([.5])
  const native = stroke([[0, 0], [-10, 20]], { width: 10, height: 20 })
  expect(normalizeFreeDraw(native)).toBe(native)
  const box = { type: 'rectangle', id: 'box' }
  expect(normalizeFreeDraw(box)).toBe(box)
})

test('fractional coordinates normalize idempotently without accumulated rounding', () => {
  for (let i = 1; i < 100; i++) {
    const e = normalizeFreeDraw(stroke([[i / 7, i / 3], [-i / 11, i / 13], [i / 17, -i / 19]]))
    expect(normalizeFreeDraw(e)).toBe(e)
  }
})
