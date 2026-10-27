import { test, expect } from 'bun:test'
import { shareWorkspaceAssets } from '../packages/storage/src/workspaceAssets.ts'

test('HTML source shares storage across moved versions while updates retain prior documents', () => {
  const snapshot = (html, x) => ({ document: { files: {}, elements: [{ id: 'html-1', type: 'embeddable', x, customData: { htmlDocument: { html }, generatedPath: '/page.html' } }] } })
  const original = { snapshots: { a: snapshot('<html>one</html>', 10), b: snapshot('<html>one</html>', 20), c: snapshot('<html>two</html>', 30) } }
  const result = shareWorkspaceAssets(original), doc = id => result.snapshots[id].document.elements[0].customData.htmlDocument
  expect(doc('a')).toBe(doc('b'))
  expect(doc('c')).not.toBe(doc('a'))
  expect(original.snapshots.b.document.elements[0].customData.htmlDocument).not.toBe(doc('a'))
  expect(result).toEqual(original)
  expect(shareWorkspaceAssets(result)).toBe(result)
  const cloned = structuredClone(result)
  expect(cloned.snapshots.a.document.elements[0].customData.htmlDocument).toBe(cloned.snapshots.b.document.elements[0].customData.htmlDocument)
})
import { createInitialWorkspace, initializeWorkspaceSnapshot, commitWorkspaceSnapshot, stageAgentSnapshot, defaultRuntime } from '../apps/extension/src/canvas/workspace.ts'

test('brush history shares exact geometry across moves, but preserves edited points and pressure', () => {
  const stroke = { id: 'stroke', type: 'freedraw', x: 0, points: [[0, 0], [10, -0], [20, 30]], pressures: [.2, .4, .6], version: 1 }
  const snapshot = element => ({ document: { elements: [structuredClone(element)] } })
  const original = { snapshots: {
    a: snapshot(stroke), moved: snapshot({ ...stroke, x: 100, version: 2 }),
    edit: snapshot({ ...stroke, points: [[0, 0], [10, 1], [20, 30]] }),
    pressure: snapshot({ ...stroke, pressures: [.2, .8, .6] }),
    signedZero: snapshot({ ...stroke, points: [[0, 0], [10, 0], [20, 30]] })
  } }
  const result = shareWorkspaceAssets(original), element = id => result.snapshots[id].document.elements[0]
  expect(result).toEqual(original)
  expect(element('a').points).toBe(element('moved').points)
  expect(element('a').pressures).toBe(element('moved').pressures)
  expect(element('a').points).not.toBe(element('edit').points)
  expect(element('a').points).not.toBe(element('signedZero').points)
  expect(element('a').pressures).not.toBe(element('pressure').pressures)
  expect(original.snapshots.a.document.elements[0].points).not.toBe(original.snapshots.moved.document.elements[0].points)
  expect(shareWorkspaceAssets(result)).toBe(result)
  const saved = structuredClone(result)
  expect(saved.snapshots.a.document.elements[0].points).toBe(saved.snapshots.moved.document.elements[0].points)
  const live = structuredClone(saved.snapshots.moved)
  live.document.elements[0].points[1][0] = 999
  expect(saved.snapshots.a.document.elements[0].points[1][0]).toBe(10)
})

test('history shares identical image records without changing pixels, metadata variants, or legacy snapshots', () => {
  const file = { id: 'image', dataURL: 'data:image/png;base64,' + 'a'.repeat(64_000), mimeType: 'image/png', created: 1 }
  const snapshot = { document: { elements: [{ id: 'shape', fileId: file.id }], files: { image: file } } }
  const snapshots = Object.fromEntries(Array.from({ length: 176 }, (_, i) => [String(i), structuredClone(snapshot)]))
  snapshots.metadata = { document: { files: { image: { ...file, lastRetrieved: 2 } } } }
  snapshots.changed = { document: { files: { image: { ...file, dataURL: 'data:image/png;base64,different' } } } }
  snapshots.legacy = { document: { store: { untouched: true } } }
  const original = { ...createInitialWorkspace(), snapshots }
  const result = shareWorkspaceAssets(original)
  expect(result).toEqual(original)
  expect(result.snapshots.legacy).toBe(original.snapshots.legacy)
  expect(result.snapshots.metadata.document.files.image.lastRetrieved).toBe(2)
  expect(result.snapshots.changed.document.files.image.dataURL).toEndWith('different')
  const restored = structuredClone(result)
  const versions = Array.from({ length: 176 }, (_, i) => restored.snapshots[String(i)].document.files.image)
  expect(new Set(versions).size).toBe(1)
  expect(original.snapshots['0'].document.files.image).not.toBe(original.snapshots['1'].document.files.image)
  expect(shareWorkspaceAssets(result)).toBe(result)
})

test('committing and staging new artwork retain immutable history and detach caller-owned snapshots', () => {
  let current = createInitialWorkspace()
  const root = current.project.headCommitId
  const before = { document: { elements: [{ id: 'original' }], files: {} } }
  current = initializeWorkspaceSnapshot(current, root, before)
  const drawing = { document: { elements: [{ id: 'drawing' }], files: {} } }
  const committed = commitWorkspaceSnapshot(current, root, drawing, 'user')
  expect(committed.snapshots[root]).toBe(before)
  drawing.document.elements[0].id = 'later edit'
  expect(committed.snapshots[committed.project.headCommitId].document.elements[0].id).toBe('drawing')
  const candidate = { document: { elements: [{ id: 'agent' }], files: {} } }
  const staged = stageAgentSnapshot(committed, committed.project.headCommitId, committed.snapshots[committed.project.headCommitId], candidate, defaultRuntime)
  expect(staged.workspace.snapshots[root]).toBe(before)
  expect(staged.workspace.snapshots[committed.project.headCommitId]).toBe(committed.snapshots[committed.project.headCommitId])
  candidate.document.elements[0].id = 'later agent edit'
  expect(staged.workspace.snapshots[staged.candidateId].document.elements[0].id).toBe('agent')
})

import { documentEquals } from '../apps/extension/src/canvas/documentEquality.ts'
test('document equality retains metadata edits and exact numeric geometry', () => {
  const value = { points: [[0, -0], [5, 6]], metadata: { date: new Date(10), map: new Map([['x', 1]]), values: new Float64Array([1, 2]) } }
  expect(documentEquals(value, structuredClone(value))).toBe(true)
  for (const mutate of [v => { v.points[0][1] = 0 }, v => { v.metadata.date = new Date(11) }, v => { v.metadata.map.set('x', 2) }, v => { v.metadata.values[0] = 9 }]) {
    const next = structuredClone(value); mutate(next); expect(documentEquals(value, next)).toBe(false)
  }
  const cyclic = { value: 1 }; cyclic.self = cyclic
  expect(documentEquals(cyclic, structuredClone(cyclic))).toBe(true)
  expect(documentEquals(new Array(2), [undefined, undefined])).toBe(false)
})
