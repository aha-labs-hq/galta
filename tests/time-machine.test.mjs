import { test, expect } from 'bun:test'
import { historyMoments, EDIT_PAUSE, EDIT_BREAK, SESSION_GAP } from '../apps/extension/src/canvas/historyTimeline.ts'
import { multiverseLayout, pathTo } from '../apps/extension/src/canvas/historyLayout.ts'
import { documentChanges, summarizeChanges, changedObjects } from '../apps/extension/src/canvas/historyChanges.ts'
import { trimHistory } from '../apps/extension/src/canvas/historyTrim.ts'

let nonce = 1
const el = (id, fields = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, angle: 0, strokeColor: '#000', backgroundColor: 'transparent', groupIds: [], frameId: null, boundElements: null, isDeleted: false, version: 1, versionNonce: nonce++, ...fields })
const bump = (element, fields) => ({ ...element, ...fields, version: element.version + 1, versionNonce: nonce++ })
const doc = (...elements) => ({ document: { elements, files: {} } })

/** Build a workspace from rows of [id, parentId, time, source, snapshot]. */
function history(rows, { head = rows.at(-1)[0], names = [], sessions = [], checkpoints = {} } = {}) {
  const commits = {}, snapshots = {}
  for (const [id, parentId, createdAt, source, snapshot, runtime] of rows) {
    commits[id] = { id, projectId: 'p', branchId: 'b', parentId, createdAt, source, events: [], ...(runtime ? { runtime } : {}) }
    snapshots[id] = snapshot
  }
  return { project: { id: 'p', headCommitId: head, activeBranchId: 'b', branches: { b: { id: 'b', projectId: 'p', parentCommitId: null, headCommitId: head, createdAt: 0 } }, commits, createdAt: 0, updatedAt: 0, title: 't' },
    captures: [], snapshots, namedVersions: names.map(([commitId, label]) => ({ commitId, label, savedAt: 0 })), agentSessions: sessions, agentCheckpoints: checkpoints }
}

const a0 = el('a'), b0 = el('b')
const s0 = doc(), s1 = doc(a0), s2 = doc(bump(a0, { x: 5 })), s3 = doc(bump(a0, { x: 5 }), b0)

test('changes read as the user sees them, without engine-only revisions', () => {
  const moved = bump(a0, { x: 40 }), restyled = bump(b0, { strokeColor: '#f00' })
  expect(summarizeChanges(documentChanges(doc(a0, b0).document, doc(moved, b0).document))).toBe('Moved a shape')
  expect(summarizeChanges(documentChanges(doc(a0, b0).document, doc(moved, restyled).document))).toBe('Moved a shape, restyled a shape')
  const strokes = [el('s1', { type: 'freedraw', points: [] }), el('s2', { type: 'freedraw', points: [] })]
  expect(summarizeChanges(documentChanges(doc().document, doc(...strokes).document))).toBe('Drew 2 strokes')
  // A restore bumps revisions without changing content.
  expect(changedObjects(doc(a0).document, doc(bump(a0, {})).document)).toEqual([])
  expect(documentChanges(doc(a0).document, doc(bump(a0, { boundElements: [] })).document)).toEqual([])
  // Bound text follows its container.
  const box = el('box'), label = el('label', { type: 'text', text: 'Hi', containerId: 'box' })
  expect(summarizeChanges(documentChanges(doc(box, label).document, doc(bump(box, { x: 9 }), bump(label, { x: 9 })).document))).toBe('Moved a shape')
  expect(summarizeChanges(documentChanges(doc(box, label).document, doc(box, bump(label, { text: 'Hello', originalText: 'Hello' })).document))).toBe('Edited text')
})

