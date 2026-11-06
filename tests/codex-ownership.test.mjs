import { test, expect } from 'bun:test'
import { NativeCodexAdapter } from '../apps/extension/src/background/codexAdapter.ts'
import { compatibleCodexConfig } from './helpers/codex-config.ts'
import { CodexAgentRuntime } from '../packages/runtime/src/codex.ts'
import { galtaToolContract } from '../packages/canvas/src/contract'

test('server requests cannot resolve client RPCs; ownership survives closing during turn/start', async () => {
  const previous = globalThis.chrome
  const listeners = new Set(), sent = [], notifications = []
  const emit = message => listeners.forEach(fn => fn(message))
  const port = { onMessage: { addListener: fn => listeners.add(fn) }, onDisconnect: { addListener() {} }, postMessage(message) {
    sent.push(message)
    if (message.method && message.id !== undefined && message.method !== 'turn/start') queueMicrotask(() => emit({ id: message.id, result: message.method === 'galta/config/read' ? { conversationStorage: 'galta' } : message.method === 'config/read' ? compatibleCodexConfig() : {} }))
  } }
  globalThis.chrome = { runtime: { connectNative: () => port, sendMessage: async n => { notifications.push(n) } } }
  try {
    const bridge = new NativeCodexAdapter()
    await bridge.request('ready')
    const started = bridge.requestForOwner('canvas-a', 'turn/start', { threadId: 'thread-a' })
    await new Promise(r => setTimeout(r, 0))
    const start = sent.find(m => m.method === 'turn/start')
    // Server and client identifiers are separate JSON-RPC directions.
    emit({ id: start.id, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a' } })
    expect(notifications.at(-1).notification.ownerId).toBe('canvas-a')
    expect(() => bridge.respond('canvas-b', start.id, {})).toThrow('belongs')
    bridge.respond('canvas-a', start.id, { decision: 'decline' })
    expect(sent.at(-1)).toEqual({ id: start.id, result: { decision: 'decline' } })
    bridge.releaseOwner('canvas-a')
    await expect(bridge.requestForOwner('canvas-b', 'turn/start', { threadId: 'thread-a' })).rejects.toThrow('already running')
    emit({ id: start.id, result: { turn: { id: 'turn-a' } } })
    expect(await started).toEqual({ turn: { id: 'turn-a' } })
    emit({ method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-a' } } })
    await new Promise(r => setTimeout(r, 0))
    expect(sent.filter(m => m.method === 'turn/interrupt')).toHaveLength(1)
    emit({ id: 902, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a' } })
    expect(sent.at(-1).error.message).toContain('not available')
    emit({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'interrupted' } } })
    const next = bridge.requestForOwner('canvas-b', 'turn/start', { threadId: 'thread-a' })
    await new Promise(r => setTimeout(r, 0))
    emit({ id: sent.at(-1).id, result: { turn: { id: 'turn-b' } } })
    expect(await next).toEqual({ turn: { id: 'turn-b' } })
  } finally { globalThis.chrome = previous }
})

test('steer is fenced to the task that owns the active turn', async () => {
  const previous = globalThis.chrome, f = fixture()
  globalThis.chrome = { runtime: { connectNative: () => f.port, sendMessage: async () => {} } }
  try {
    const bridge = new NativeCodexAdapter()
    await bridge.requestForOwner('task-a', 'turn/start', { threadId: 'thread' })
    f.emit({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'current' } } })
    await bridge.requestForOwner('task-a', 'turn/steer', { threadId: 'thread', expectedTurnId: 'current', input: [{ type: 'text', text: 'Continue' }] })
    expect(f.sent.at(-1).method).toBe('turn/steer')
    await expect(bridge.requestForOwner('task-b', 'turn/steer', { threadId: 'thread', expectedTurnId: 'current', input: [] })).rejects.toThrow('not owned')
  } finally { globalThis.chrome = previous }
})

function fixture(pendingThread) {
  const listeners = new Set(), sent = []
  const emit = message => listeners.forEach(listener => listener(message))
  const port = { disconnects: 0, disconnect() { this.disconnects++ }, onMessage: { addListener: fn => listeners.add(fn) }, onDisconnect: { addListener() {} }, postMessage(message) {
    sent.push(message)
    if (message.method && message.id !== undefined && message.method !== 'turn/interrupt' && !(message.method === 'turn/start' && message.params.threadId === pendingThread)) queueMicrotask(() => emit({ id: message.id, result: message.method === 'galta/config/read' ? { conversationStorage: 'galta' } : message.method === 'config/read' ? compatibleCodexConfig() : message.method === 'turn/start' ? { turn: { id: 'current' } } : {} }))
  } }
  return { port, emit, sent }
}

test('thread cleanup cannot unsubscribe a running turn in the shared adapter', async () => {
  const previous = globalThis.chrome, f = fixture()
  globalThis.chrome = { runtime: { connectNative: () => f.port, sendMessage: async () => {} } }
  try {
    const bridge = new NativeCodexAdapter()
    await bridge.requestForOwner('task-a', 'turn/start', { threadId: 'thread' })
    for (const owner of ['task-a', 'task-b']) {
      await expect(bridge.requestForOwner(owner, 'thread/unsubscribe', { threadId: 'thread' })).rejects.toThrow('still running')
    }
    expect(f.sent.some(message => message.method === 'thread/unsubscribe')).toBe(false)
    f.emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'current', status: 'completed' } } })
    await bridge.requestForOwner('task-a', 'thread/unsubscribe', { threadId: 'thread' })
    expect(f.sent.at(-1).method).toBe('thread/unsubscribe')
  } finally { globalThis.chrome = previous }
})

