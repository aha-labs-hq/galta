import { test, expect } from 'bun:test'
import { PointerWaves, MAX_POINTER_WAVES } from '../apps/extension/src/recording/PointerWaves'
import { PointerTrail } from '../apps/extension/src/recording/PointerTrail'

const waves = () => new PointerWaves({ radius: 64, band: 11, dot: 2.5, duration: 760, attack: 80, release: 520, interval: 270, spacing: 40, reach: 176, travelRelease: 80 })
const live = value => Array.from({ length: MAX_POINTER_WAVES }, (_, i) => Array.from(value.data.slice(i * 4, i * 4 + 4))).filter(row => row[3] > 0)

test('an emitted wave keeps its birth position as the pointer moves and reverses', () => {
  const value = waves()
  value.move(100, 100, 0); value.update(0, 1)
  value.move(180, 100, 100); value.update(140, 1)
  expect(live(value).map(row => row.slice(0, 2))).toEqual([[100, 100], [140, 100], [180, 100]])
  value.move(140, 100, 160); value.update(200, 1)
  expect(live(value).slice(0, 3).map(row => row.slice(0, 2))).toEqual([[100, 100], [140, 100], [180, 100]])
})

test('spatial emissions interpolate the observed path independently of delivery batching', () => {
  const single = waves(), batched = waves()
  for (const value of [single, batched]) { value.move(0, 0, 0); value.update(0, 1) }
  single.move(160, 80, 200)
  for (let i = 1; i <= 20; i++) { batched.move(i * 8, i * 4, i * 10); batched.update(i * 10, 1) }
  single.update(240, 1); batched.update(240, 1)
  expect(single.data).toEqual(batched.data)
})

test('travel expiry cannot resurrect a wave after returning to its origin', () => {
  const value = waves()
  value.move(0, 0, 0); value.update(0, 1); value.update(80, 0)
  value.move(180, 0, 100); expect(value.update(100, 0)).toBe(0)
  value.move(0, 0, 200); expect(value.update(200, 0)).toBe(0)
})

test('a move after a long dwell emits fresh waves rather than ageing them through the pause', () => {
  const value = waves()
  value.move(0, 0, 0); value.update(0, 1); value.update(1000, 1)
  value.move(80, 0, 1016); value.update(1056, 1)
  expect(live(value).map(([x]) => x)).toEqual([0, 40, 80])
  expect(live(value).every(([, , radius]) => radius < 12)).toBe(true)
})

test('silence stops emitting while existing waves finish, and clear removes the wake', () => {
  const value = waves()
  value.move(0, 0, 0); value.update(0, 1)
  expect(value.update(100, 0)).toBe(1)
  value.move(80, 0, 200); value.update(200, 0)
  expect(live(value).map(row => row.slice(0, 2))).toEqual([[0, 0]])
  expect(value.update(760, 0)).toBe(0)
  value.update(800, 1); value.update(900, 1); value.clear()
  expect(value.count).toBe(0); expect(value.data.every(n => n === 0)).toBe(true)
})

test('fast sweeps and reversals keep the entire wake and ribbon inside one local surface', () => {
  const value = waves(), trail = new PointerTrail(360, 220, 2.4, 3, 6)
  for (let i = 0; i < 4000; i++) {
    const x = Math.cos(i / 80) * 300, y = Math.sin(i / 45) * 180
    value.move(x, y, i); value.update(i, .7); trail.add(x, y, i); trail.update(i)
    const a = value.bounds, b = trail.bounds
    const left = Math.min(x, value.count ? a.left : x, trail.count ? b.left - 6 : x)
    const right = Math.max(x, value.count ? a.right : x, trail.count ? b.right + 6 : x)
    const top = Math.min(y, value.count ? a.top : y, trail.count ? b.top - 6 : y)
    const bottom = Math.max(y, value.count ? a.bottom : y, trail.count ? b.bottom + 6 : y)
    if (right - left >= 336 || bottom - top >= 336) throw new Error('Wake clipped')
  }
  expect(value.data.every(Number.isFinite)).toBe(true)
})

test('a large input jump skips expired births rather than replaying unbounded work', () => {
  const value = waves()
  value.move(0, 0, 0); value.update(0, 1)
  value.move(1_000_000, 0, 100); value.update(150, 1)
  expect(value.count).toBeGreaterThan(0)
  expect(value.count).toBeLessThanOrEqual(MAX_POINTER_WAVES)
  expect(live(value).every(([x]) => x >= 1_000_000 - 176)).toBe(true)
})
