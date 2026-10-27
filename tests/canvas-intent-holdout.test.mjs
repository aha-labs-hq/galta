import { test, expect } from 'bun:test'
import { createCanvasIntentHoldout } from '../scripts/lib/canvas-intent-holdout.ts'

test('intent holdouts are reproducible and opaque', () => {
  const first = createCanvasIntentHoldout('holdout-seed-a')
  const replay = createCanvasIntentHoldout('holdout-seed-a')
  expect(replay).toEqual(first)
  expect(first.oldImageName).not.toBe(first.selectedImageName)
  expect(first.oldImageName).toMatch(/^asset-[a-f0-9]{10}\.png$/)
  expect(first.selectedImageName).toMatch(/^asset-[a-f0-9]{10}\.png$/)
  expect(first.oldImageName).not.toMatch(/archive|focus|selected|previous|export/i)
  expect(first.selectedImageName).not.toMatch(/archive|focus|selected|previous|export/i)
  expect(first.staleOutputName).not.toMatch(/archive|focus|selected|previous|export/i)
  for (const prompt of Object.values(first.prompts)) expect(prompt).not.toMatch(/canvas_|browser_|element|tool|MCP|\/tmp|outputs\//i)
  expect(first.prompts.deliverSelected).not.toMatch(/选中|选区|canvas_extract|focus|archive|previous-export/i)
  expect(first.prompts.unsupported).not.toMatch(/选中|选区|canvas_extract|focus|archive|previous-export/i)
})

test('holdouts vary object order and composition as well as names', () => {
  const fixtures = Array.from({ length: 40 }, (_, i) => createCanvasIntentHoldout(`layout-${i}`))
  expect(new Set(fixtures.map(item => item.selectedFirst)).size).toBe(2)
  expect(new Set(fixtures.map(item => item.overlap)).size).toBe(2)
  expect(new Set(fixtures.map(item => `${item.selectedFirst}/${item.overlap}`)).size).toBe(4)
  for (const item of fixtures) expect(new Set([item.oldImageName, item.selectedImageName, item.staleOutputName]).size).toBe(3)
})

test('different holdout seeds change fixture identity', () => {
  const first = createCanvasIntentHoldout('holdout-seed-a')
  const second = createCanvasIntentHoldout('holdout-seed-b')
  expect(second.seed).not.toBe(first.seed)
  expect(second.staleOutputName).not.toBe(first.staleOutputName)
  expect(second.selectedLabel).not.toBe(first.selectedLabel)
})
