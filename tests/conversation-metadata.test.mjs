import { test, expect } from 'bun:test'
import { CodexMetadata } from '../packages/runtime/src/codexMetadata'
import { prepareSessionName, bindSessionThread, mergeSession, normalizeSessionBinding, renameSession, applyGeneratedNames } from '../apps/extension/src/canvas/conversationMetadata'
import { createInitialWorkspace } from '../apps/extension/src/canvas/workspace'

const turn = { id: 'turn', instruction: 'Create a poster for the summer exhibition', status: 'completed', items: [] }
const session = () => prepareSessionName({ id: 'session', label: 'New conversation', turns: [turn] })
const workspace = () => ({ ...createInitialWorkspace(), project: { ...createInitialWorkspace().project, title: 'Untitled canvas' }, agentSessions: [session()] })

test('request names replace only legacy placeholders and preserve explicit edits', () => {
  expect(session()).toMatchObject({ label: turn.instruction, labelSource: 'request' })
  expect(prepareSessionName({ ...session(), label: 'Moodboard', labelSource: 'user' }).label).toBe('Moodboard')
  expect(prepareSessionName({ id: 's', label: 'Exhibition', turns: [turn] }).label).toBe('Exhibition')
  expect(prepareSessionName({ id: 's', label: 'New conversation', turns: [] }).labelSource).toBeUndefined()
})

test('streamed history and late naming cannot overwrite manual names or clear sync acknowledgements', () => {
  let w = workspace()
  w = renameSession(w, 'session', 'My title')
  w.project = { ...w.project, title: 'My canvas', titleSource: 'user' }
  const current = { ...w.agentSessions[0], publishedName: 'Earlier title', publishedProjectId: 'project' }
  expect(mergeSession(current, { ...session(), turns: [{ ...turn, items: [{ id: 'reply', type: 'agentMessage', text: 'Done' }] }] })).toMatchObject({ label: 'My title', labelSource: 'user', publishedName: 'Earlier title', publishedProjectId: 'project', turns: [{ items: [{ text: 'Done' }] }] })
  w = applyGeneratedNames(w, 'session', turn.instruction, 'Untitled canvas', { conversationTitle: 'Generated', canvasTitle: 'Generated canvas' })
  expect(w.agentSessions[0]).toMatchObject({ label: 'My title', labelSource: 'user', naming: 'complete' })
  expect(w.project.title).toBe('My canvas')
})

test('stale provider hydration cannot erase a durable terminal receipt', () => {
  const final = { ...turn, status: 'failed', startedAt: 10, completedAt: 20, items: [{ id: 'lost', type: 'error', text: 'Host closed' }] }
  const saved = { ...session(), turns: [final] }
  for (const status of ['streaming', 'stopped', 'completed']) {
    const incoming = { ...session(), turns: [{ ...turn, status, startedAt: 10 }] }
    expect(mergeSession(saved, incoming).turns).toEqual([final])
  }
  const settled = { ...final, items: [...final.items, { id: 'receipt', type: 'commandExecution', text: 'Stopped after cleanup', exitCode: 130 }] }
  expect(mergeSession(saved, { ...saved, turns: [settled] }).turns).toEqual([settled])
})

test('a native thread consumes its pending fork across saves and stale session snapshots', () => {
  const pending = { id: 'branch', label: 'Exploration', turns: [], forkFrom: { threadId: 'original', lastTurnId: 'checkpoint' } }
  expect(normalizeSessionBinding(pending).forkFrom).toEqual(pending.forkFrom)
  const saved = bindSessionThread({ ...pending, turns: [turn] }, 'forked-thread')
  expect(saved.threadId).toBe('forked-thread')
  expect(saved).not.toHaveProperty('forkFrom')
  const stale = mergeSession(saved, pending)
  expect(stale.threadId).toBe('forked-thread')
  expect(stale.turns).toEqual([turn])
  expect(stale).not.toHaveProperty('forkFrom')
  expect(pending.forkFrom).toEqual({ threadId: 'original', lastTurnId: 'checkpoint' })
})

test('previously saved sessions with both a thread and fork origin retain their current conversation', () => {
  const stored = { ...session(), threadId: 'latest-thread', forkFrom: { threadId: 'original', lastTurnId: 'checkpoint' }, publishedName: 'Published', publishedProjectId: 'project' }
  const restored = normalizeSessionBinding(stored)
  expect(restored).not.toHaveProperty('forkFrom')
  expect(restored).toEqual({ ...session(), threadId: 'latest-thread', publishedName: 'Published', publishedProjectId: 'project' })
  expect(stored).toHaveProperty('forkFrom')
})

