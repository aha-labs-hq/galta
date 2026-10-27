import { test, expect } from 'bun:test'
import { CanvasAgentConnection } from '../apps/extension/src/canvas/agentConnection'
import { galtaToolContract } from '../packages/canvas/src/contract'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture(host = {}) {
  const ports = [], ended = [], errors = []
  const original = globalThis.chrome
  globalThis.chrome = { runtime: { connect() {
    const messages = [], listeners = [], disconnects = []
    const port = { messages, disconnected: false,
      onMessage: { addListener: fn => listeners.push(fn) }, onDisconnect: { addListener: fn => disconnects.push(fn) },
      postMessage(message) { if (port.disconnected) throw new Error('Port closed'); messages.push(message) },
      emit(message) { listeners.forEach(fn => fn(message)) },
      disconnect() { port.disconnected = true; disconnects.forEach(fn => fn()) }
    }
    ports.push(port); return port
  } } }
  const connection = new CanvasAgentConnection({ begin: async () => {}, call: async () => ({ content: [] }),
    end: async id => { ended.push(id) }, disconnected: error => errors.push(error), ...host })
  const open = async (contract) => {
    contract ??= await galtaToolContract()
    const ready = connection.open('document', 'Canvas'), port = ports.at(-1)
    await flush()
    port.emit({ id: port.messages[0].id, result: { toolContract: contract } }); await ready; return port
  }
  return { connection, open, ended, errors, restore() { connection.close(); globalThis.chrome = original } }
}
const begin = (port, id) => port.emit({ id: `begin-${id}`, method: 'canvas/begin', params: { id, projectId: 'document', canvasId: 'surface', mode: 'external', client: 'test', cwd: '/tmp/test' } })

test('a stale native canvas contract closes the connection before a lease can be acquired', async () => {
  const f = fixture()
  try {
    await expect(f.open('old-contract')).rejects.toThrow('incompatible tools')
    await expect(f.connection.acquire()).rejects.toThrow('unavailable')
    expect(f.errors).toHaveLength(1)
  } finally { f.restore() }
})

test('a failed browser connection consumes and reports the native port error', async () => {
  const f = fixture(); let reads = 0
  try {
    const port = await f.open()
    Object.defineProperty(globalThis.chrome.runtime, 'lastError', { get() { reads++; return { message: 'Receiving end does not exist.' } } })
    port.disconnect()
    expect(reads).toBeGreaterThan(0)
    expect(f.errors).toEqual(['Receiving end does not exist.'])
  } finally { f.restore() }
})

test('disconnect rejects pending requests, cancels calls and ends an execution once', async () => {
  const gate = deferred(); let signal
  const f = fixture({ call: async (_, __, value) => { signal = value; await gate.promise; return { content: [] } } })
  try {
    const port = await f.open(); begin(port, 'a'); await flush()
    port.emit({ id: 'call', method: 'canvas/call', params: { leaseId: 'a', tool: 'canvas_capture', args: {} } })
    const pending = f.connection.request('artifact/read-image', {}).catch(error => error.message)
    const count = port.messages.length
    f.connection.close('Disconnected'); f.connection.close('Again')
    expect(await pending).toBe('Disconnected')
    expect(signal.aborted).toBe(true)
    expect(f.ended).toEqual(['a'])
    gate.resolve(); await flush()
    expect(port.messages).toHaveLength(count)
  } finally { f.restore() }
})

test('a late result cannot be posted to a replacement connection', async () => {
  const gate = deferred(), f = fixture({ call: () => gate.promise })
  try {
    const old = await f.open(); begin(old, 'a'); await flush()
    old.emit({ id: 'old-call', method: 'canvas/call', params: { leaseId: 'a', tool: 'canvas_capture', args: {} } })
    f.connection.close()
    const next = await f.open(); begin(next, 'b'); await flush()
    gate.resolve({ content: [] }); await flush()
    expect(next.messages.some(message => message.id === 'old-call')).toBe(false)
    expect(next.messages.find(message => message.id === 'begin-b').error).toBeUndefined()
  } finally { f.restore() }
})

test('failed cleanup is reported instead of becoming an unhandled rejection', async () => {
  const f = fixture({ end: async () => { throw new Error('Stop failed') } })
  try {
    const port = await f.open(); begin(port, 'a'); await flush()
    f.connection.close(); await flush()
    expect(f.errors).toContain('Canvas cleanup failed: Error: Stop failed')
  } finally { f.restore() }
})

test('ending an old preparation cannot clear a newer lease', async () => {
  const gate = deferred(), f = fixture({ begin: async lease => { if (lease.id === 'a') await gate.promise } })
  try {
    const port = await f.open(); begin(port, 'a')
    port.emit({ id: 'end-a', method: 'canvas/end', params: { leaseId: 'a' } }); await flush()
    begin(port, 'b'); await flush(); gate.resolve(); await flush()
    port.emit({ id: 'call-b', method: 'canvas/call', params: { leaseId: 'b', tool: 'canvas_inspect', args: {} } }); await flush()
    expect(port.messages.find(message => message.id === 'call-b').error).toBeUndefined()
    expect(port.messages.find(message => message.id === 'begin-a').error).toBeTruthy()
  } finally { f.restore() }
})

test('video transfer reconstructs binary chunks and stops on cancellation or a changed source', async () => {
  const f = fixture()
  try {
    const port = await f.open(); begin(port, 'video'); await flush()
    const controller = new AbortController(), scope = { executionId: 'video', signal: controller.signal }
    const reply = (offset, text, version = 'original') => {
      const request = port.messages.at(-1)
      expect(request.method).toBe('artifact/read-video')
      expect(request.params).toMatchObject({ path: '/tmp/test/movie.webm', offset, leaseId: 'video' })
      port.emit({ id: request.id, result: { offset, nextOffset: offset + text.length, total: 6, dataBase64: btoa(text), version, mimeType: 'video/webm' } })
    }
    const read = () => f.connection.artifacts().readVideo('/tmp/test/movie.webm', scope)
    const complete = read(); reply(0, 'abc'); await flush()
    expect(port.messages.at(-1).params.version).toBe('original')
    reply(3, 'def')
    const blob = await complete
    expect(blob.type).toBe('video/webm'); expect(await blob.text()).toBe('abcdef')
    const changed = read().catch(error => error.message)
    reply(0, 'abc'); await flush(); reply(3, 'def', 'replaced')
    expect(await changed).toBe('Invalid video transfer')
    const cancelled = read().catch(error => error.message), count = port.messages.length
    controller.abort(new Error('Stopped')); reply(0, 'abc')
    expect(await cancelled).toBe('Stopped')
    expect(port.messages).toHaveLength(count)
  } finally { f.restore() }
})
