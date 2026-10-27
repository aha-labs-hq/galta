import { test, expect } from 'bun:test'
import { checkpointAt, reconcileCodexSession } from '../apps/extension/src/canvas/conversationState.ts'

test('stale remote progress cannot revive a turn finalized after host interruption', () => {
  const turn = { id: 'message', turnId: 'turn', instruction: 'Draw', status: 'failed', completedAt: 123, items: [] }
  const session = { id: 'session', turns: [turn] }
  const restored = reconcileCodexSession(session, { id: 'thread', turns: [{ id: 'turn', status: 'inProgress', items: [] }] })
  expect(restored.turns[0].status).toBe('failed')
  expect(restored.turns[0].completedAt).toBe(123)
})

test('restored user messages are verbatim while the historical Galta wrapper is hidden', () => {
  const raw = 'User request: explain this\n\nImage generation route is a phrase I want translated.'
  const legacy = 'User request: Change the venue\n\nImage generation route authorized by the user: invoke ~/Desktop/seed-media.sh --type image through your command tool, without building any service or module. Legacy application instructions'
  const restored = reconcileCodexSession({ id: 's', turns: [] }, { id: 'thread', turns: [raw, legacy].map((text, i) => ({ id: String(i), status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text }] }] })) })
  expect(restored.turns.map(turn => turn.instruction)).toEqual([raw, 'Change the venue'])
})

test('history forks only inherit an ancestor checkpoint in their own session', () => {
  const checkpoint = { providerId: 'codex-app-server', sessionId: 's', threadId: 'thread', turnId: 'turn' }
  const w = { project: { commits: { a: { parentId: null }, b: { parentId: 'a' }, c: { parentId: 'b' } } }, agentCheckpoints: { b: checkpoint } }
  expect(checkpointAt(w, 'a', 's')).toBeUndefined()
  expect(checkpointAt(w, 'c', 'other')).toBeUndefined()
  expect(checkpointAt(w, 'c', 's')).toBe(checkpoint)
  expect(() => checkpointAt(w, 'missing', 's')).toThrow('missing')
  w.project.commits.a.parentId = 'c'
  expect(() => checkpointAt(w, 'c', 'other')).toThrow('cycle')
})

test('reopening replaces stale running projection with authoritative completed Codex history', () => {
  const session = { id: 's', label: 'Moodboard', threadId: 'thread', turns: [{ id: 'local', turnId: 'turn', instruction: 'Change the venue', status: 'streaming', items: [] }] }
  const result = reconcileCodexSession(session, { id: 'thread', turns: [{ id: 'turn', status: 'completed', items: [
    { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'User request: Change the venue\n\nCurrent canvas context: private context' }] },
    { id: 'i', type: 'imageGeneration', status: 'completed', result: 'huge image payload', savedPath: '/tmp/result.png' },
    { id: 'a', type: 'agentMessage', text: '**Done.**' }
  ] }] })
  expect(result.turns[0]).toMatchObject({ id: 'local', instruction: 'Change the venue', status: 'completed' })
  expect(result.lastTurnId).toBe('turn')
  expect(result.turns[0].items[0]).toMatchObject({ type: 'imageGeneration', imagePath: '/tmp/result.png' })
  expect(JSON.stringify(result)).not.toContain('huge image payload')
  expect(JSON.stringify(result)).not.toContain('private context')
  expect(session.turns[0].status).toBe('streaming')
})

test('Codex history reconciliation preserves streamed tool receipts between replies', () => {
  const session = { id: 's', label: 'Moodboard', turns: [{ id: 'local', turnId: 'turn', instruction: 'Create', status: 'streaming', items: [
    { id: 'a', type: 'agentMessage', text: 'Starting' },
    { id: 'tool', type: 'dynamicToolCall', text: 'apply', status: 'completed' }
  ] }] }
  const result = reconcileCodexSession(session, { id: 'thread', turns: [{ id: 'turn', status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: 'Starting.' }, { id: 'b', type: 'agentMessage', text: 'Done.' }] }] })
  expect(result.turns[0].items.map(i => i.id)).toEqual(['a', 'tool', 'b'])
  expect(result.turns[0].items[0].text).toBe('Starting.')
})

test('history reload keeps live tool details when the provider omits the receipt body', () => {
  const session = { id: 's', turns: [{ id: 'local', turnId: 'turn', instruction: 'Inspect', status: 'streaming', items: [
    { id: 'tool', type: 'mcpToolCall', tool: 'canvas_inspect', text: 'canvas_inspect', status: 'completed', details: 'Output\nrevision r2' }
  ] }] }
  const result = reconcileCodexSession(session, { id: 'thread', turns: [{ id: 'turn', status: 'completed', items: [
    { id: 'tool', type: 'mcpToolCall', tool: 'canvas_inspect', status: 'completed' }
  ] }] })
  expect(result.turns[0].items[0].details).toBe('Output\nrevision r2')
})