test('a concurrent save cannot replace an established native conversation with another thread', () => {
  const saved = { ...session(), threadId: 'current-thread' }
  expect(() => bindSessionThread(saved, 'other-thread')).toThrow('already bound to Codex thread current-thread')
  expect(saved.threadId).toBe('current-thread')
  expect(bindSessionThread(saved, saved.threadId).threadId).toBe('current-thread')
})

test('automatic naming names an untouched canvas once and can leave a vague subject untitled', () => {
  const w = workspace(), names = { conversationTitle: 'Poster composition', canvasTitle: 'Summer exhibition' }
  const named = applyGeneratedNames(w, 'session', turn.instruction, w.project.title, names)
  expect(named.project).toMatchObject({ title: 'Summer exhibition', titleSource: 'generated' })
  expect(named.agentSessions[0]).toMatchObject({ label: 'Poster composition', labelSource: 'generated' })
  expect(applyGeneratedNames(w, 'session', turn.instruction, w.project.title, { ...names, canvasTitle: null }).project.title).toBe('Untitled canvas')
})

function fixture() {
  const calls = [], listeners = new Set()
  const rpc = {
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'config/read') return { config: { mcp_servers: { galta: { command: '/galta-mcp', required: true, tool_timeout_sec: null }, 'docs.search': { url: 'https://fixture.test/mcp', required: true } } } }
      if (method === 'thread/start') return { thread: { id: 'utility' } }
      if (method === 'turn/start') return { turn: { id: 'turn' } }
      return {}
    },
    async respond(id, result, error) { calls.push({ method: 'respond', id, result, error }) },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }
  }
  return { rpc, calls, listeners, emit(method, params, id) { for (const fn of listeners) fn({ method, params: { threadId: 'utility', ...params }, ...(id !== undefined ? { id } : {}) }) } }
}
const namingInput = { instruction: turn.instruction, reply: 'Done', canvasTitle: 'Untitled canvas', nameCanvas: true, cwd: '/tmp/fixture', model: 'fixture' }

test('publication errors preserve the failed RPC method and original cause', async () => {
  const f = fixture(), cause = new Error('Unknown native thread')
  f.rpc.request = async () => { throw cause }
  let failure
  try { await new CodexMetadata(f.rpc).nameThread('missing-thread', 'Local name') }
  catch (error) { failure = error }
  expect(failure.message).toBe('Codex thread/name/set failed: Unknown native thread')
  expect(failure.cause).toBe(cause)
})

test('archive eligibility reads every page in the canvas directory across model providers', async () => {
  const f = fixture()
  f.rpc.request = async (method, params) => {
    f.calls.push({ method, params })
    return params.cursor ? { data: [{ id: 'older-thread' }], nextCursor: null } : { data: [{ id: 'recent-thread' }], nextCursor: 'older-page' }
  }
  expect([...await new CodexMetadata(f.rpc).archivedThreads('/canvas', new AbortController().signal)]).toEqual(['recent-thread', 'older-thread'])
  expect(f.calls).toEqual([
    { method: 'thread/list', params: { archived: true, cwd: '/canvas', modelProviders: [], limit: 100 } },
    { method: 'thread/list', params: { archived: true, cwd: '/canvas', modelProviders: [], limit: 100, cursor: 'older-page' } }
  ])
})

test('archive eligibility rejects a broken page or pagination loop without declaring threads writable', async () => {
  for (const page of [{ data: [{}], nextCursor: null }, { data: [], nextCursor: 'same-page' }]) {
    const f = fixture()
    f.rpc.request = async (method, params) => { f.calls.push({ method, params }); return page }
    await expect(new CodexMetadata(f.rpc).archivedThreads('/canvas', new AbortController().signal)).rejects.toThrow('invalid archived-thread')
    expect(f.calls.length).toBeLessThanOrEqual(2)
  }
})

test('disconnect cancels an archive lookup without waiting for a stuck provider', async () => {
  const f = fixture(), stop = new AbortController()
  f.rpc.request = () => new Promise(() => {})
  const pending = new CodexMetadata(f.rpc).archivedThreads('/canvas', stop.signal)
  stop.abort(new Error('Closed canvas'))
  await expect(pending).rejects.toThrow('Closed canvas')
})

