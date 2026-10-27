import { test, expect } from 'bun:test'
import { ExtensionCodexRpc } from '../apps/extension/src/canvas/codexRpc.ts'

test('a lost sidebar port reports its actual failure and explicit reconnect replaces it', async () => {
  const previous = globalThis.chrome, ports = [], updates = []
  let error, errorReads = 0
  globalThis.chrome = { runtime: {
    get lastError() { errorReads++; return error },
    onMessage: { addListener() {}, removeListener() {} },
    connect() {
      const listeners = []
      const port = { onDisconnect: { addListener: fn => listeners.push(fn) },
        disconnect() { listeners.forEach(fn => fn()) },
        fail(message) { error = { message }; listeners.forEach(fn => fn()); error = undefined }
      }
      ports.push(port); return port
    },
    sendMessage: async () => ({ ok: true, models: [] })
  } }
  try {
    const client = new ExtensionCodexRpc(), off = client.subscribe(update => updates.push(update))
    ports[0].fail('Could not establish connection. Receiving end does not exist.')
    expect(errorReads).toBeGreaterThan(0)
    expect(updates).toEqual([{ method: 'galta/connection-lost', params: { message: 'Could not establish connection. Receiving end does not exist.' } }])
    expect(ports).toHaveLength(1) // No automatic retry.
    expect(await client.connect()).toMatchObject({ ok: true })
    expect(ports).toHaveLength(2)
    ports[0].fail('Late old disconnect')
    expect(updates).toHaveLength(1)
    off()
    expect(updates).toHaveLength(1) // Intentional disposal is not a failure.
  } finally { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous }
})

test('reopening a canvas releases its Codex listener and connection failures return visibly', async () => {
  const previous = globalThis.chrome
  const listeners = new Set()
  globalThis.chrome = { runtime: {
    onMessage: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
    sendMessage: async () => { throw new Error('Extension context invalidated') }
  } }
  try {
    const discarded = new ExtensionCodexRpc()
    expect(listeners.size).toBe(0)
    const client = new ExtensionCodexRpc()
    let received = 0
    const off = client.subscribe(() => received++)
    const offSecond = client.subscribe(() => received++)
    expect(listeners.size).toBe(1)
    for (const listener of listeners) listener({ type: 'codex-notification', notification: { method: 'account/updated' } })
    expect(received).toBe(2)
    off(); offSecond()
    expect(listeners.size).toBe(0)
    const reopened = discarded.subscribe(() => {})
    expect(listeners.size).toBe(1)
    reopened()
    expect(await client.connect()).toEqual({ ok: false, error: 'Extension context invalidated' })
    expect(await client.login()).toEqual({ ok: false, error: 'Extension context invalidated' })
  } finally {
    if (previous === undefined) delete globalThis.chrome
    else globalThis.chrome = previous
  }
})
