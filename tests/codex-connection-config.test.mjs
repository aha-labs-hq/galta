import { test, expect } from 'bun:test'
import { NativeCodexAdapter } from '../apps/extension/src/background/codexAdapter.ts'
import { compatibleCodexConfig } from './helpers/codex-config.ts'

const compatible = compatibleCodexConfig()

test('a unified MCP with global execution discovery is rejected before account or turn calls', async () => {
  const previous = globalThis.chrome, configuration = structuredClone(compatible)
  delete configuration.config.mcp_servers.galta.env
  const { port, calls } = portFixture(configuration)
  try {
    globalThis.chrome = { runtime: { connectNative: () => port, sendMessage: async () => {} } }
    const bridge = new NativeCodexAdapter()
    await expect(bridge.request('account/read')).rejects.toThrow('each UI execution')
    expect(calls.map(call => call.method)).toEqual(['initialize', 'initialized', 'config/read'])
    expect(port.disconnects).toBe(1)
  } finally { globalThis.chrome = previous }
})

function portFixture(configuration, dropMethods = new Set()) {
  const listeners = new Set(), disconnected = new Set(), calls = []
  const port = {
    disconnects: 0,
    onMessage: { addListener: listener => listeners.add(listener) },
    onDisconnect: { addListener: listener => disconnected.add(listener) },
    disconnect() { this.disconnects++ },
    emitDisconnect() { for (const listener of disconnected) listener() },
    emitMessage(message) { for (const listener of listeners) listener(message) },
    postMessage(message) {
      calls.push(message)
      if (message.id === undefined) return
      if (dropMethods.has(message.method)) return
      const result = message.method === 'config/read' ? configuration : {}
      queueMicrotask(() => listeners.forEach(listener => listener({ id: message.id, result })))
    }
  }
  return { port, calls }
}

test('connection rejects a missing or browser-only MCP before issuing an application request', async () => {
  const previous = globalThis.chrome
  try {
    for (const config of [{}, { config: { mcp_servers: { galta_browser: {} } } }, { config: { mcp_servers: { galta: { command: '/test/galta-mcp', args: ['--browser-only'] } } } }]) {
      const { port, calls } = portFixture(config)
      globalThis.chrome = { runtime: { connectNative: () => port, sendMessage: async () => {} } }
      const bridge = new NativeCodexAdapter()
      const notifications = []
      bridge.subscribe(notification => notifications.push(notification))
      await expect(bridge.request('account/read')).rejects.toThrow('unified Galta MCP')
      expect(calls.map(call => call.method)).toEqual(['initialize', 'initialized', 'config/read'])
      expect(port.disconnects).toBe(1)
      expect(notifications).toHaveLength(1)
      expect(notifications[0]).toMatchObject({ method: 'galta/connection-lost', params: { message: expect.stringContaining('unified Galta MCP') } })
    }
  } finally { globalThis.chrome = previous }
})

test('connection rejects inherited desktop notifications, incompatible execution policy and shared memory', async () => {
  const previous = globalThis.chrome
  try {
    for (const change of [
      config => { delete config.notify },
      config => { config.notify = ['desktop-helper', 'turn-ended'] },
      config => { config.approval_policy = 'on-request' },
      config => { config.sandbox_mode = 'workspace-write' },
      config => { config.apps._default.default_tools_approval_mode = 'prompt' },
      config => { config.features.memories = true },
      config => { delete config.memories }
    ]) {
      const response = compatibleCodexConfig()
      change(response.config)
      const { port, calls } = portFixture(response)
      globalThis.chrome = { runtime: { connectNative: () => port, sendMessage: async () => {} } }
      const bridge = new NativeCodexAdapter()
      await expect(bridge.request('account/read')).rejects.toThrow('Rebuild the Galta bridge and reconnect')
      expect(calls.map(call => call.method)).toEqual(['initialize', 'initialized', 'config/read'])
      expect(port.disconnects).toBe(1)
    }
  } finally { globalThis.chrome = previous }
})

test('malformed transport clears pending calls locally and retired messages cannot reach a replacement', async () => {
  const previous = globalThis.chrome
  const retired = portFixture(compatible), current = portFixture(compatible)
  let connections = 0
  globalThis.chrome = { runtime: { connectNative: () => ++connections === 1 ? retired.port : current.port, sendMessage: async () => {} } }
  try {
    const bridge = new NativeCodexAdapter()
    const notifications = []
    bridge.subscribe(notification => notifications.push(notification))
    await bridge.request('account/read')
    retired.port.postMessage = message => {
      retired.calls.push(message)
      retired.port.emitMessage({ method: 'galta/transport/chunk', params: {} })
    }
    await expect(bridge.request('model/list')).rejects.toThrow('Invalid Codex message fragment')
    expect(retired.port.disconnects).toBe(1)
    await bridge.request('account/read')
    retired.port.emitMessage({ method: 'turn/completed', params: { threadId: 'retired' } })
    retired.port.emitDisconnect()
    await bridge.request('model/list')
    expect(notifications.map(notification => notification.method)).toEqual(['galta/connection-lost'])
    expect(connections).toBe(2)
    expect(current.port.disconnects).toBe(0)
  } finally { globalThis.chrome = previous }
})