test('naming cancellation bounds a stuck configuration request without opening a thread', async () => {
  const f = fixture(), stop = new AbortController()
  f.rpc.request = () => new Promise(() => {})
  const pending = new CodexMetadata(f.rpc).generate(namingInput, stop.signal)
  stop.abort(new Error('Closed canvas'))
  await expect(pending).rejects.toThrow('Closed canvas')
  expect(f.listeners.size).toBe(0)
})

test('naming refuses host interactions and cleans up its isolated execution', async () => {
  const f = fixture(), pending = new CodexMetadata(f.rpc).generate(namingInput, new AbortController().signal)
  while (!f.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setTimeout(resolve, 0))
  f.emit('item/tool/requestUserInput', {}, 7)
  await expect(pending).rejects.toThrow('unexpectedly requested')
  expect(f.calls.find(call => call.method === 'respond').error.code).toBe(-32000)
  expect(f.calls.slice(-2).map(call => call.method)).toEqual(['turn/interrupt', 'thread/unsubscribe'])
  const config = f.calls.find(call => call.method === 'thread/start').params.config
  expect(config.mcp_servers).toEqual({ galta: { command: '/galta-mcp', enabled: false, required: false }, 'docs.search': { url: 'https://fixture.test/mcp', enabled: false, required: false } })
  expect(config['features.code_mode_only']).toBe(false)
  expect(f.calls.find(call => call.method === 'config/read').params.cwd).toBe(namingInput.cwd)
  expect(f.listeners.size).toBe(0)
})

test('invalid generated data cannot become a title and naming remains absent from the user thread', async () => {
  const f = fixture(), pending = new CodexMetadata(f.rpc).generate(namingInput, new AbortController().signal)
  while (!f.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setTimeout(resolve, 0))
  f.emit('turn/completed', { turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: '{"conversationTitle":"bad\\nname","canvasTitle":null}' }] } })
  await expect(pending).rejects.toThrow('invalid names')
  expect(f.calls.find(call => call.method === 'thread/start').params.ephemeral).toBe(true)
  expect(f.calls.at(-1).method).toBe('thread/unsubscribe')
  expect(f.listeners.size).toBe(0)
})

test('a cleanup failure cannot discard successful names and invite another model call', async () => {
  const f = fixture(), request = f.rpc.request
  f.rpc.request = async (method, params) => {
    const result = await request(method, params)
    if (method === 'thread/unsubscribe') throw new Error('Cleanup unavailable')
    return result
  }
  const pending = new CodexMetadata(f.rpc).generate(namingInput, new AbortController().signal)
  while (!f.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setTimeout(resolve, 0))
  const names = { conversationTitle: 'Poster composition', canvasTitle: 'Summer exhibition' }
  f.emit('turn/completed', { turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: JSON.stringify(names) }] } })
  await expect(pending).resolves.toEqual(names)
  expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
  expect(f.listeners.size).toBe(0)
})

for (const stage of ['thread/start', 'turn/start']) test(`late ${stage} acknowledgement after cancellation is cleaned up without retrying inference`, async () => {
  const f = fixture(), request = f.rpc.request, stop = new AbortController()
  let acknowledge
  f.rpc.request = async (method, params) => {
    const result = await request(method, params)
    if (method === stage) return new Promise(resolve => { acknowledge = () => resolve(result) })
    return result
  }
  const pending = new CodexMetadata(f.rpc).generate(namingInput, stop.signal)
  while (!acknowledge) await new Promise(resolve => setTimeout(resolve, 0))
  stop.abort(new Error('Closed canvas'))
  await expect(pending).rejects.toThrow('Closed canvas')
  acknowledge()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(f.calls.some(call => call.method === (stage === 'thread/start' ? 'thread/unsubscribe' : 'turn/interrupt'))).toBe(true)
  expect(f.calls.filter(call => call.method === stage)).toHaveLength(1)
  expect(f.listeners.size).toBe(0)
})

test('cleanup failures preserve the original naming failure and still release the subscription', async () => {
  const f = fixture(), request = f.rpc.request
  f.rpc.request = async (method, params) => {
    const result = await request(method, params)
    if (['turn/interrupt', 'thread/unsubscribe'].includes(method)) throw new Error('Cleanup unavailable')
    return result
  }
  const pending = new CodexMetadata(f.rpc).generate(namingInput, new AbortController().signal)
  while (!f.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setTimeout(resolve, 0))
  f.emit('item/tool/requestUserInput', {}, 8)
  await expect(pending).rejects.toThrow('unexpectedly requested')
  expect(f.calls.slice(-2).map(call => call.method)).toEqual(['turn/interrupt', 'thread/unsubscribe'])
  expect(f.listeners.size).toBe(0)
})
