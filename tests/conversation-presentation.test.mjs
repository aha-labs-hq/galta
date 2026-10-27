import { test, expect } from 'bun:test'
import { ConversationStore, currentConversationItem, shareConversationHistory, presentConversation } from '../apps/extension/src/canvas/conversationStore'
import { reconcileCodexSession } from '../apps/extension/src/canvas/conversationState'

const turn = () => ({ id: 't', turnId: 'remote', instruction: 'Simplify the logo', status: 'streaming', context: { canvasTitle: 'Logo', selection: ['shape'] }, items: [
  { id: 'c', type: 'agentMessage', text: 'Checking the outline', phase: 'commentary' },
  { id: 'tool', type: 'commandExecution', text: 'pwd', output: '/tmp', status: 'completed' },
  { id: 'a', type: 'agentMessage', text: 'The outline is', phase: 'final_answer', status: 'inProgress' }
] })

test('confirmed canvas effects retain identity across transport clones and update when the receipt changes', () => {
  const store = new ConversationStore(), initial = turn()
  initial.items.push({ id: 'canvas', type: 'mcpToolCall', tool: 'canvas_place', text: 'canvas_place', status: 'completed', canvasChanges: { created: 0, updated: 1, deleted: 0, kind: 'image' } })
  store.set(initial); store.set(structuredClone(initial))
  expect(store.getSnapshot()).toBe(initial)
  const changed = structuredClone(initial); changed.items.at(-1).canvasChanges.updated = 2
  store.set(changed)
  expect(store.getSnapshot().items.at(-1).canvasChanges.updated).toBe(2)
  expect(store.getSnapshot().items[1]).toBe(initial.items[1])
})

