import { test, expect } from 'bun:test'
import { bearing, flightPath, frameRegion, inView, visibleRect } from '../apps/extension/src/canvas/flight'
import { plainText } from '../apps/extension/src/canvas/conversationText'
import { narration, sentences } from '../apps/extension/src/canvas/narration'

const view = (x, y, span) => ({ center: { x, y }, span })
const frame = { width: 800, height: 600 }

test('a flight starts and ends exactly at its views, and zooms out to travel far', () => {
  const from = view(0, 0, 600), to = view(6000, 3000, 600), path = flightPath(from, to)
  for (const [t, expected] of [[0, from], [1, to]]) {
    const at = path.at(t)
    expect(at.center.x).toBeCloseTo(expected.center.x, 6); expect(at.center.y).toBeCloseTo(expected.center.y, 6); expect(at.span).toBeCloseTo(expected.span, 6)
  }
  expect(path.at(.5).span).toBeGreaterThan(1200)
  expect(path.length).toBeGreaterThan(0)
  const zoom = flightPath(view(10, 10, 600), view(10, 10, 150))
  expect(zoom.at(.5).center).toEqual({ x: 10, y: 10 })
  expect(zoom.at(1).span).toBeCloseTo(150, 6)
  expect(flightPath(view(0, 0, 600), view(30, 0, 600)).length).toBeLessThan(path.length)
})

test('framing changes the camera as little as it can', () => {
  const region = { x: 1000, y: 1000, width: 200, height: 100 }
  // Fits at the current zoom: travel only.
  expect(frameRegion(region, frame, view(0, 0, 600), 56)).toEqual(view(1100, 1050, 600))
  // Too large to fit: zoom out to fit inside the margin.
  const large = frameRegion({ x: 0, y: 0, width: 4000, height: 1000 }, frame, view(0, 0, 600), 56)
  expect(600 / large.span).toBeCloseTo((800 - 112) / 4000, 6)
  // Too small to read from far away: up to actual size, never past it.
  expect(frameRegion(region, frame, view(0, 0, 6000), 56).span).toBeCloseTo(600, 6)
  expect(frameRegion({ x: 0, y: 0, width: 10, height: 10 }, frame, view(0, 0, 6000), 56).span).toBeCloseTo(600, 6)
})

test('a change is in view when most of it shows, or when it fills the view', () => {
  const visible = visibleRect(view(0, 0, 600), frame)
  expect(visible).toEqual({ x: -400, y: -300, width: 800, height: 600 })
  expect(inView({ x: -50, y: -50, width: 100, height: 100 }, visible)).toBe(true)
  expect(inView({ x: 380, y: 0, width: 100, height: 100 }, visible)).toBe(false)
  expect(inView({ x: 2000, y: 2000, width: 100, height: 100 }, visible)).toBe(false)
  expect(inView({ x: -1000, y: -1000, width: 3000, height: 3000 }, visible)).toBe(true)
})

test('bearings read like a screen arrow: up, right, down, left', () => {
  const at = (x, y) => bearing({ x: x - 5, y: y - 5, width: 10, height: 10 }, view(0, 0, 600))
  expect(at(0, -100)).toBeCloseTo(0, 6); expect(at(100, 0)).toBeCloseTo(90, 6)
  expect(at(0, 100)).toBeCloseTo(180, 6); expect(at(-100, 0)).toBeCloseTo(270, 6)
})

test('agent prose reads as plain words in a caption', () => {
  expect(plainText('## Light\n\nI will **soften** the [entrance](https://example.com) and keep `glass`.\n\n- one\n- two')).toBe('Light I will soften the entrance and keep glass. one two')
  expect(plainText('I will **soften the')).toBe('I will soften the')
  expect(plainText('')).toBe('')
})

test('the closed composer speaks one sentence at a time', () => {
  expect(sentences('我先看一下构图。然后把高光降低一档！Version 1.5 keeps the file name.png intact. Done')).toEqual(['我先看一下构图。', '然后把高光降低一档！', 'Version 1.5 keeps the file name.png intact.', 'Done'])
  const turn = { id: 't', instruction: 'x', status: 'streaming', items: [
    { id: 'c', type: 'agentMessage', phase: 'commentary', status: 'completed', text: 'I will look first. Then I will **soften** the light.' },
    { id: 'tool', type: 'mcpToolCall', server: 'galta', tool: 'canvas_capture', text: 'canvas_capture', status: 'inProgress' }] }
  expect(narration(turn, false)).toEqual({ key: 'c:1', text: 'Then I will soften the light.' })
  turn.items.push({ id: 'a', type: 'agentMessage', phase: 'final_answer', status: 'completed', text: '入口的光线更柔和了。保留了轮廓。' })
  expect(narration(turn, false)).toEqual({ key: 'a:1', text: '保留了轮廓。' })
  expect(narration(turn, true)).toEqual({ key: 'a:0', text: '入口的光线更柔和了。' })
  expect(narration({ ...turn, items: [turn.items[1]] }, false)).toBeNull()
})
