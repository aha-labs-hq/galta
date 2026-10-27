import { test, expect } from 'bun:test'
import { NativeCodexAdapter } from '../apps/extension/src/background/codexAdapter.ts'
import { compatibleCodexConfig } from './helpers/codex-config.ts'

test('server requests cannot resolve client RPCs; ownership survives closing during turn/start', async () => {
  const previous = globalThis.chrome
  const listeners = new Set(), sent = [], notifications = []
  const emit = message => listeners.forEach(fn => fn(message))
  const port = { onMessage: { addListener: fn => listeners.add(fn) }, onDisconnect: { addListener() {} }, postMessage(message) {
    sent.push(message)
    if (message.method && message.id !== undefined && message.method !== 'turn/start') queueMicrotask(() => emit({ id: message.id, result: message.method === 'config/read' ? compatibleCodexConfig() : {} }))
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

function fixture() {
  const listeners = new Set(), sent = []
  const emit = message => listeners.forEach(listener => listener(message))
  const port = { disconnects: 0, disconnect() { this.disconnects++ }, onMessage: { addListener: fn => listeners.add(fn) }, onDisconnect: { addListener() {} }, postMessage(message) {
    sent.push(message)
    if (message.method && message.id !== undefined && message.method !== 'turn/interrupt') queueMicrotask(() => emit({ id: message.id, result: message.method === 'config/read' ? compatibleCodexConfig() : message.method === 'turn/start' ? { turn: { id: 'current' } } : {} }))
  } }
  return { port, emit, sent }
}

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
