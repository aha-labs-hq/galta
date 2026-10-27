import { test, expect } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvasMcpServer } from '../native/mcp/server'
import { CanvasRegistry } from '../native/bridge/registry'
import { CANVAS_TOOLS, BROWSER_TOOLS, GALTA_MCP_INSTRUCTIONS, galtaToolContract } from '../packages/canvas/src/index'
import { MEDIA_TOOLS, isMediaTool } from '../packages/canvas/src/capabilities/media'

test('one MCP serves canvas and browser tools on a UI lease, preserves pixels, and fences stale calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galta-mcp-execution-'))
  const previous = process.env.GALTA_BRIDGE_DIRECTORY
  process.env.GALTA_BRIDGE_DIRECTORY = directory
  const bridgeId = crypto.randomUUID(), token = crypto.randomUUID(), calls = []
  let hold
  const pixels = { type: 'image', data: 'dGVzdA==', mimeType: 'image/jpeg' }
  const registry = new CanvasRegistry(async (_, method, params) => {
    if (method !== 'call') return {}
    calls.push(params)
    if (hold) { hold.entered(); await hold.finished }
    const structured = {
      canvas_inspect: { revision: 'r', coverage: { scope: 'canvas', total: 0, offset: 0, returned: 0, nextOffset: null }, next: null, elements: [], evidence: { id: 'evidence-inspect', type: 'structure', revision: 'r', scope: 'canvas', elementIds: [], totalElementCount: 0, coveredElementCount: 0, complete: true, capabilities: ['identity', 'bounds'], limitations: [], detail: 'summary' } },
      canvas_capture: { revision: 'r', scope: 'canvas', elementIds: [], elementCount: 0, complete: true, unrenderedElementIds: [], evidence: { id: 'evidence-capture', type: 'pixels', revision: 'r', scope: 'canvas', elementIds: [], totalElementCount: 0, coveredElementCount: 0, complete: true, capabilities: ['identity', 'pixels'], limitations: [], detail: 'low', focus: 'canvas', mimeType: 'image/jpeg', sha256: '0000000000000000000000000000000000000000000000000000000000000000' } },
      browser_inspect: { documentId: 'doc', url: 'https://example.test', title: 'Example', snapshotId: 's', text: '', elements: [], truncated: false },
      browser_capture: { source: 'webpage', documentId: 'doc', url: 'https://example.test', title: 'Example', viewport: {} },
      browser_act: { dispatched: 'scroll', verification: 'Inspect or capture again.' },
      canvas_edit: { revision: 'r', elementCount: 0, elements: [], deletedIds: [] },
      canvas_place: { placed: true, action: 'created', kind: 'image', elementId: 'e', revision: 'r', element: {} },
      canvas_extract: { path: '/workspace/sources/a.png', artifactUri: 'galta-workspace:/sources/a.png', kind: 'image', mimeType: 'image/png', source: 'element', width: 1, height: 1 },
      canvas_deliver: { path: '/workspace/selected.png', artifactUri: 'galta-workspace:/selected.png', sourceArtifactUri: 'galta-workspace:/sources/a.png', name: 'selected.png', mimeType: 'image/png', size: 4, sha256: '0000000000000000000000000000000000000000000000000000000000000000', version: 'version' }
    }[params.tool]
    return { content: [{ type: 'text', text: JSON.stringify({ tool: params.tool }) }, ...(params.tool.endsWith('_capture') ? [pixels] : [])], structuredContent: structured }
  }, async () => '/workspace')
  registry.register({ id: 'canvas', projectId: 'project', title: 'Canvas' })
  const lease = await registry.connect('canvas', 'Galta', 'embedded')
  const bridge = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response('Unauthorized', { status: 401 })
      return server.upgrade(request) ? undefined : new Response('Upgrade required', { status: 400 })
    },
    websocket: { async message(ws, raw) {
      const request = JSON.parse(String(raw))
      try {
        const p = request.params
        const result = request.method === 'list' ? registry.list()
          : request.method === 'execution/active' ? registry.embeddedLeases()
          : await registry.boundCall(p.leaseId, p.tool, p.args)
        ws.send(JSON.stringify({ id: request.id, result }))
      } catch (error) { ws.send(JSON.stringify({ id: request.id, error: { message: error.message } })) }
    } }
  })
  // A connected capability is advertised exactly as its contract; one that cannot read its state lists nothing and hides nothing else.
  const connected = { tools: async () => MEDIA_TOOLS, owns: isMediaTool, writesFiles: () => false, call: async () => { throw new Error('unused') }, watch: () => () => {} }
  const unreadable = { tools: async () => { throw new Error('unreadable') }, owns: () => false, writesFiles: () => false, call: async () => { throw new Error('unused') }, watch: () => () => {} }
  const server = createCanvasMcpServer({ capabilities: [connected, unreadable] }), client = new Client({ name: 'Independent MCP client', version: '1' })
  try {
    await writeFile(join(directory, `${bridgeId}.json`), JSON.stringify({ version: 1, id: bridgeId, token, port: bridge.port, toolContract: await galtaToolContract() }), { mode: 0o600 })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport); await client.connect(clientTransport)
    const advertised = (await client.listTools()).tools
    expect(advertised).toHaveLength(14 + MEDIA_TOOLS.length)
    expect(client.getInstructions()).not.toMatch(/Codex|galta_browser/)
    expect(client.getInstructions()).toBe(GALTA_MCP_INSTRUCTIONS)
    // Discovery may show only 512 characters: the whole first paragraph fits.
    expect(client.getInstructions().split('\n\n')[0].length).toBeLessThanOrEqual(512)
    const preview = client.getInstructions().slice(0, 512)
    expect(preview).toContain('executionId')
    expect(preview).toContain('canvas_edit')
    expect(preview).toContain('groupIds')
    for (const tool of [...CANVAS_TOOLS, ...BROWSER_TOOLS, ...MEDIA_TOOLS]) {
      const actual = advertised.find(item => item.name === tool.name)
      expect(actual.inputSchema).toEqual(tool.inputSchema)
      expect(actual.annotations).toEqual(tool.annotations)
      expect(actual).not.toHaveProperty('execution')
    }
    const executionId = `${bridgeId}/${lease.id}`
    for (const name of ['canvas_inspect', 'canvas_capture', 'browser_inspect', 'browser_capture']) {
      const result = await client.callTool({ name, arguments: { executionId } })
      expect(result.isError).not.toBe(true)
      if (name.endsWith('_capture')) expect(result.content[1]).toEqual(pixels)
    }
    const edited = await client.callTool({ name: 'canvas_edit', arguments: { executionId, revision: 'r', operations: [{ type: 'create_text', text: 'MCP', x: 0, y: 0 }] } })
    expect(edited.isError).not.toBe(true)
    const delivered = await client.callTool({ name: 'canvas_deliver', arguments: { executionId, source: 'galta-workspace:/sources/a.png', destination: 'selected.png' } })
    expect(delivered.isError).not.toBe(true)
    const operations = Array.from({ length: 120 }, (_, i) => ({ type: 'create_text', text: `Item ${i}`, x: i, y: 0 }))
    expect(advertised.find(tool => tool.name === 'canvas_edit').inputSchema.properties.operations.maxItems).toBeUndefined()
    expect((await client.callTool({ name: 'canvas_edit', arguments: { executionId, revision: 'r', operations } })).isError).not.toBe(true)
    expect(calls.at(-1).args.operations).toEqual(operations)
    let enter, finish
    const entered = new Promise(resolve => { enter = resolve })
    hold = { entered: enter, finished: new Promise(resolve => { finish = resolve }) }
    const inFlight = client.callTool({ name: 'canvas_inspect', arguments: { executionId } })
    await entered
    try {
      const mixed = await client.callTool({ name: 'canvas_list', arguments: {} })
      expect(mixed.isError).toBe(true)
      expect(mixed.content[0].text).toContain('UI-owned tool calls')
    } finally { hold = undefined; finish(); await inFlight }
    expect((await client.callTool({ name: 'canvas_list', arguments: {} })).isError).not.toBe(true)
    expect(calls.every(call => call.leaseId === lease.id && call.args.executionId === undefined)).toBe(true)
    const count = calls.length
    expect((await client.callTool({ name: 'canvas_edit', arguments: { executionId, operations: [] } })).isError).toBe(true)
    expect((await client.callTool({ name: 'canvas_inspect', arguments: {} })).isError).toBe(true)
    expect((await client.callTool({ name: 'canvas_inspect', arguments: { executionId: 'invalid' } })).isError).toBe(true)
    expect(calls).toHaveLength(count)
    await registry.release(lease.id)
    expect((await client.callTool({ name: 'canvas_inspect', arguments: { executionId } })).isError).toBe(true)
    expect(calls).toHaveLength(count)
    const other = await registry.connect('canvas', 'External client')
    expect((await client.callTool({ name: 'canvas_inspect', arguments: { executionId: `${bridgeId}/${other.id}` } })).isError).toBe(true)
    expect(calls).toHaveLength(count)
  } finally {
    await client.close(); await server.close(); await registry.close(); bridge.stop(true)
    if (previous === undefined) delete process.env.GALTA_BRIDGE_DIRECTORY
    else process.env.GALTA_BRIDGE_DIRECTORY = previous
    await rm(directory, { recursive: true, force: true })
  }
})