test('the live cursor keeps final answers and retries ahead of late receipts', () => {
  const lateReceipt = { id: 'receipt', type: 'commandExecution', text: 'pwd', status: 'completed' }
  const retry = { id: 'retry', type: 'modelRetry', text: 'Waiting for the model to reconnect', status: 'inProgress' }
  expect(currentConversationItem([retry, lateReceipt], true)).toBe(retry)
  const answer = { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Done.', status: 'inProgress' }
  expect(currentConversationItem([retry, lateReceipt, answer], true)).toBe(answer)
  expect(currentConversationItem([answer, retry], true)).toBe(retry)
  expect(currentConversationItem([{ ...retry, status: 'completed' }, lateReceipt], true)).toBeUndefined()
})

test('transport clones update only changed items; context and completed history retain identity', () => {
  const store = new ConversationStore(), initial = turn()
  initial.steering = [{ id: 'followup', text: 'Keep the material.', createdAt: 1 }]
  store.set(initial)
  let notifications = 0
  const unsubscribe = store.subscribe(() => notifications++)
  store.set(structuredClone(initial))
  expect(notifications).toBe(0)
  const next = structuredClone(initial); next.items[2].text += ' simpler.'
  store.set(next)
  expect(notifications).toBe(1)
  expect(store.getSnapshot().items[0]).toBe(initial.items[0])
  expect(store.getSnapshot().items[1]).toBe(initial.items[1])
  expect(store.getSnapshot().items[2]).not.toBe(initial.items[2])
  expect(store.getContext()).toBe(initial.context)
  const history = [initial]
  expect(shareConversationHistory(history, structuredClone(history))).toBe(history)
  const renamed = structuredClone(history); renamed[0].instruction = 'New request'
  expect(shareConversationHistory(history, renamed)[0].instruction).toBe('New request')
  unsubscribe(); store.set(null)
  expect(notifications).toBe(1)
})

test('transport sharing keeps changed canvas context and nested artifact receipts precise', () => {
  const initial = turn()
  initial.context.canvas = { commitId: 'c1', revision: 'r1', preview: 'attached' }
  initial.items[2].artifacts = [{ href: '/tmp/a.png', status: 'ready', receipt: {
    projectId: 'p', threadId: 'thread', turnId: 'turn', messageId: 'a', receiptId: '00000000-0000-4000-8000-000000000001', href: '/tmp/a.png', uri: 'galta-workspace:/deliveries/1/a.png', name: 'a.png', mimeType: 'image/png', size: 1, sha256: '0000000000000000000000000000000000000000000000000000000000000000', version: 'v1'
  } }]
  const changed = structuredClone(initial)
  changed.context.canvas.revision = 'r2'
  changed.items[2].artifacts[0].receipt.version = 'v2'
  const shared = shareConversationHistory([initial], [changed])[0]
  expect(shared.context.canvas.revision).toBe('r2')
  expect(shared.items[0]).toBe(initial.items[0])
  expect(shared.items[2]).not.toBe(initial.items[2])
  const unchanged = shareConversationHistory([initial], [structuredClone(initial)])[0]
  expect(unchanged).toBe(initial)
})

test('unclassified and interrupted text stays readable; tool receipts stay in execution details', () => {
  const current = turn(); current.status = 'stopped'
  delete current.items[2].phase
  current.items.push({ id: 'failed', type: 'mcpToolCall', text: 'write', status: 'failed', error: 'Storage unavailable' })
  const view = presentConversation(current)
  expect(view.process.map(item => item.id)).toEqual(['c', 'tool', 'a', 'failed'])
  expect(view.replies.map(item => item.id)).toEqual([])
  expect(view.process.at(-1).error).toBe('Storage unavailable')
  expect(view.attention).toEqual([])
  expect(view.timeline.map(entry => entry.kind === 'process' ? `process:${entry.items.map(item => item.id).join(',')}` : `${entry.kind}:${entry.kind === 'reply' ? entry.item.id : entry.item.id}`)).toEqual(['process:c,tool,a,failed'])
})

test('the timeline keeps interleaved prose beside the work that produced it', () => {
  const current = turn()
  current.items = [
    { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: 'I will inspect the canvas first.' },
    { id: 'reasoning', type: 'reasoning', text: 'Compare the current proportions.', status: 'completed' },
    { id: 'read', type: 'mcpToolCall', tool: 'canvas_inspect', text: 'Inspect canvas', status: 'completed' },
    { id: 'between', type: 'agentMessage', phase: 'commentary', text: 'The subject sits slightly to the right.' },
    { id: 'write', type: 'mcpToolCall', tool: 'canvas_edit', text: 'Edit canvas', status: 'completed' },
    { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'The composition is balanced now.', status: 'completed' }
  ]
  const view = presentConversation(current)
  expect(view.timeline.map(entry => entry.kind === 'process' ? `process:${entry.items.map(item => item.id).join(',')}` : `${entry.kind}:${entry.kind === 'reply' ? entry.item.id : entry.kind === 'user' ? entry.message.id : entry.item.id}`)).toEqual(['process:commentary,reasoning,read,between,write', 'reply:final'])
  expect(view.replies.map(item => item.id)).toEqual(['final'])
})

test('unclassified prose is readable at its original position', () => {
  const current = turn()
  current.items = [
    { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: 'Starting the check.' },
    { id: 'tool', type: 'commandExecution', text: 'pwd', status: 'completed' },
    { id: 'final', type: 'agentMessage', text: 'The check is complete.', status: 'completed' }
  ]
  const view = presentConversation(current)
  expect(view.timeline.map(entry => entry.kind === 'process' ? `process:${entry.items.map(item => item.id).join(',')}` : `${entry.kind}:${entry.kind === 'reply' ? entry.item.id : entry.kind === 'user' ? entry.message.id : entry.item.id}`)).toEqual(['process:commentary,tool,final'])
})

test('multiple unclassified prose items remain separate from execution details', () => {
  const current = turn()
  current.items = [
    { id: 'tool', type: 'commandExecution', text: 'pwd', status: 'completed' },
    { id: 'progress', type: 'agentMessage', text: 'The check is still being reviewed.', status: 'completed' },
    { id: 'final', type: 'agentMessage', text: 'The check is complete.', status: 'completed' }
  ]
  const view = presentConversation(current)
  expect(view.timeline.map(entry => entry.kind === 'process' ? `process:${entry.items.map(item => item.id).join(',')}` : `${entry.kind}:${entry.kind === 'reply' ? entry.item.id : entry.kind === 'user' ? entry.message.id : entry.item.id}`)).toEqual(['process:tool,progress,final'])
})

test('a tool exit does not require user attention; a request error does, across live and restored turns', () => {
  for (const status of ['preparing', 'streaming', 'completed', 'stopped', 'failed']) {
    const current = turn(); current.status = status
    current.items.push({ id: 'command', type: 'commandExecution', text: 'rg --files', status: 'failed', exitCode: 1, output: '' })
    const view = presentConversation(structuredClone(current))
    expect(view.attention).toEqual([])
    expect(view.process.at(-1)).toEqual(current.items.at(-1))
    current.items.push({ id: 'error', type: 'error', text: 'The model connection closed.' })
    expect(presentConversation(current).attention).toEqual([current.items.at(-1)])
  }
})

test('restoration preserves known message phase when the optional field is absent, and accepts authoritative classification', () => {
  const current = turn()
  const remote = { id: 'thread', turns: [{ id: 'remote', status: 'completed', items: [
    { id: 'restored-commentary', type: 'agentMessage', text: 'Checking the outline' },
    { id: 'restored-answer', type: 'agentMessage', text: 'The outline is simpler.', phase: 'final_answer' }
  ] }] }
  const session = reconcileCodexSession({ id: 's', turns: [current] }, remote)
  expect(session.turns[0].items[0].phase).toBe('commentary')
  expect(session.turns[0].items.at(-1).phase).toBe('final_answer')
  expect(reconcileCodexSession(session, remote)).toEqual(session)
  expect(current.items[2].text).toBe('The outline is')
})

test('accepted follow-ups remain between observed messages, including when restored IDs change', () => {
  const current = turn()
  current.steering = [
    { id: 'legacy', text: 'Keep the silhouette.', createdAt: 1 },
    { id: 'followup', text: 'Use more space.', createdAt: 2, afterItemId: 'c' },
    { id: 'second', text: 'Keep the type.', createdAt: 3, afterItemId: 'c' },
    { id: 'missing', text: 'A preserved older message.', createdAt: 4, afterItemId: 'missing-tool' }
  ]
  const order = value => presentConversation(value).dialogue.map(entry => entry.kind === 'user' ? entry.message.id : entry.item.id)
  expect(order(current)).toEqual(['legacy', 'missing', 'c', 'followup', 'second', 'a'])
  const restored = reconcileCodexSession({ id: 's', turns: [current] }, { id: 'thread', turns: [{ id: 'remote', status: 'completed', items: [
    { id: 'restored-commentary', type: 'agentMessage', text: 'Checking the outline', phase: 'commentary' },
    { id: 'restored-answer', type: 'agentMessage', text: 'The outline is simpler.', phase: 'final_answer' }
  ] }] })
  expect(restored.turns[0].steering[1].afterItemId).toBe('restored-commentary')
  expect(order(restored.turns[0])).toEqual(['legacy', 'missing', 'restored-commentary', 'followup', 'second', 'restored-answer'])
  expect(order(reconcileCodexSession(restored, { id: 'thread', turns: [{ id: 'remote', status: 'completed', items: restored.turns[0].items }] }).turns[0])).toEqual(order(restored.turns[0]))
})

test('context compaction is a boundary that divides the process, not a step within it', () => {
  const current = { id: 't', instruction: 'Keep going', status: 'streaming', items: [
    { id: 'think', type: 'reasoning', text: 'Thinking', status: 'completed' },
    { id: 'compact', type: 'contextCompaction', text: 'Condensing earlier context', status: 'completed' },
    { id: 'tool', type: 'commandExecution', text: 'pwd', status: 'completed' }
  ] }
  const view = presentConversation(current)
  expect(view.timeline.map(entry => entry.kind)).toEqual(['process', 'boundary', 'process'])
  expect(view.timeline[1].item.id).toBe('compact')
  expect(view.process.map(item => item.id)).toEqual(['think', 'tool'])
})
