import { test, expect } from 'bun:test'
import { arrangePlaces, fitInSlot } from '../packages/canvas/src/slots'

test('places without a position line up in one centred row; placed ones stay where they were put', () => {
  const boxes = arrangePlaces([{ width: 100, height: 50 }, { width: 200, height: 100, x: -500, y: 7 }, { width: 100, height: 150 }], { x: 0, y: 0 })
  expect(boxes).toEqual([
    { x: -116, y: -25, width: 100, height: 50 },
    { x: -500, y: 7, width: 200, height: 100 },
    { x: 16, y: -75, width: 100, height: 150 }
  ])
})

test('media is fitted inside a place in its own proportions, centred', () => {
  expect(fitInSlot({ x: 0, y: 0, width: 300, height: 300 }, 400, 200)).toEqual({ x: 0, y: 75, width: 300, height: 150 })
  expect(fitInSlot({ x: 10, y: 10, width: 160, height: 90 }, 1080, 1920)).toEqual({ x: 10 + (160 - 90 * 1080 / 1920) / 2, y: 10, width: 90 * 1080 / 1920, height: 90 })
})
