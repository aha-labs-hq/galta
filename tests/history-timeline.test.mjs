import { test, expect } from 'bun:test'
import { historyTimeline, SESSION_GAP } from '../apps/extension/src/canvas/historyTimeline.ts'
import { missingObjects, takeBack, takeBackCount } from '../apps/extension/src/canvas/historyRecovery.ts'
import { nameVersion, restoreVersion } from '../apps/extension/src/canvas/workspace.ts'

const minute = 60_000
function workspace() {
  // 0 → 1 → 2 → 3 (current), and an older path 1 → a → b left behind by a restore.
  const commit = (id, parentId, createdAt, source = 'user') => [id, { id, projectId: 'p', branchId: 'b', parentId, createdAt, source, events: [] }]
  const commits = Object.fromEntries([commit('0', null, 0), commit('1', '0', 1 * minute), commit('a', '1', 2 * minute, 'agent'), commit('b', 'a', 3 * minute),
    commit('2', '1', 3 * minute + SESSION_GAP), commit('3', '2', 4 * minute + SESSION_GAP, 'import')])
  return { project: { id: 'p', headCommitId: '3', activeBranchId: 'b', branches: {}, commits }, captures: [],
    snapshots: Object.fromEntries(Object.keys(commits).map(id => [id, { document: { elements: [], files: {} }, label: id }])), namedVersions: [{ commitId: 'a', label: 'Bolder', savedAt: 1 }] }
}

test('one timeline holds every version in the order it was made, marking the current lineage and sessions', () => {
  const versions = historyTimeline(workspace())
  expect(versions.map(v => v.commit.id)).toEqual(['0', '1', 'a', 'b', '2', '3'])
  expect(versions.map(v => v.lineage)).toEqual([true, true, false, false, true, true])
  expect(versions.map(v => v.sessionStart)).toEqual([true, false, false, false, true, false])
  expect(versions.find(v => v.commit.id === 'a').name).toBe('Bolder')
  // Viewed from the older path, the lineage follows it instead.
  expect(historyTimeline(workspace(), 'b').filter(v => v.lineage).map(v => v.commit.id)).toEqual(['0', '1', 'a', 'b'])
})

test('a version is never placed before its parent, even when a clock stepped back', () => {
  const w = workspace()
  w.project.commits.b = { ...w.project.commits.b, createdAt: 0 }
  w.project.commits.a = { ...w.project.commits.a, createdAt: 2 * minute }
  const order = historyTimeline(w).map(v => v.commit.id)
  expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
  expect(order.indexOf('1')).toBeLessThan(order.indexOf('a'))
})

test('a broken ancestry fails visibly instead of hiding versions', () => {
  const w = workspace()
  w.project.commits['3'] = { ...w.project.commits['3'], parentId: 'missing' }
  expect(() => historyTimeline(w)).toThrow('incomplete')
})

test('names are metadata: naming, renaming and forgetting never touch artwork', () => {
  const original = workspace()
  const named = nameVersion(original, '2', '  Quiet  ')
  expect(named.namedVersions.map(item => [item.commitId, item.label])).toEqual([['a', 'Bolder'], ['2', 'Quiet']])
  expect(named.project).toBe(original.project); expect(named.snapshots).toBe(original.snapshots)
  expect(nameVersion(named, 'a', 'Louder').namedVersions[0].label).toBe('Louder')
  expect(nameVersion(named, 'a', ' ').namedVersions.map(item => item.commitId)).toEqual(['2'])
  expect(nameVersion(original, '2', '')).toBe(original)
  expect(nameVersion(named, '2', 'Quiet')).toBe(named)
  expect(() => nameVersion(original, 'missing', 'x')).toThrow('unavailable')
  expect(() => nameVersion(original, '2', 'x'.repeat(81))).toThrow('80')
})

test('restoring keeps every version and adds the restored canvas as a new one', () => {
  const original = workspace()
  const restored = restoreVersion(original, 'a', '3', { scrollX: 0, scrollY: 0, zoom: 1 })
  const head = restored.project.headCommitId
  expect(restored.project.commits[head].parentId).toBe('a')
  expect(restored.snapshots[head]).toBe(original.snapshots.a)
  for (const id of Object.keys(original.project.commits)) expect(restored.snapshots[id]).toBe(original.snapshots[id])
  expect(historyTimeline(restored).at(-1).commit.id).toBe(head)
  expect(() => restoreVersion(original, 'a', '2', { scrollX: 0, scrollY: 0, zoom: 1 })).toThrow('Another window')
})

