import { test, expect } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvasMcpServer } from '../native/mcp/server'
import { CanvasRegistry } from '../native/bridge/registry'
import { galtaToolContract } from '../packages/canvas/src/contract'

test('embedded MCP routes concurrent UI leases explicitly and cannot borrow another execution after release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galta-ui-routing-')), previous = process.env.GALTA_BRIDGE_DIRECTORY
  process.env.GALTA_BRIDGE_DIRECTORY = directory
  const bridgeId = crypto.randomUUID(), token = crypto.randomUUID(), calls = []
  const registry = new CanvasRegistry(async (canvasId, method, params) => {
    if (method !== 'call') return {}
    calls.push({ canvasId, ...params })
    const result = { revision: canvasId, elementCount: 0, elements: [], deletedIds: [] }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
  }, async () => '/workspace')
  for (const id of ['first', 'second']) registry.register({ id, projectId: id, title: id })
  const first = await registry.connect('first', 'Galta', 'embedded'), second = await registry.connect('second', 'Galta', 'embedded')
  const bridge = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response('Unauthorized', { status: 401 })
      return server.upgrade(request) ? undefined : new Response('Upgrade required', { status: 400 })
    }, websocket: { async message(ws, raw) {
      const request = JSON.parse(String(raw)), p = request.params
      try {
        const result = request.method === 'execution/active' ? registry.embeddedLeases() : await registry.boundCall(p.leaseId, p.tool, p.args)
        ws.send(JSON.stringify({ id: request.id, result }))
      } catch (error) { ws.send(JSON.stringify({ id: request.id, error: { message: error.message } })) }
    } }
  })
  const server = createCanvasMcpServer({ uiOwned: true, capabilities: [] }), client = new Client({ name: 'Embedded UI', version: '1' })
  let other
  try {
    await writeFile(join(directory, `${bridgeId}.json`), JSON.stringify({ version: 1, id: bridgeId, token, port: bridge.port, toolContract: await galtaToolContract() }), { mode: 0o600 })
    // Another browser that has not reloaded Galta since an update is live too.
    const otherId = crypto.randomUUID(), otherToken = crypto.randomUUID()
    other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request, server) { return server.upgrade(request) ? undefined : new Response('Upgrade required', { status: 400 }) }, websocket: { message() {} } })
    await writeFile(join(directory, `${otherId}.json`), JSON.stringify({ version: 1, id: otherId, token: otherToken, port: other.port, toolContract: 'old-contract' }), { mode: 0o600 })
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    const tools = (await client.listTools()).tools
    expect(tools).toHaveLength(11)
    expect(tools.every(tool => tool.inputSchema.required.includes('executionId'))).toBe(true)
    const args = { revision: 'r', operations: [{ type: 'create_text', text: 'Scoped', x: 0, y: 0 }] }
    const results = await Promise.all([first, second].map(lease => client.callTool({ name: 'canvas_edit', arguments: { ...args, executionId: `${bridgeId}/${lease.id}` } })))
    expect(results.map(result => result.structuredContent.revision)).toEqual(['first', 'second'])
    expect(calls.map(call => call.canvasId).sort()).toEqual(['first', 'second'])
    expect(calls.every(call => call.args.executionId === undefined)).toBe(true)
    await registry.release(first.id)
    // Only the other execution is now discoverable. Missing or stale binding
    // must fail, rather than applying this caller's write to that canvas.
    for (const arguments_ of [args, { ...args, executionId: `${bridgeId}/${first.id}` }]) {
      expect((await client.callTool({ name: 'canvas_edit', arguments: arguments_ })).isError).toBe(true)
    }
    expect(calls).toHaveLength(2)
    expect((await client.callTool({ name: 'canvas_connect', arguments: { canvasId: `${bridgeId}/second` } })).isError).toBe(true)
    expect(registry.embeddedLeases()).toHaveLength(1)
  } finally {
    await client.close(); await server.close(); await registry.close(); bridge.stop(true); other?.stop(true)
    if (previous === undefined) delete process.env.GALTA_BRIDGE_DIRECTORY; else process.env.GALTA_BRIDGE_DIRECTORY = previous
    await rm(directory, { recursive: true, force: true })
  }
})