test('a burst of edits is one moment until a pause, longer while it keeps working on the same objects', () => {
  const w = history([
    ['0', null, 0, 'user', s0],
    ['1', '0', 1000, 'user', s1],
    ['2', '1', 3000, 'user', s2],                       // same object, quick
    ['3', '2', 3000 + EDIT_PAUSE + 5000, 'user', doc(bump(a0, { x: 9 }))], // same object after a pause: continues
    ['4', '3', 3000 + EDIT_PAUSE * 3, 'user', doc(bump(a0, { x: 9 }), b0)], // new object after a pause: new moment
    ['5', '4', 3000 + EDIT_PAUSE * 3 + EDIT_BREAK, 'user', doc(bump(a0, { x: 12 }), b0)] // past the break: new moment
  ])
  const m = historyMoments(w)
  expect([...m.byId.values()].map(moment => moment.commits)).toEqual([['0'], ['1', '2', '3'], ['4'], ['5']])
  expect(m.root).toBe('0'); expect(m.current).toBe('5')
})

test('one Galta request is one moment, captioned by what was asked', () => {
  const turns = [{ id: 't1', turnId: 'x1', instruction: 'Make it blue', status: 'completed', startedAt: 100, completedAt: 900, items: [] },
    { id: 't2', turnId: 'x2', instruction: 'Now bigger', status: 'completed', startedAt: 1000, completedAt: 9000, items: [] }]
  const runtime = { sessionId: 'c', sessionLabel: 'c', modelId: 'm', effort: 'High', providerId: 'codex-app-server' }
  const w = history([
    ['0', null, 0, 'user', s0],
    ['1', '0', 200, 'agent', s1, runtime], ['2', '1', 800, 'agent', s2, runtime],
    ['3', '2', 1200, 'agent', s3, runtime],
    ['4', '3', 1300, 'import', doc(bump(a0, { x: 5 }), b0, el('i', { type: 'image' }))], ['5', '4', 1400, 'import', doc(bump(a0, { x: 5 }), b0, el('i', { type: 'image' }), el('j', { type: 'image' }))]
  ], { sessions: [{ id: 'c', label: 'c', turns }] })
  const moments = [...historyMoments(w).byId.values()]
  expect(moments.map(moment => [moment.commits, moment.source, moment.turn?.instruction])).toEqual([
    [['0'], 'start', undefined], [['1', '2'], 'agent', 'Make it blue'], [['3'], 'agent', 'Now bigger'], [['4', '5'], 'import', undefined]])
})

test('forks, names and the current canvas each end a moment; a restore starts one the next work joins', () => {
  const w = history([
    ['0', null, 0, 'user', s0],
    ['1', '0', 1000, 'user', s1],
    ['2', '1', 2000, 'user', s2],     // named
    ['3', '2', 3000, 'user', s3],     // old future, left behind
    ['r', '2', 9000, 'user', s2],     // restore of 2: the same snapshot object
    ['4', 'r', 9500, 'user', doc(bump(a0, { x: 5 }), el('c'))]
  ], { names: [['2', 'Quiet']] })
  w.snapshots.r = w.snapshots['2']
  const m = historyMoments(w)
  expect([...m.byId.values()].map(moment => [moment.commits, moment.source, moment.restored])).toEqual([
    [['0'], 'start', false], [['1', '2'], 'user', false], [['3'], 'user', false], [['r', '4'], 'user', true]])
  expect(m.byId.get('2').name).toBe('Quiet')
  expect(m.byId.get('2').children).toEqual(['3', '4'])
})

test('a moment that ends where it began joins the one before it', () => {
  const w = history([
    ['0', null, 0, 'user', s0], ['1', '0', 1000, 'user', s1],
    ['2', '1', 1000 + EDIT_BREAK, 'user', doc(bump(a0, { strokeColor: '#f00' }))],
    ['3', '2', 1000 + EDIT_BREAK + 500, 'user', doc({ ...a0, version: 9, versionNonce: nonce++ })],
    ['4', '3', 1000 + EDIT_BREAK * 3, 'user', s3]
  ])
  expect([...historyMoments(w).byId.values()].map(moment => moment.commits)).toEqual([['0'], ['1', '2', '3'], ['4']])
})