const base = { angle: 0, groupIds: [], frameId: null, boundElements: null, isDeleted: false, version: 3, versionNonce: 7, index: 'a0', width: 10, height: 10, x: 0, y: 0 }
test('taking back keeps who objects are and makes their relationships whole', () => {
  const version = { files: { f1: { id: 'f1', mimeType: 'image/png' }, f2: { id: 'f2', mimeType: 'image/png' } }, elements: [
    { ...base, id: 'kept', type: 'rectangle', boundElements: [{ id: 'arrow', type: 'arrow' }] },
    { ...base, id: 'box', type: 'rectangle', groupIds: ['g'], boundElements: [{ id: 'label', type: 'text' }, { id: 'arrow', type: 'arrow' }] },
    { ...base, id: 'label', type: 'text', containerId: 'box', groupIds: ['g'] },
    { ...base, id: 'arrow', type: 'arrow', startBinding: { elementId: 'box', focus: 0, gap: 1 }, endBinding: { elementId: 'kept', focus: 0, gap: 1 } },
    { ...base, id: 'photo', type: 'image', fileId: 'f1', frameId: 'gone-frame' },
    { ...base, id: 'old', type: 'image', fileId: 'f2', isDeleted: true }
  ] }
  // The canvas deleted the box (its record stays) and lost the rest; `kept` no longer lists the arrow.
  const current = { files: { f9: { id: 'f9', mimeType: 'image/png' } }, elements: [{ ...base, id: 'box', type: 'rectangle', isDeleted: true, version: 7 }, { ...base, id: 'kept', type: 'rectangle', boundElements: null }] }
  const missing = missingObjects(version, current).map(e => e.id)
  expect(missing).toEqual(['box', 'label', 'arrow', 'photo'])
  const { elements, files, ids } = takeBack(version, current, missing, 5)
  const at = Object.fromEntries(elements.map(e => [e.id, e]))
  expect(ids).toEqual(['box', 'label', 'arrow', 'photo'])
  // The box is revived in its own place; the others are added after the canvas's own objects.
  expect(elements.map(e => e.id)).toEqual(['box', 'kept', 'label', 'arrow', 'photo'])
  expect(at.box.isDeleted).toBe(false); expect(at.box.version).toBe(8); expect(at.box.updated).toBe(5)
  expect(at.label.containerId).toBe('box')
  expect(at.box.boundElements).toEqual([{ id: 'label', type: 'text' }, { id: 'arrow', type: 'arrow' }])
  expect(at.box.groupIds).toEqual(['g']); expect(at.label.groupIds).toEqual(['g'])
  // The arrow reconnects to the target that stayed, and the target lists it again.
  expect(at.arrow.startBinding.elementId).toBe('box'); expect(at.arrow.endBinding.elementId).toBe('kept')
  expect(at.kept.boundElements).toEqual([{ id: 'arrow', type: 'arrow' }]); expect(at.kept.version).toBe(4)
  expect(at.photo.frameId).toBeNull()
  expect(Object.keys(files)).toEqual(['f1'])
  expect(takeBack(current, current, ['box', 'kept']).ids).toEqual([])
})

test('a caption rejoins its group, a label its box unless the box has another, and a member its frame where it fits', () => {
  const group = (id, extra = {}) => ({ ...base, id, type: 'rectangle', groupIds: ['g'], ...extra })
  const before = { files: {}, elements: [group('a'), group('b'), group('c', { type: 'text', text: 'Caption' })] }
  const now = { files: {}, elements: [group('a'), group('b'), group('c', { type: 'text', isDeleted: true })] }
  expect(takeBack(before, now, ['a', 'b', 'c']).elements.filter(e => !e.isDeleted).map(e => [e.id, e.groupIds])).toEqual([['a', ['g']], ['b', ['g']], ['c', ['g']]])
  // A box that has a new label keeps it; the old label comes back free.
  const was = { files: {}, elements: [{ ...base, id: 'box', type: 'rectangle', boundElements: [{ id: 'old', type: 'text' }] }, { ...base, id: 'old', type: 'text', containerId: 'box' }] }
  const is = { files: {}, elements: [{ ...base, id: 'box', type: 'rectangle', boundElements: [{ id: 'new', type: 'text' }] }, { ...base, id: 'new', type: 'text', containerId: 'box' }] }
  const taken = Object.fromEntries(takeBack(was, is, ['old']).elements.map(e => [e.id, e]))
  expect(taken.old.containerId).toBeNull(); expect(taken.box.boundElements).toEqual([{ id: 'new', type: 'text' }])
  // A frame taken back with its member keeps it; a member alone rejoins a frame that stayed only where it fits.
  const framedThen = { files: {}, elements: [{ ...base, id: 'frame', type: 'frame', width: 400, height: 400 }, { ...base, id: 'in', type: 'rectangle', frameId: 'frame', x: 300, y: 10 }, { ...base, id: 'out', type: 'rectangle', frameId: 'frame', x: 395, y: 10 }] }
  const framedNow = { files: {}, elements: [{ ...base, id: 'frame', type: 'frame', width: 100, height: 100, version: 3 }] }
  expect(takeBack(framedThen, framedNow, ['frame', 'in']).elements.find(e => e.id === 'in').frameId).toBe('frame')
  expect(takeBack(framedThen, framedNow, ['in', 'out']).elements.filter(e => e.id !== 'frame').map(e => e.frameId)).toEqual([null, null])
  // Only differences someone can see count: an absent and an empty relation list are the same.
  const plain = { files: {}, elements: [{ ...base, id: 'x', type: 'rectangle', boundElements: [] }] }
  expect(takeBackCount(plain, { files: {}, elements: [{ ...base, id: 'x', type: 'rectangle', boundElements: null, version: 9 }] }, ['x'])).toBe(0)
})

