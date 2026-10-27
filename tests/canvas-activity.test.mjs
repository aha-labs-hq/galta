import { test, expect } from 'bun:test'
import { conversationItem } from '../packages/runtime/src/codex'
import { activityText, activityDetails, hasActivityDetails } from '../apps/extension/src/canvas/conversationActivity'

const item = (tool, receipt, extra = {}) => conversationItem({ id: 'call', type: 'mcpToolCall', server: 'galta', tool, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(receipt) }] }, ...extra }, 'completed')
test('live/restored activity describes confirmed additions, replacements and native batch effects', () => {
  expect(activityText(item('canvas_place', { revision: 'r', action: 'updated', kind: 'image' }))).toBe('Replaced the image')
  expect(activityText(item('canvas_place', { revision: 'r', action: 'created', kind: 'video' }))).toBe('Added the video')
  const batch = item('canvas_edit', { revision: 'r', elements: [{ change: 'created' }, { change: 'updated' }], deletedIds: ['removed'] })
  expect(batch.canvasChanges).toEqual({ created: 1, updated: 1, deleted: 1 })
  expect(activityText(batch)).toBe('Updated 3 canvas objects')
  expect(activityDetails(batch, 1000).text).toContain('1 added, 1 updated, 1 removed')
})
test('failures, in-flight requests, old receipts and other servers cannot invent successful replacements', () => {
  const receipt = { revision: 'r', action: 'updated', kind: 'image' }
  for (const extra of [{ status: 'failed' }, { status: 'inProgress' }, { server: 'other' }, { result: { isError: true, content: [] } }]) {
    expect(item('canvas_place', receipt, extra).canvasChanges).toBeUndefined()
  }
  expect(activityText(item('canvas_place', receipt, { status: 'failed' }))).toBe('Canvas operation failed')
  expect(activityText(item('canvas_place', { placed: true, revision: 'old' }))).toBe('Updated the canvas')
  expect(item('canvas_edit', { revision: 'r', elements: [null], deletedIds: [] }).canvasChanges).toBeUndefined()
})

test('provider-declined work is not presented as completed', () => {
  expect(activityText({ id: 'command', type: 'commandExecution', text: 'rm -rf', status: 'declined' })).toBe('Command declined')
  expect(activityText({ id: 'change', type: 'fileChange', text: 'Editing files', status: 'declined' })).toBe('File change declined')
})

test('confirmed changes record where they landed, without inventing geometry', () => {
  const bounds = (x, y, width, height) => ({ x, y, width, height })
  const batch = item('canvas_edit', { revision: 'r', deletedIds: ['gone'], elements: [
    { id: 'a', change: 'created', bounds: bounds(10, 20, 100, 50) },
    { id: 'b', change: 'updated', bounds: bounds(-40, 60, 20, 30) },
    { id: 'c', change: 'updated', bounds: bounds(0, 0, Number.NaN, 4) }] })
  expect(batch.canvasChanges).toEqual({ created: 1, updated: 2, deleted: 1, region: { ids: ['a', 'b'], bounds: bounds(-40, 20, 150, 70) } })
  const placed = item('canvas_place', { revision: 'r', action: 'created', kind: 'image', elementId: 'img', element: { id: 'img', bounds: bounds(5, 6, 7, 8) } })
  expect(placed.canvasChanges?.region).toEqual({ ids: ['img'], bounds: bounds(5, 6, 7, 8) })
  const many = item('canvas_edit', { revision: 'r', deletedIds: [], elements: Array.from({ length: 80 }, (_, i) => ({ id: `e${i}`, change: 'created', bounds: bounds(i, 0, 1, 1) })) })
  expect(many.canvasChanges?.region?.ids).toHaveLength(64)
  expect(many.canvasChanges?.region?.bounds).toEqual(bounds(0, 0, 80, 1))
})
test('a step opens only onto something to read', () => {
  expect(hasActivityDetails({ id: 'r', type: 'reasoning', text: 'Thinking', status: 'completed' })).toBe(false)
  expect(activityDetails({ id: 'r', type: 'reasoning', text: 'Thinking', status: 'completed' }, 1000).text).toBe('')
  expect(hasActivityDetails({ id: 'r', type: 'reasoning', text: 'Thinking', status: 'completed', details: '**Checking the composition**' })).toBe(true)
  expect(hasActivityDetails({ id: 'v', type: 'dynamicToolCall', tool: 'canvas_inspect', text: 'Canvas: status', status: 'completed' })).toBe(false)
  expect(hasActivityDetails({ id: 'c', type: 'commandExecution', text: 'pwd', status: 'completed' })).toBe(true)
  expect(hasActivityDetails({ id: 'e', type: 'webSearch', text: 'Searching the web', status: 'failed', error: 'Offline' })).toBe(true)
  expect(activityText({ id: 'k', type: 'contextCompaction', text: 'Condensing earlier context', status: 'inProgress' })).toBe('Condensing earlier context')
  expect(activityText({ id: 'k', type: 'contextCompaction', text: 'Condensing earlier context', status: 'completed' })).toBe('Earlier context condensed')
})