test('reconnection verifies the new host once and ignores the retired port disconnect', async () => {
  const previous = globalThis.chrome
  const retired = portFixture({}), current = portFixture(compatible)
  let connections = 0
  globalThis.chrome = { runtime: { connectNative: () => ++connections === 1 ? retired.port : current.port, sendMessage: async () => {} } }
  try {
    const bridge = new NativeCodexAdapter()
    await expect(bridge.request('account/read')).rejects.toThrow('unified Galta MCP')
    await Promise.all([bridge.request('account/read'), bridge.request('model/list')])
    retired.port.emitDisconnect()
    await bridge.request('model/list')
    expect(connections).toBe(2)
    expect(current.calls.filter(call => call.method === 'config/read')).toHaveLength(1)
    expect(current.port.disconnects).toBe(0)
  } finally { globalThis.chrome = previous }
})

test('a timed out connection read retires the dead host before the next retry', async () => {
  const previous = globalThis.chrome, previousSetTimeout = globalThis.setTimeout
  const dead = portFixture(compatible, new Set(['account/read'])), healthy = portFixture(compatible)
  let connections = 0
  // Keep the failure test fast while preserving the production timeout path.
  globalThis.setTimeout = (callback, _delay, ...args) => previousSetTimeout(callback, 0, ...args)
  globalThis.chrome = { runtime: { connectNative: () => ++connections === 1 ? dead.port : healthy.port, sendMessage: async () => {} } }
  try {
    const bridge = new NativeCodexAdapter()
    await expect(bridge.request('account/read')).rejects.toThrow('Codex did not respond')
    expect(dead.port.disconnects).toBe(1)
    await bridge.request('account/read')
    expect(connections).toBe(2)
    expect(healthy.calls.map(call => call.method)).toEqual(['initialize', 'initialized', 'config/read', 'account/read'])
  } finally {
    globalThis.setTimeout = previousSetTimeout
    if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous
  }
})

test('runtime replacement waits for active work and retires the host after the last client leaves', async () => {
  const previous = globalThis.chrome, { port } = portFixture(compatible)
  globalThis.chrome = { runtime: { connectNative: () => port, sendMessage: async () => {} } }
  try {
    const bridge = new NativeCodexAdapter()
    bridge.attachClient('canvas-one')
    await bridge.requestForOwner('canvas-one', 'turn/start', { threadId: 'one' })
    port.emitMessage({ method: 'turn/started', params: { threadId: 'one', turn: { id: 'active' } } })
    expect(bridge.reconnectWhenIdle()).toBe(false)
    bridge.detachClient('canvas-one')
    expect(port.disconnects).toBe(0)
    port.emitMessage({ method: 'turn/completed', params: { threadId: 'one', turn: { id: 'active', status: 'interrupted' } } })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(port.disconnects).toBe(1)
    expect(bridge.reconnectWhenIdle()).toBe(true)
  } finally { globalThis.chrome = previous }
})

test('a tool list changed during a turn is adopted when the turn ends, not before', async () => {
  const previous = globalThis.chrome, { port } = portFixture(compatible)
  globalThis.chrome = { runtime: { connectNative: () => port, sendMessage: async () => {} } }
  try {
    const bridge = new NativeCodexAdapter()
    bridge.attachClient('canvas-one')
    await bridge.requestForOwner('canvas-one', 'turn/start', { threadId: 'one' })
    port.emitMessage({ method: 'turn/started', params: { threadId: 'one', turn: { id: 'active' } } })
    bridge.refreshTools()
    expect(port.disconnects).toBe(0)
    port.emitMessage({ method: 'turn/completed', params: { threadId: 'one', turn: { id: 'active', status: 'completed' } } })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(port.disconnects).toBe(1)
  } finally { globalThis.chrome = previous }
})

test('closing the last canvas during a connection read retires the host after the reply', async () => {
  const previous = globalThis.chrome, { port } = portFixture(compatible)
  globalThis.chrome = { runtime: { connectNative: () => port, sendMessage: async () => {} } }
  try {
    const bridge = new NativeCodexAdapter()
    bridge.attachClient('closing-canvas')
    await bridge.request('account/read')
    let request
    port.postMessage = message => { request = message }
    const pending = bridge.request('model/list')
    await new Promise(resolve => queueMicrotask(resolve))
    bridge.detachClient('closing-canvas')
    expect(port.disconnects).toBe(0)
    port.emitMessage({ id: request.id, result: { data: [] } })
    await pending
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(port.disconnects).toBe(1)
  } finally { globalThis.chrome = previous }
})

test('a connection that gives Galta tools too little time to wait for a generation is refused', async () => {
  const { assertCodexEmbeddedConfig } = await import('../packages/runtime/src/codexConfig.ts')
  const { compatibleCodexConfig } = await import('./helpers/codex-config.ts')
  expect(() => assertCodexEmbeddedConfig(compatibleCodexConfig())).not.toThrow()
  const short = compatibleCodexConfig()
  delete short.config.mcp_servers.galta.tool_timeout_sec
  expect(() => assertCodexEmbeddedConfig(short)).toThrow('too little time')
})