test('taking a box back keeps the labels and arrows that now point at it', () => {
  const box = { ...base, id: 'box', type: 'rectangle' }
  const label = { ...base, id: 'label', type: 'text', containerId: 'box' }
  const arrow = { ...base, id: 'arrow', type: 'arrow', startBinding: { elementId: 'box', focus: 0, gap: 1 }, endBinding: null }
  const past = { files: {}, elements: [box] }
  const current = { files: {}, elements: [{ ...box, x: 50, boundElements: [{ id: 'label', type: 'text' }, { id: 'arrow', type: 'arrow' }] }, label, arrow] }
  const result = takeBack(past, current, ['box']).elements
  expect(result[0].boundElements).toEqual(current.elements[0].boundElements)
  expect(result[1]).toBe(label); expect(result[2]).toBe(arrow)
})

test('taking a connection back removes its reciprocal binding from the target it leaves', () => {
  const a = { ...base, id: 'a', type: 'rectangle', boundElements: [{ id: 'arrow', type: 'arrow' }] }
  const b = { ...base, id: 'b', type: 'rectangle' }
  const arrow = { ...base, id: 'arrow', type: 'arrow', startBinding: { elementId: 'a', focus: 0, gap: 1 }, endBinding: null }
  const past = { files: {}, elements: [a, b, arrow] }
  const current = { files: {}, elements: [{ ...a, boundElements: null }, { ...b, boundElements: a.boundElements }, { ...arrow, startBinding: { elementId: 'b', focus: 0, gap: 1 } }] }
  const result = Object.fromEntries(takeBack(past, current, ['arrow']).elements.map(element => [element.id, element]))
  expect(result.a.boundElements).toEqual([{ id: 'arrow', type: 'arrow' }])
  expect(result.b.boundElements).toBeNull()
  expect(result.arrow.startBinding.elementId).toBe('a')
})

test('taking a box and its old label back preserves the new label already in the box', () => {
  const box = { ...base, id: 'box', type: 'rectangle', boundElements: [{ id: 'old', type: 'text' }] }
  const old = { ...base, id: 'old', type: 'text', containerId: 'box' }
  const fresh = { ...old, id: 'new' }
  const past = { files: {}, elements: [box, old] }
  const current = { files: {}, elements: [{ ...box, x: 50, boundElements: [{ id: 'new', type: 'text' }] }, fresh] }
  const result = Object.fromEntries(takeBack(past, current, ['box', 'old']).elements.map(element => [element.id, element]))
  expect(result.box.boundElements).toEqual([{ id: 'new', type: 'text' }])
  expect(result.old.containerId).toBeNull()
  expect(result.new).toBe(fresh)
})

test('a relation that only changed elsewhere is not something to take back', () => {
  // The box once listed an arrow that has since gone; nothing visible about the box changed.
  const then = { files: {}, elements: [{ ...base, id: 'box', type: 'rectangle', boundElements: [{ id: 'gone', type: 'arrow' }] }] }
  const now = { files: {}, elements: [{ ...base, id: 'box', type: 'rectangle', boundElements: null, version: 8 }] }
  expect(takeBackCount(then, now, ['box'])).toBe(0)
  expect(takeBack(then, now, ['box']).elements[0]).toBe(now.elements[0])
})

