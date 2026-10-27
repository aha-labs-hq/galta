import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEvent,
  asBranchId,
  asCommitId,
  asProjectId,
  commit,
  commitAtCursor,
  createProject,
  forkAndCommit,
  replay
} from '../packages/domain/dist/index.js'

const projectId = asProjectId('project-1')
const main = asBranchId('main')
const root = asCommitId('root')
const c1 = asCommitId('c1')

const text = (id, value, x = 0, y = 0) => ({ type: 'NodeCreated', node: { id, type: 'text', text: value, x, y } })

test('replay resolves the canvas from the root without mutating the project', () => {
  const initial = createProject({ projectId, branchId: main, commitId: root }, 1)
  const next = commit(initial, { id: c1, branchId: main, source: 'user', now: 2, events: [text('n1', 'hello')] })

  assert.deepEqual(Object.keys(replay(next, c1)), ['nodes'])
  assert.equal(replay(next, c1).nodes.n1.text, 'hello')
  assert.equal(initial.headCommitId, root)
})

test('writing from a historical commit creates a new branch and preserves the old rail', () => {
  const initial = createProject({ projectId, branchId: main, commitId: root }, 1)
  const first = commit(initial, { id: c1, branchId: main, source: 'user', now: 2, events: [text('n1', 'first')] })
  const historical = asCommitId('historical')
  const branch = asBranchId('branch-2')
  const forked = commitAtCursor(first, {
    id: historical,
    cursorCommitId: root,
    newBranchId: branch,
    source: 'user',
    now: 3,
    events: [text('n2', 'second')]
  })

  assert.equal(forked.activeBranchId, branch)
  assert.equal(forked.branches[main].headCommitId, c1)
  assert.equal(forked.branches[branch].parentCommitId, root)
  assert.equal(replay(forked, historical).nodes.n2.text, 'second')
  assert.equal(replay(forked, historical).nodes.n1, undefined)
})

test('an event reducer is deterministic for direct manipulation', () => {
  const moved = applyEvent({ nodes: { n1: { id: 'n1', type: 'text', text: 'x', x: 1, y: 2 } } }, { type: 'NodeMoved', nodeId: 'n1', x: 8, y: 13 })
  assert.deepEqual(moved.nodes.n1, { id: 'n1', type: 'text', text: 'x', x: 8, y: 13 })
})
