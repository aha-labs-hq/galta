import { test, expect } from 'bun:test'
import { reusablePreview } from '../apps/extension/src/canvas/canvasMessage'

const viewport = { x: 0, y: 0, width: 800, height: 600, zoom: 1 }
const observed = (overrides = {}) => ({
  id: 'turn-1', instruction: 'Warm it up', status: 'completed', threadId: 'thread', turnId: 'remote-1', items: [],
  context: { canvasTitle: 'Study', selection: [], canvas: { commitId: 'commit', revision: 'r', preview: 'attached', viewport, previewEvidenceId: 'pixels-1' } },
  ...overrides
})
const session = (turns, threadId = 'thread') => ({ id: 'session', label: 'Study', threadId, turns })

test('an unchanged document and viewport in the same thread reuse the earlier preview', () => {
  expect(reusablePreview(session([observed()]), 'commit', { ...viewport })).toBe('pixels-1')
  // A chain of unchanged turns keeps naming the original attached preview.
  const unchanged = observed({ id: 'turn-2', turnId: 'remote-2', context: { canvasTitle: 'Study', selection: [], canvas: { commitId: 'commit', revision: 'r', preview: 'unchanged', viewport, previewEvidenceId: 'pixels-1' } } })
  expect(reusablePreview(session([observed(), unchanged]), 'commit', viewport)).toBe('pixels-1')
})

test('fresh pixels are required whenever the earlier image may not match or be present', () => {
  expect(reusablePreview(session([observed()]), 'other-commit', viewport)).toBeUndefined()
  expect(reusablePreview(session([observed()]), 'commit', { ...viewport, zoom: 2 })).toBeUndefined()
  expect(reusablePreview(session([observed()], 'another-thread'), 'commit', viewport)).toBeUndefined()
  expect(reusablePreview({ id: 'session', label: 'Study', turns: [observed()] }, 'commit', viewport)).toBeUndefined()
  const withoutPixels = observed({ context: { canvasTitle: 'Study', selection: [], canvas: { commitId: 'commit', revision: 'r', preview: 'empty', viewport } } })
  expect(reusablePreview(session([withoutPixels]), 'commit', viewport)).toBeUndefined()
  // Turns persisted before viewports were recorded cannot prove equality.
  const legacy = observed({ context: { canvasTitle: 'Study', selection: [], canvas: { commitId: 'commit', revision: 'r', preview: 'attached' } } })
  expect(reusablePreview(session([legacy]), 'commit', viewport)).toBeUndefined()
})

test('compaction after the observed turn drops the earlier image from context', () => {
  const compacted = { id: 'compact', type: 'contextCompaction', text: 'Condensing earlier context', status: 'completed' }
  expect(reusablePreview(session([observed({ items: [compacted] })]), 'commit', viewport)).toBeUndefined()
  const later = { id: 'turn-2', instruction: 'Thanks', status: 'failed', items: [compacted] }
  expect(reusablePreview(session([observed(), later]), 'commit', viewport)).toBeUndefined()
  expect(reusablePreview(session([observed(), { ...later, items: [] }]), 'commit', viewport)).toBe('pixels-1')
})