test('the travelled universe is straight; other futures branch off as strands in lanes', () => {
  const w = history([
    ['0', null, 0, 'user', s0],
    ['1', '0', 1 * EDIT_BREAK, 'user', s1],
    ['2', '1', 2 * EDIT_BREAK, 'user', s2],
    ['x', '1', 3 * EDIT_BREAK, 'user', s3], ['y', 'x', 4 * EDIT_BREAK, 'user', doc(b0)],          // a future from 1
    ['z', '2', 5 * EDIT_BREAK + SESSION_GAP, 'user', doc(el('z'))],                               // a future from 2 after a session break
    ['3', '2', 6 * EDIT_BREAK + SESSION_GAP, 'user', doc(el('q'))]
  ], { head: '3' })
  const m = historyMoments(w)
  const home = multiverseLayout(m, m.current, { gap: 8, session: 16 })
  expect(home.path).toEqual(['0', '1', '2', '3'])
  expect(home.path.map(id => home.at.get(id).x)).toEqual([0, 8, 16, 24 + 16])
  const strands = home.strands.slice(1).map(s => [s.fork, s.moments, s.lane, s.bud])
  expect(strands).toEqual([['1', ['x', 'y'], 1, false], ['2', ['z'], 2, false]])
  // Travelling to the other future makes it the straight one.
  const there = multiverseLayout(m, 'y', { gap: 8, session: 16 })
  expect(there.path).toEqual(['0', '1', 'x', 'y'])
  expect(there.strands.slice(1).map(s => s.moments)).toEqual([['2', '3'], ['z']])
  expect(there.strands[2].lane).toBeGreaterThan(there.strands[1].lane)
  expect(pathTo(m, 'z')).toEqual(['0', '1', '2', 'z'])
})

test('strands that find no lane become buds at their fork', () => {
  const rows = [['0', null, 0, 'user', s0], ['1', '0', EDIT_BREAK, 'user', s1]]
  for (let i = 0; i < 5; i++) rows.push([`f${i}`, '1', (2 + i) * EDIT_BREAK, 'user', doc(el(`f${i}`))])
  rows.push(['2', '1', 9 * EDIT_BREAK, 'user', s2])
  const m = historyMoments(history(rows, { head: '2' }))
  const layout = multiverseLayout(m, m.current, { gap: 8, session: 16 }, 3)
  expect(layout.strands.filter(s => s.index && !s.bud).map(s => s.lane)).toEqual([1, 2, 3])
  expect(layout.strands.filter(s => s.bud).length).toBe(2)
})

test('trim removes exactly the chosen versions and keeps one tree', () => {
  const w = history([
    ['0', null, 0, 'user', s0], ['1', '0', 1, 'user', s1], ['2', '1', 2, 'user', s2],
    ['x', '1', 3, 'user', s3], ['3', '2', 4, 'user', doc(el('q'))]
  ], { head: '3', names: [['1', 'One'], ['3', 'Three']], checkpoints: { '1': { providerId: 'codex-app-server', sessionId: 'c', threadId: 't', turnId: 'u' } } })
  w.canvasView = { commitId: '3', scrollX: 0, scrollY: 0, zoom: 1 }
  // A middle range: what continued from it continues from the version before it.
  const middle = trimHistory(w, ['1', '2'], 7)
  expect(Object.keys(middle.project.commits).sort()).toEqual(['0', '3', 'x'])
  expect(middle.project.commits['3'].parentId).toBe('0'); expect(middle.project.commits.x.parentId).toBe('0')
  expect(Object.keys(middle.snapshots).sort()).toEqual(['0', '3', 'x'])
  expect(middle.namedVersions.map(n => n.commitId)).toEqual(['3'])
  expect(middle.agentCheckpoints).toEqual({})
  expect(middle.canvasView.commitId).toBe('3')
  expect(middle.project.updatedAt).toBe(7)
  // The start: the earliest version the current canvas keeps becomes the start; other futures stay.
  const start = trimHistory(w, ['0', '1'])
  expect(start.project.commits['2'].parentId).toBe(null)
  expect(start.project.commits.x.parentId).toBe('2')
  expect(historyMoments(start).root).toBe('2')
  expect(() => trimHistory(w, ['3'])).toThrow('current canvas')
  // A version another window already cut is simply gone.
  expect(trimHistory(w, ['missing'])).toBe(w)
  expect(Object.keys(trimHistory(w, ['missing', 'x']).project.commits).sort()).toEqual(['0', '1', '2', '3'])
  expect(trimHistory(w, [])).toBe(w)
})

