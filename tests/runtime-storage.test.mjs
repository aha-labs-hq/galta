import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCapture } from '../packages/capture/dist/index.js'
import { asBranchId, asCommitId, asProjectId, createProject } from '../packages/domain/dist/index.js'
import { MemoryWorkspaceRepository, exportWorkspace, importWorkspace, normalizeWorkspace } from '../packages/storage/dist/index.js'

test('capture normalization requires explicit HTTP(S) intent', () => {
  assert.throws(() => normalizeCapture({ kind: 'image', pageUrl: 'https://example.com', userGestureId: '' }))
  assert.throws(() => normalizeCapture({ kind: 'image', pageUrl: 'file:///tmp/image.png', userGestureId: 'gesture-1' }))
  const record = normalizeCapture({ kind: 'image', pageUrl: 'https://example.com/pin', mediaUrl: 'https://example.com/image.jpg', userGestureId: 'gesture-1' }, 1)
  assert.equal(record.sourceHost, 'example.com')
  assert.equal(record.id, 'capture-gesture-1')
})

test('workspace repository and export round-trip preserve artwork, bookmarks and fork context', async () => {
  const repository = new MemoryWorkspaceRepository()
  const project = createProject({ projectId: asProjectId('p1'), branchId: asBranchId('b1'), commitId: asCommitId('c1') }, 1)
  const bundle = {
    project,
    captures: [normalizeCapture({ kind: 'image', pageUrl: 'https://example.com', userGestureId: 'g1' }, 2)],
    snapshots: { c1: { document: { store: {} } } },
    savedDirections: [{ commitId: 'c1', label: 'Quiet composition', savedAt: 2 }],
    codexSessions: [{ id: 's1', label: 'Exploration', turns: [], forkFrom: { threadId: 'thread-1', lastTurnId: 'turn-1' } }],
    runtimeDefaults: { sessionId: 'moodboard', sessionLabel: 'Moodboard', modelId: 'local-deterministic', effort: 'High', providerId: 'local-deterministic' }
  }
  await repository.save(bundle)
  const loaded = await repository.load(project.id)
  assert.deepEqual(loaded, normalizeWorkspace(bundle))
  assert.deepEqual(importWorkspace(await exportWorkspace(bundle, 3)), normalizeWorkspace(bundle))
  assert.equal(loaded.codexSessions, undefined)
  assert.equal(loaded.agentSessions[0].providerId, 'codex-app-server')
  assert.deepEqual(loaded.agentSessions[0].forkFrom, bundle.codexSessions[0].forkFrom)
  assert.deepEqual(normalizeWorkspace(loaded), loaded)
  assert.deepEqual(loaded.namedVersions, bundle.savedDirections)
  assert.equal(loaded.savedDirections, undefined)
  assert.throws(() => normalizeWorkspace({ ...bundle, agentSessions: [] }), /conflicting/)
  // A direction saved by an older build beside current names keeps every name.
  const both = normalizeWorkspace({ ...bundle, namedVersions: [{ commitId: 'c1', label: 'Current name', savedAt: 3 }], savedDirections: [...bundle.savedDirections, { commitId: 'c0', label: 'Older', savedAt: 1 }] })
  assert.deepEqual(both.namedVersions.map(item => item.label), ['Current name', 'Older'])
})

test('retired history curation is washed out without removing a single version', async () => {
  const project = createProject({ projectId: asProjectId('p2'), branchId: asBranchId('b1'), commitId: asCommitId('c1') }, 1)
  const snapshots = { c1: { document: { store: {} } } }
  const legacy = { project, captures: [], snapshots, historyClips: { c1: { from: 'c1', to: 'c1' } }, historyTrash: { c1: 5 } }
  const washed = normalizeWorkspace(legacy)
  assert.equal('historyClips' in washed, false)
  assert.equal('historyTrash' in washed, false)
  assert.equal(washed.project, project)
  assert.equal(washed.snapshots, snapshots)
  const repository = new MemoryWorkspaceRepository()
  await repository.save(legacy)
  assert.deepEqual(Object.keys((await repository.load(project.id)).snapshots), ['c1'])
  assert.deepEqual(importWorkspace(await exportWorkspace(legacy, 3)), washed)
})