test('an old turn completion cannot release the active owner or route its approvals elsewhere', async () => {
  const previous = globalThis.chrome, f = fixture()
  globalThis.chrome = { runtime: { connectNative: () => f.port, sendMessage: async () => {} } }
  try {
    const bridge = new NativeCodexAdapter()
    await bridge.requestForOwner('task', 'turn/start', { threadId: 'thread' })
    f.emit({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'current' } } })
    f.emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'previous', status: 'completed' } } })
    await expect(bridge.requestForOwner('other', 'turn/start', { threadId: 'thread' })).rejects.toThrow('already running')
    f.emit({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'current' } })
    expect(() => bridge.respond('task', 900, { decision: 'decline' })).not.toThrow()
  } finally { globalThis.chrome = previous }
})

test('a failed orphan interruption retires the actual transport; a late rejection after completion does not', async () => {
  const previous = globalThis.chrome
  try {
    for (const completed of [false, true]) {
      const f = fixture(), notifications = []
      globalThis.chrome = { runtime: { connectNative: () => f.port, sendMessage: async () => {} } }
      const bridge = new NativeCodexAdapter()
      bridge.subscribe(n => notifications.push(n))
      await bridge.requestForOwner('task', 'turn/start', { threadId: 'thread' })
      f.emit({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'current' } } })
      bridge.releaseOwner('task')
      await new Promise(resolve => setTimeout(resolve, 0))
      const interrupt = f.sent.find(message => message.method === 'turn/interrupt')
      if (completed) f.emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'current', status: 'completed' } } })
      f.emit({ id: interrupt.id, error: { code: -32000, message: 'Unable to interrupt' } })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(f.port.disconnects).toBe(completed ? 0 : 1)
      expect(notifications.filter(n => n.method === 'galta/connection-lost')).toHaveLength(completed ? 0 : 1)
      expect(bridge.reconnectWhenIdle()).toBe(true)
    }
  } finally { globalThis.chrome = previous }
})

for (const trigger of ['detach', 'stop']) for (const completed of [false, true]) test(`${trigger} bounds acknowledged cancellation; completion observed: ${completed}`, async () => {
  const previous = globalThis.chrome, originalTimeout = globalThis.setTimeout
  const f = fixture(), timers = []
  globalThis.chrome = { runtime: { connectNative: () => f.port, sendMessage: async () => {} } }
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 10_000) { timers.push(callback); return originalTimeout(() => {}, 1000) }
    return originalTimeout(callback, delay, ...args)
  }
  try {
    const bridge = new NativeCodexAdapter()
    await bridge.requestForOwner('task', 'turn/start', { threadId: 'thread' })
    f.emit({ method: 'error', params: { threadId: 'thread', turnId: 'current', willRetry: true, error: { message: 'Reconnecting' } } })
    let stopping
    if (trigger === 'detach') bridge.releaseOwner('task')
    else {
      await expect(bridge.requestForOwner('another-task', 'turn/interrupt', { threadId: 'thread', turnId: 'current' })).rejects.toThrow('not owned')
      stopping = bridge.requestForOwner('task', 'turn/interrupt', { threadId: 'thread', turnId: 'current' })
    }
    await new Promise(resolve => originalTimeout(resolve, 0))
    const interrupt = f.sent.find(message => message.method === 'turn/interrupt')
    f.emit({ id: interrupt.id, result: {} })
    await stopping
    expect(f.port.disconnects).toBe(0)
    if (completed) {
      f.emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'current', status: 'interrupted' } } })
      await bridge.requestForOwner('next-task', 'turn/start', { threadId: 'thread' })
    }
    timers[0]()
    expect(f.port.disconnects).toBe(completed ? 0 : 1)
    if (completed) f.emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'current', status: 'completed' } } })
    expect(bridge.reconnectWhenIdle()).toBe(true)
  } finally { globalThis.setTimeout = originalTimeout; globalThis.chrome = previous }
})