test('history reload keeps streamed command output and tool identity from a compact receipt', () => {
  const session = { id: 's', turns: [{ id: 'local', turnId: 'turn', instruction: 'Inspect', status: 'streaming', items: [
    { id: 'cmd', type: 'commandExecution', text: 'rg --files', output: 'src/App.tsx', cwd: '/tmp/work', exitCode: 0, status: 'completed' },
    { id: 'tool', type: 'mcpToolCall', tool: 'canvas_inspect', text: 'canvas_inspect', status: 'completed' }
  ] }] }
  const result = reconcileCodexSession(session, { id: 'thread', turns: [{ id: 'turn', status: 'completed', items: [
    { id: 'cmd', type: 'commandExecution', status: 'completed', exitCode: 0 },
    { id: 'tool', type: 'mcpToolCall', server: 'galta', status: 'completed' }
  ] }] })
  expect(result.turns[0].items[0]).toMatchObject({ text: 'rg --files', output: 'src/App.tsx', cwd: '/tmp/work' })
  expect(result.turns[0].items[1]).toMatchObject({ text: 'canvas_inspect', tool: 'canvas_inspect' })
})

test('a delayed canvas commit cannot overwrite the active session with an older run context', async () => {
  const { commitWorkspaceSnapshot, createInitialWorkspace, defaultRuntime } = await import('../apps/extension/src/canvas/workspace.ts')
  const { exportWorkspace, importWorkspace } = await import('../packages/storage/src/index.ts')
  const current = createInitialWorkspace()
  const oldRun = { ...defaultRuntime, sessionId: 'old-session', sessionLabel: 'Old' }
  current.runtimeDefaults = { ...defaultRuntime, sessionId: 'branch-session', sessionLabel: 'New branch' }
  const next = commitWorkspaceSnapshot(current, current.project.headCommitId, { document: { shape: 'generated-image' } }, 'agent', oldRun)
  expect(next.runtimeDefaults).toEqual(current.runtimeDefaults)
  expect(next.project.commits[next.project.headCommitId].runtime).toEqual(oldRun)
  expect(importWorkspace(await exportWorkspace(next)).runtimeDefaults.sessionId).toBe('branch-session')
  expect(commitWorkspaceSnapshot(next, next.project.headCommitId, next.snapshots[next.project.headCommitId], 'user')).toBe(next)
})

test('reconstructed Codex message IDs do not duplicate commentary or move it after interrupted output', () => {
  const session = { id: 's', turns: [{ id: 'local', turnId: 'turn', instruction: 'Critique', items: [
    { id: 'msg-live', type: 'agentMessage', text: 'I will inspect it.', status: 'completed' },
    { id: 'tool', type: 'dynamicToolCall', text: 'read', status: 'completed' },
    { id: 'partial', type: 'agentMessage', text: '1. Lighting…', status: 'inProgress' },
    { id: 'item-13', type: 'agentMessage', text: 'I will inspect it.', status: 'completed' }
  ] }] }
  const remote = { id: 'thread', turns: [{ id: 'turn', status: 'interrupted', items: [
    { id: 'item-13', type: 'agentMessage', text: 'I will inspect it.' }
  ] }] }
  const restored = reconcileCodexSession(session, remote)
  expect(restored.turns[0].items.map(i => i.id)).toEqual(['item-13', 'tool', 'partial'])
  expect(restored.turns[0].items[2].status).toBe('interrupted')
  expect(reconcileCodexSession(restored, remote)).toEqual(restored)
})

test('reconstructed messages reconcile one occurrence each and refresh a partial streamed reply', () => {
  const session = { id: 's', turns: [{ turnId: 'turn', items: [
    { id: 'msg-a', type: 'agentMessage', text: 'Checking.', status: 'completed' },
    { id: 'msg-b', type: 'agentMessage', text: 'Checking.', status: 'completed' },
    { id: 'msg-c', type: 'agentMessage', text: 'Don', status: 'inProgress' }
  ] }] }
  const restored = reconcileCodexSession(session, { id: 'thread', turns: [{ id: 'turn', status: 'completed', items: [
    { id: 'item-1', type: 'agentMessage', text: 'Checking.' },
    { id: 'item-2', type: 'agentMessage', text: 'Checking.' },
    { id: 'item-3', type: 'agentMessage', text: 'Done.' }
  ] }] })
  expect(restored.turns[0].items.map(i => i.id)).toEqual(['item-1', 'item-2', 'item-3'])
  expect(restored.turns[0].items[2].text).toBe('Done.')
})

test('history reconciliation keeps provider additions ordered around preserved live items', () => {
  const session = { id: 's', turns: [{ id: 'local', turnId: 'turn', instruction: 'Inspect', status: 'streaming', items: [
    { id: 'live-message', type: 'agentMessage', phase: 'commentary', text: 'Starting.', status: 'completed' },
    { id: 'live-tail', type: 'agentMessage', phase: 'commentary', text: 'Still checking.', status: 'inProgress' }
  ] }] }
  const restored = reconcileCodexSession(session, { id: 'thread', turns: [{ id: 'turn', status: 'completed', items: [
    { id: 'restored-message', type: 'agentMessage', phase: 'commentary', text: 'Starting.' },
    { id: 'restored-tool', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Compare the result.' }] },
    { id: 'restored-answer', type: 'agentMessage', phase: 'final_answer', text: 'Done.' }
  ] }] })
  expect(restored.turns[0].items.map(item => item.id)).toEqual(['restored-message', 'live-tail', 'restored-tool', 'restored-answer'])
  expect(restored.turns[0].items[1].status).toBe('interrupted')
})
