import { test, expect } from 'bun:test'
import { CanvasRegistry } from '../native/bridge/registry'
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const canvas = { id: 'a', projectId: 'document', title: 'Canvas' }

test('document reservation spans surfaces and both embedded and external execution', async () => {
  const registry = new CanvasRegistry(async () => ({}), async () => '/workspace')
  registry.register(canvas); registry.register({ ...canvas, id: 'b' })
  const a = await registry.connect('a', 'Codex', 'embedded')
  const second = await registry.connect('b', 'Codex-2', 'embedded')
  expect(registry.list().every(c => c.busy)).toBe(true)
  await expect(registry.connect('b', 'Claude')).rejects.toThrow('active agent')
  await registry.release(a.id)
  expect(registry.list().every(c => c.busy)).toBe(true)
  await registry.release(second.id)
  const b = await registry.connect('b', 'Claude')
  expect(b.mode).toBe('external')
  await expect(registry.connect('a', 'Codex', 'embedded')).rejects.toThrow('active agent')
  await registry.close()
})

test('closing during workspace preparation cannot start a late browser execution', async () => {
  const gate = deferred(), calls = []
  const registry = new CanvasRegistry(async (_, method) => { calls.push(method) }, () => gate.promise)
  registry.register(canvas)
  const connect = registry.connect('a', 'client')
  const failed = connect.catch(error => error)
  await registry.unregister('a'); gate.resolve('/workspace')
  expect((await failed).message).toContain('ended')
  expect(calls).toEqual([])
  registry.register(canvas)
  expect(registry.list()[0].busy).toBe(false)
})

test('cancelled begin receives teardown and cannot leave a reservation', async () => {
  const begun = deferred(), abort = new AbortController(), calls = []
  const registry = new CanvasRegistry(async (_, method, params, signal) => {
    calls.push(method)
    if (method === 'begin') { begun.resolve(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }
  }, async () => '/workspace')
  registry.register(canvas)
  const pending = registry.connect('a', 'client', 'external', abort.signal)
  const failed = pending.catch(error => error)
  await begun.promise; abort.abort(); expect((await failed).message).toContain('cancelled')
  expect(calls).toEqual(['begin', 'end'])
  expect(registry.list()[0].busy).toBe(false)
})

test('release cancels an in-flight call and fences its late response', async () => {
  const gate = deferred(); let callSignal
  const registry = new CanvasRegistry(async (_, method, params, signal) => {
    if (method === 'call') { callSignal = signal; return gate.promise }
  }, async () => '/workspace')
  registry.register(canvas)
  const lease = await registry.connect('a', 'client')
  const pending = registry.call(lease.id, 'canvas_edit', {})
  const failed = pending.catch(error => error)
  await expect(registry.call(lease.id, 'canvas_inspect', {})).rejects.toThrow('already running')
  await registry.release(lease.id)
  expect(callSignal.aborted).toBe(true)
  gate.resolve({ content: [] }); expect((await failed).message).toContain('ended')
  await expect(registry.call(lease.id, 'canvas_edit', {})).rejects.toThrow('not active')
})

test('unacknowledged teardown retires the surface instead of admitting another agent', async () => {
  const registry = new CanvasRegistry(async (_, method) => { if (method === 'end') throw new Error('transport lost') }, async () => '/workspace')
  registry.register(canvas)
  const lease = await registry.connect('a', 'client')
  await expect(registry.release(lease.id)).rejects.toThrow('transport lost')
  expect(registry.list()).toEqual([])
  await expect(registry.connect('a', 'next')).rejects.toThrow('no longer open')
})

test('a live surface cannot switch document identity', () => {
  const registry = new CanvasRegistry(async () => {}, async () => '/workspace')
  registry.register(canvas)
  expect(() => registry.register({ ...canvas, projectId: 'other' })).toThrow('cannot change')
})

test('independent observations may run together, while writes remain exclusive', async () => {
  const gate = deferred()
  const registry = new CanvasRegistry(async (_, method) => method === 'call' ? gate.promise : {}, async () => '/workspace')
  registry.register(canvas)
  const lease = await registry.connect('a', 'client')
  const status = registry.call(lease.id, 'canvas_inspect', {}), view = registry.call(lease.id, 'canvas_capture', {})
  await expect(registry.call(lease.id, 'canvas_edit', {})).rejects.toThrow('already running')
  gate.resolve({ content: [] })
  await Promise.all([status, view])
  await registry.release(lease.id)
})

test('canvas observations and exports compose with a separate webpage operation', async () => {
  const gate = deferred(), dispatched = []
  const registry = new CanvasRegistry(async (_, method, params) => {
    if (method === 'call') { dispatched.push(params.tool); return gate.promise }
  }, async () => '/workspace')
  registry.register(canvas)
  const lease = await registry.connect('a', 'client')
  const tools = ['canvas_inspect', 'canvas_capture', 'canvas_extract', 'browser_capture']
  const pending = tools.map(tool => registry.call(lease.id, tool, {}).catch(error => error))
  try {
    expect(dispatched).toEqual(tools)
    await expect(registry.call(lease.id, 'canvas_edit', {})).rejects.toThrow('already running')
    // Reading again replaces webpage refs; it cannot race the capture.
    await expect(registry.call(lease.id, 'browser_inspect', {})).rejects.toThrow('already running')
    await expect(registry.call(lease.id, 'unknown', {})).rejects.toThrow('Unknown')
  } finally { gate.resolve({ content: [] }); await Promise.all(pending); await registry.release(lease.id) }
})

test('canvas mutation and webpage work have separate exclusion and both stop with the lease', async () => {
  const gate = deferred(), signals = []
  const registry = new CanvasRegistry(async (_, method, params, signal) => {
    if (method === 'call') { signals.push(signal); return gate.promise }
  }, async () => '/workspace')
  registry.register(canvas)
  const lease = await registry.connect('a', 'client')
  const pending = ['canvas_edit', 'browser_inspect'].map(tool => registry.call(lease.id, tool, {}).catch(error => error))
  try {
    expect(signals).toHaveLength(2)
    await expect(registry.call(lease.id, 'canvas_extract', {})).rejects.toThrow('already running')
    await expect(registry.call(lease.id, 'browser_act', {})).rejects.toThrow('already running')
    await registry.release(lease.id)
    expect(signals.every(signal => signal.aborted)).toBe(true)
  } finally { gate.resolve({ content: [] }); await registry.release(lease.id) }
  expect((await Promise.all(pending)).every(error => error.message.includes('ended'))).toBe(true)
})