for (const observed of [false, true]) test(`a lost start response retains ownership during cancellation alongside another turn; start observed: ${observed}`, async () => {
  const originalTimeout = globalThis.setTimeout, timers = [], f = fixture('uncertain')
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 10_000 || delay === 60_000) {
      const handle = originalTimeout(() => {}, 1000)
      timers.push({ callback, delay, handle }); return handle
    }
    return originalTimeout(callback, delay, ...args)
  }
  const bridge = new NativeCodexAdapter({ connectNative: () => f.port, sendMessage: async () => {} })
  try {
    await bridge.requestForOwner('other-task', 'turn/start', { threadId: 'other' })
    const pending = bridge.requestForOwner('task', 'turn/start', { threadId: 'uncertain' }).catch(error => error)
    await new Promise(resolve => originalTimeout(resolve, 0))
    if (observed) f.emit({ method: 'turn/started', params: { threadId: 'uncertain', turn: { id: 'current' } } })
    timers.filter(timer => timer.delay === 60_000).at(-1).callback()
    expect((await pending).message).toContain('did not respond')
    await expect(bridge.requestForOwner('new-task', 'turn/start', { threadId: 'uncertain' })).rejects.toThrow('already running')
    await expect(bridge.requestForOwner('task', 'thread/unsubscribe', { threadId: 'uncertain' })).rejects.toThrow('still running')
    if (!observed) f.emit({ method: 'turn/started', params: { threadId: 'uncertain', turn: { id: 'current' } } })
    await new Promise(resolve => originalTimeout(resolve, 0))
    const interrupt = f.sent.find(message => message.method === 'turn/interrupt')
    expect(interrupt.params).toEqual({ threadId: 'uncertain', turnId: 'current' })
    f.emit({ id: interrupt.id, result: {} })
    expect(f.port.disconnects).toBe(0)
    timers.find(timer => timer.delay === 10_000).callback()
    expect(f.port.disconnects).toBe(1)
    expect(f.sent.filter(message => message.method === 'turn/start')).toHaveLength(2)
  } finally {
    for (const timer of timers) clearTimeout(timer.handle)
    globalThis.setTimeout = originalTimeout
  }
})

for (const arrives of [false, true]) test(`Stop supervises a pending turn/start without a turn id; response eventually arrives: ${arrives}`, async () => {
  const originalTimeout = globalThis.setTimeout, timers = [], f = fixture('pending')
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 10_000) {
      const handle = originalTimeout(() => {}, 1000)
      timers.push({ callback, handle }); return handle
    }
    return originalTimeout(callback, delay, ...args)
  }
  let connections = 0, iterator
  const bridge = new NativeCodexAdapter({ connectNative: () => { connections++; return f.port }, sendMessage: async () => {} })
  const rpc = {
    subscribe: listener => bridge.subscribe(listener), respond: async () => {},
    request: async (method, params) => {
      if (method === 'galta/config/read') return { toolContract: await galtaToolContract(), conversationStorage: 'galta' }
      if (method === 'thread/start') return { thread: { id: 'pending' } }
      return bridge.requestForOwner('task', method, params)
    }
  }
  try {
    const runtime = new CodexAgentRuntime(rpc)
    const handle = await runtime.start({ projectId: 'canvas', branchId: 'main', instruction: 'Draw', execution: { id: 'execution', cwd: '/fixture' }, runtime: { sessionId: 'session', sessionLabel: 'New conversation', modelId: 'model', effort: 'Low', providerId: 'codex-app-server' } }, { request: async () => ({}) })
    iterator = handle.updates[Symbol.asyncIterator]()
    await iterator.next(); await iterator.next()
    const pending = iterator.next().catch(error => error)
    await new Promise(resolve => originalTimeout(resolve, 0))
    await runtime.stop(handle.runId)
    expect(timers).toHaveLength(1)
    expect(f.sent.some(message => message.method === 'galta/turn/cancel' || message.method === 'turn/interrupt')).toBe(false)
    if (arrives) {
      const start = f.sent.find(message => message.method === 'turn/start')
      f.emit({ id: start.id, result: { turn: { id: 'late-turn' } } })
      expect((await pending).value.turnId).toBe('late-turn')
      await new Promise(resolve => originalTimeout(resolve, 0))
      const interrupts = f.sent.filter(message => message.method === 'turn/interrupt')
      expect(interrupts).toHaveLength(1)
      expect(interrupts[0].params).toEqual({ threadId: 'pending', turnId: 'late-turn' })
      f.emit({ id: interrupts[0].id, result: {} })
      f.emit({ method: 'item/completed', params: { threadId: 'pending', turnId: 'late-turn', item: { type: 'agentMessage', id: 'receipt', text: 'Saved before stopping' } } })
      f.emit({ method: 'turn/completed', params: { threadId: 'pending', turn: { id: 'late-turn', status: 'interrupted' } } })
      expect((await iterator.next()).value.item.text).toBe('Saved before stopping')
      expect((await iterator.next()).value.state).toBe('stopped')
      timers[0].callback()
      expect(f.port.disconnects).toBe(0)
    } else {
      timers[0].callback()
      expect((await pending).message).toContain('Chat was interrupted')
      expect(f.port.disconnects).toBe(1)
      expect(f.sent.some(message => message.method === 'thread/unsubscribe')).toBe(false)
    }
    expect(connections).toBe(1)
    expect(f.sent.filter(message => message.method === 'turn/start')).toHaveLength(1)
  } finally {
    await iterator?.return()
    for (const timer of timers) clearTimeout(timer.handle)
    globalThis.setTimeout = originalTimeout
  }
})