test('a window standing on a cut version saves from where its work continues, and nothing is lost', async () => {
  const { commitWorkspaceSnapshot } = await import('../apps/extension/src/canvas/workspace.ts')
  const w = history([['0', null, 0, 'user', s0], ['1', '0', 1, 'user', s1], ['2', '1', 2, 'user', s2], ['3', '2', 3, 'user', s3]])
  const cut = trimHistory(w, ['1', '2'])
  expect(cut.trimmedVersions).toEqual({ '1': '0', '2': '0' })
  // Another window still stood on 2 with an unsaved edit.
  const saved = commitWorkspaceSnapshot(cut, '2', doc(el('kept-edit')), 'user')
  const head = saved.project.headCommitId
  expect(saved.project.commits[head].parentId).toBe('0')
  expect(saved.snapshots[head].document.elements.map(e => e.id)).toEqual(['kept-edit'])
  // A later cut of where the work continued moves the record along.
  const again = trimHistory({ ...cut, project: { ...cut.project } }, ['0'])
  expect(again.trimmedVersions).toEqual({ '0': '3', '1': '3', '2': '3' })
  // A version that never existed still fails loudly.
  expect(() => commitWorkspaceSnapshot(cut, 'never', doc(el('x')), 'user')).toThrow('Unknown history cursor')
})

test('neither a restore nor a change undone joins work made after a long pause', () => {
  const day = 24 * 60 * 60 * 1000
  const w = history([['0', null, 0, 'user', s0], ['1', '0', 1000, 'user', s1], ['2', '1', 2000, 'user', s2], ['r', '1', 3000, 'user', s1], ['3', 'r', 4 * day, 'user', doc(el('later'))]])
  w.snapshots.r = w.snapshots['1']
  const m = historyMoments(w)
  expect(m.of.get('r')).not.toBe(m.of.get('3'))
  const moved = bump(a0, { x: 50 }), back = { ...a0, version: 40, versionNonce: nonce++ }
  const v = history([['0', null, 0, 'user', s0], ['1', '0', 1000, 'user', s1], ['2', '1', 4 * day, 'user', doc(moved)], ['3', '2', 4 * day + 500, 'user', doc(back)]])
  expect([...historyMoments(v).byId.values()].map(moment => moment.commits)).toEqual([['0'], ['1'], ['2', '3']])
})

test('a history thousands of moments long lays out without deep recursion', () => {
  const rows = [['0', null, 0, 'user', s0]]
  for (let i = 1; i <= 5000; i++) rows.push([String(i), String(i - 1), i * 3 * 60_000, 'user', doc(el(`e${i}`))])
  rows.push(['b', '2', 5001 * 3 * 60_000, 'user', doc(el('branch'))])
  const m = historyMoments(history(rows, { head: '5000' }))
  const layout = multiverseLayout(m, m.current, { gap: 8, session: 16 })
  expect(layout.path.length).toBe(5001)
  expect(multiverseLayout(m, 'b', { gap: 8, session: 16 }).path.at(-1)).toBe('b')
})

test('a turned line or stroke is pointed at along its path, about the centre the engine turns it on', async () => {
  const { touches } = await import('../apps/extension/src/canvas/historyHit.ts')
  const stroke = { id: 's', type: 'freedraw', x: 0, y: 0, width: 100, height: 100, angle: Math.PI / 4, strokeWidth: 2, points: [[0, 0], [100, 0], [100, 100]] }
  // The drawn corner: (100, 0) turned 45 degrees about (50, 50).
  const corner = [50 + 50 * Math.SQRT1_2 + 50 * Math.SQRT1_2, 50 + 50 * Math.SQRT1_2 - 50 * Math.SQRT1_2]
  expect(touches(stroke, corner[0], corner[1], 3)).toBe(true)
  expect(touches(stroke, 50, 50, 3)).toBe(false)
  const box = { id: 'b', type: 'rectangle', x: 0, y: 0, width: 100, height: 20, angle: Math.PI / 2, strokeWidth: 2 }
  expect(touches(box, 50, 50, 1)).toBe(true); expect(touches(box, 5, 10, 1)).toBe(false)
})

