import { test, expect } from 'bun:test'
import { nativePort } from '../scripts/web/nativePort'
import { runtimePort } from '../apps/extension/src/shared/runtimePort'

test('the web native relay reassembles fragmented native replies and detects peer exit', async () => {
  const source = `let input = Buffer.alloc(0); for await (const chunk of Bun.stdin.stream()) { input = Buffer.concat([input, chunk]); if(input.length < 4 || input.length < input.readUInt32LE() + 4) continue; const message = JSON.parse(input.subarray(4).toString()); const body = Buffer.from(JSON.stringify({echo: message})); const header = Buffer.alloc(4); header.writeUInt32LE(body.length); process.stdout.write(header.subarray(0, 2)); await Bun.sleep(5); process.stdout.write(Buffer.concat([header.subarray(2), body])); break; }`
  const port = nativePort([process.execPath, '-e', source], process.env)
  const reply = new Promise(resolve => port.onMessage.addListener(resolve))
  const closed = new Promise(resolve => port.onDisconnect.addListener(resolve))
  port.postMessage({ id: 'request', text: '指向这段文字' })
  expect(await reply).toEqual({ echo: { id: 'request', text: '指向这段文字' } })
  await closed
  expect(() => port.postMessage({ id: 'late' })).toThrow('closed')
})

test('closing a browser port prevents late speech replies and ends its native invocation once', () => {
  let closes = 0, replies = 0
  const channel = runtimePort('speech', () => {}, () => closes++)
  channel.port.onMessage.addListener(() => replies++)
  channel.port.disconnect(); channel.port.disconnect()
  channel.receive({ ok: true }); channel.ended()
  expect(closes).toBe(1); expect(replies).toBe(0)
})

test('a disconnected web tab removes its task executor and releases ownership for another tab', async () => {
  const { startWebHost } = await import('../apps/extension/src/web/host')
  const { hostRuntime, installWebRuntime } = await import('../apps/extension/src/shared/hostRuntime')
  const names = ['WebSocket', 'fetch', 'BroadcastChannel', 'navigator', 'window', 'document']
  const originals = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  let socket, channel, executor, ownership, removed = false
  class Socket {
    static OPEN = 1
    readyState = 1
    constructor() { socket = this; queueMicrotask(() => this.onopen?.()) }
    send() {}
    close() { this.readyState = 3; this.onclose?.() }
  }
  class Channel extends EventTarget {
    closed = false
    constructor() { super(); channel = this }
    postMessage(data) { if (this.closed) throw new Error('closed'); if (data === 'ready') this.dispatchEvent(new MessageEvent('message', { data })) }
    close() { this.closed = true }
  }
  const globals = {
    WebSocket: Socket, BroadcastChannel: Channel,
    fetch: async () => ({ ok: true, json: async () => ({ endpoint: 'ws://fixture/runtime', token: 'fixture' }) }),
    window: new EventTarget(),
    document: { createElement: () => ({ remove() { removed = true } }), body: { append(value) { executor = value } } },
    navigator: { locks: { request(_name, _options, callback) { return ownership = callback() } } }
  }
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: globals[name] })
    await startWebHost()
    const runtime = hostRuntime(), ready = runtime.sendMessage({ type: 'task-host-ensure' })
    expect(executor.src).toBe('/tasks/index.html')
    runtime.connect({ name: 'galta-task-host' })
    await ready
    const pending = runtime.sendMessage({ type: 'codex-connect' }).catch(error => error)
    socket.close()
    await ownership
    expect(removed).toBe(true)
    expect(channel.closed).toBe(true)
    expect((await pending).message).toContain('Reload to reconnect')
  } finally {
    installWebRuntime(undefined)
    for (const [name, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]
  }
})
