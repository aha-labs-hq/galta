import { test, expect } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeClient, discoverBridges, openBridge } from '../native/mcp/client'
import { createCanvasMcpServer } from '../native/mcp/server'
import { galtaToolContract } from '../packages/canvas/src/contract'

/** A live bridge, as one browser's canvas bridge host would serve it. */
async function liveBridge(directory, toolContract, canvases = []) {
  const id = crypto.randomUUID(), token = crypto.randomUUID()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) { return request.headers.get('authorization') === `Bearer ${token}` && server.upgrade(request) ? undefined : new Response('Unauthorized', { status: 401 }) },
    websocket: { message(ws, raw) { const request = JSON.parse(String(raw)); ws.send(JSON.stringify({ id: request.id, result: request.method === 'list' ? canvases : {} })) } }
  })
  await writeFile(join(directory, `${id}.json`), JSON.stringify({ version: 1, id, token, port: server.port, toolContract }), { mode: 0o600 })
  return { id, stop: () => server.stop(true) }
}

for (const toolContract of [undefined, 'old-contract']) test(`a live bridge with ${toolContract} tools closes before any request`, async () => {
  let closed, messages = 0
  const disconnected = new Promise(resolve => { closed = resolve })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response('Upgrade required', { status: 400 }) },
    websocket: { message() { messages++ }, close() { closed() } }
  })
  try {
    await expect(BridgeClient.open({ version: 1, id: crypto.randomUUID(), token: crypto.randomUUID(), port: server.port, toolContract })).rejects.toThrow('incompatible tools')
    await disconnected
    expect(messages).toBe(0)
  } finally { server.stop(true) }
})

test('cancelling a connect whose reply is in transit cannot orphan its document lease', async () => {
  let leased = false, cancelSeen = false, connected, closed
  const acquired = new Promise(resolve => { connected = resolve })
  const released = new Promise(resolve => { closed = resolve })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response('Upgrade required', { status: 400 }) },
    websocket: {
      message(ws, raw) {
        const request = JSON.parse(String(raw))
        if (request.method === 'connect') {
          // The host has completed its connect; its reply has not arrived yet.
          // A cancellation now no longer has an in-flight host handler to abort.
          leased = true; connected()
        } else if (request.method === 'cancel') cancelSeen = true
      },
      close() { leased = false; closed() }
    }
  })
  const client = await BridgeClient.open({ version: 1, id: crypto.randomUUID(), token: crypto.randomUUID(), port: server.port, toolContract: await galtaToolContract() })
  try {
    const abort = new AbortController()
    const request = client.request('connect', { canvasId: 'canvas' }, abort.signal).catch(error => error.message)
    await acquired; abort.abort()
    expect(await request).toContain('cancelled')
    await released
    expect(cancelSeen).toBe(true)
    expect(leased).toBe(false)
  } finally { client.close(); server.stop(true) }
})

test('cancelling an observation preserves the connection for a fresh request', async () => {
  let observed, cancelled
  const entered = new Promise(resolve => { observed = resolve })
  const cancellation = new Promise(resolve => { cancelled = resolve })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response('Upgrade required', { status: 400 }) },
    websocket: { message(ws, raw) {
      const request = JSON.parse(String(raw))
      if (request.method === 'call') observed()
      else if (request.method === 'cancel') cancelled()
      else ws.send(JSON.stringify({ id: request.id, result: [] }))
    } }
  })
  const client = await BridgeClient.open({ version: 1, id: crypto.randomUUID(), token: crypto.randomUUID(), port: server.port, toolContract: await galtaToolContract() })
  try {
    const abort = new AbortController()
    const request = client.request('call', { tool: 'canvas_capture' }, abort.signal).catch(error => error.message)
    await entered; abort.abort()
    expect(await request).toContain('cancelled')
    await cancellation
    expect(await client.request('list')).toEqual([])
  } finally { client.close(); server.stop(true) }
})

test('a browser with other tools, or a bridge still writing its descriptor, hides no other canvas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galta-discovery-')), previous = process.env.GALTA_BRIDGE_DIRECTORY
  await chmod(directory, 0o700)
  process.env.GALTA_BRIDGE_DIRECTORY = directory
  const chrome = await liveBridge(directory, await galtaToolContract(), [{ id: 'canvas', title: 'Chrome canvas', agentActive: false }])
  const dia = await liveBridge(directory, 'old-contract', [{ id: 'canvas', title: 'Dia canvas', agentActive: false }])
  await writeFile(join(directory, `${crypto.randomUUID()}.json`), '', { mode: 0o600 })
  const server = createCanvasMcpServer({ capabilities: [] }), client = new Client({ name: 'External agent', version: '1' })
  try {
    const found = await discoverBridges()
    expect(found.bridges.map(bridge => bridge.id)).toEqual([chrome.id])
    expect(found.incompatible).toHaveLength(1)
    expect(found.incompatible[0]).toContain('incompatible tools')
    found.bridges.forEach(bridge => bridge.close())
    // A bound call opens only its own bridge.
    const own = await openBridge(chrome.id)
    expect(own?.id).toBe(chrome.id); own?.close()
    expect(await openBridge(crypto.randomUUID())).toBeUndefined()
    await expect(openBridge(dia.id)).rejects.toThrow('incompatible tools')

    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    const listed = await client.callTool({ name: 'canvas_list', arguments: {} })
    expect(listed.isError).toBeFalsy()
    expect(JSON.parse(listed.content[0].text)).toEqual([{ id: `${chrome.id}/canvas`, title: 'Chrome canvas', agentActive: false }])
    expect(listed.content[1].text).toStartWith('Canvases in one other Galta browser are not listed. ')
    expect(listed.content[1].text).toContain('reload the Galta extension')
    chrome.stop()
    // With only the incompatible browser left, its fix is the error.
    const only = await client.callTool({ name: 'canvas_list', arguments: {} })
    expect(only.isError).toBe(true)
    expect(only.content[0].text).toContain('incompatible tools')
  } finally {
    await client.close(); await server.close(); chrome.stop(); dia.stop()
    if (previous === undefined) delete process.env.GALTA_BRIDGE_DIRECTORY; else process.env.GALTA_BRIDGE_DIRECTORY = previous
    await rm(directory, { recursive: true, force: true })
  }
})
