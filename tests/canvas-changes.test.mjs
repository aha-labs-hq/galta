import { test, expect } from 'bun:test'
import { canvasChanges } from '../apps/extension/src/canvas/canvasChanges'

const element = (id, extra = {}) => ({ id, type: 'freedraw', x: 0, y: 0, points: [[0, 0], [10, 20]], ...extra })
function history(versions) {
  const commits = {}, snapshots = {}
  for (const [id, parentId, source, elements] of versions) {
    commits[id] = { id, parentId, source }
    snapshots[id] = { document: { elements, files: {} } }
  }
  return { project: { commits }, snapshots }
}

test('initial observations and unchanged documents never fabricate recent user activity', () => {
  const workspace = history([['a', null, 'user', [element('draw')]]])
  expect(canvasChanges(workspace, 'a', null)).toEqual({ since: null, status: 'initial', elements: [] })
  expect(canvasChanges(workspace, 'a', 'a')).toEqual({ since: 'a', status: 'compared', elements: [] })
})

test('net differences include unselected drawings, removals and recorded authorship', () => {
  const base = [element('edited'), element('removed')]
  const imported = [...base, element('imported', { type: 'image', fileId: 'image-a' })]
  const agent = [element('edited', { x: 20 }), ...imported.slice(1), element('agent-created')]
  const user = [element('edited', { x: 40 }), ...agent.slice(2), element('unselected-draw')]
  const workspace = history([['a', null, 'user', base], ['b', 'a', 'import', imported], ['c', 'b', 'agent', agent], ['d', 'c', 'user', user]])
  expect(canvasChanges(workspace, 'd', 'a')).toEqual({ since: 'a', status: 'compared', elements: [
    { id: 'edited', change: 'updated', sources: ['agent', 'user'] },
    { id: 'removed', change: 'deleted', sources: ['user'] },
    { id: 'imported', change: 'created', sources: ['import'] },
    { id: 'agent-created', change: 'created', sources: ['agent'] },
    { id: 'unselected-draw', change: 'created', sources: ['user'] }
  ] })
})

test('undo bookkeeping and reverted edits have no net content change', () => {
  const base = [element('draw', { lastCommittedPoint: [10, 20], boundElements: null })]
  const workspace = history([
    ['a', null, 'user', base],
    ['b', 'a', 'agent', [element('draw', { x: 20 }), element('temporary')]],
    ['c', 'b', 'user', [element('draw', { version: 8, versionNonce: 20, updated: 1000, lastCommittedPoint: null, boundElements: [] }), element('temporary', { isDeleted: true })]]
  ])
  expect(canvasChanges(workspace, 'c', 'a').elements).toEqual([])
  expect(canvasChanges(workspace, 'c', 'b').elements).toEqual([
    { id: 'draw', change: 'updated', sources: ['user'] }, { id: 'temporary', change: 'deleted', sources: ['user'] }
  ])
})

test('forks compare only against an actual ancestor', () => {
  const workspace = history([['a', null, 'user', []], ['b', 'a', 'agent', [element('left')]], ['c', 'a', 'user', [element('right')]]])
  expect(canvasChanges(workspace, 'c', 'b')).toEqual({ since: 'b', status: 'unrelated-history', elements: [] })
  expect(canvasChanges(workspace, 'c', 'a').elements).toEqual([{ id: 'right', change: 'created', sources: ['user'] }])
})

test('broken history fails with the identity of the missing or cyclic version', () => {
  const workspace = history([['a', null, 'user', []], ['b', 'a', 'agent', [element('draw')]]])
  expect(() => canvasChanges(workspace, 'missing', 'a')).toThrow('missing version missing')
  delete workspace.snapshots.a
  expect(() => canvasChanges(workspace, 'b', 'a')).toThrow('missing document a')
  workspace.project.commits.a.parentId = 'b'
  expect(() => canvasChanges(workspace, 'b', 'other')).toThrow('cycle at b')
})
