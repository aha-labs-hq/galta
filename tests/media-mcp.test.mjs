import { test, expect } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvasMcpServer } from '../native/mcp/server'
import { CanvasRegistry } from '../native/bridge/registry'
import { MediaGeneration } from '../native/media/service'
import { mediaCapability } from '../native/media/capability'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { galtaToolContract } from '../packages/canvas/src/index'
import { KEY, PNG, providerFixture } from './helpers/media-fixture'

test('an embedded generation lands in its execution workspace, where canvas_place can commit it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galta-media-mcp-')), previous = process.env.GALTA_BRIDGE_DIRECTORY
  const bridges = join(root, 'bridges'), workspace = join(root, 'workspace')
  process.env.GALTA_BRIDGE_DIRECTORY = bridges
  await mkdir(bridges, { mode: 0o700 })
  const registry = new CanvasRegistry(async () => ({}), async () => workspace)
  registry.register({ id: 'canvas', projectId: 'project', title: 'Canvas' })
  const lease = await registry.connect('canvas', 'Galta', 'embedded')
  const bridgeId = crypto.randomUUID(), token = crypto.randomUUID()
  const bridge = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) { return request.headers.get('authorization') === `Bearer ${token}` && server.upgrade(request) ? undefined : new Response('Unauthorized', { status: 401 }) },
    websocket: { async message(ws, raw) {
      const request = JSON.parse(String(raw))
      try {
        if (request.method !== 'execution/workspace') throw new Error('Unexpected bridge request')
        ws.send(JSON.stringify({ id: request.id, result: registry.embeddedWorkspace(request.params.leaseId) }))
      } catch (error) { ws.send(JSON.stringify({ id: request.id, error: { message: error.message } })) }
    } }
  })
  const fixture = providerFixture(), generation = new MediaGeneration(join(root, 'media'), fixture.fetch)
  await generation.keys.connect(generation.providers.byteplus, KEY)
  const server = createCanvasMcpServer({ uiOwned: true, capabilities: [mediaCapability({ directory: join(root, 'media'), generation })] }), client = new Client({ name: 'Embedded UI', version: '1' })
  try {
    await writeFile(join(bridges, `${bridgeId}.json`), JSON.stringify({ version: 1, id: bridgeId, token, port: bridge.port, toolContract: await galtaToolContract() }), { mode: 0o600 })
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    const tools = (await client.listTools()).tools
    const media = tools.filter(tool => tool.name.startsWith('generat'))
    // BytePlus makes images and video, so speech is not offered.
    expect(media.map(tool => tool.name)).toEqual(['generation_models', 'generate_image', 'generate_video', 'generation_get', 'generation_list'])
    for (const tool of media) expect(tool.inputSchema.required).toContain('executionId')
    const unbound = await client.callTool({ name: 'generate_image', arguments: { prompt: 'A vessel', requestId: 'request-mcp-1' } })
    expect(unbound.isError).toBe(true)
    expect(fixture.count('POST', '/api/v3/images/generations')).toBe(0)

    const result = await client.callTool({ name: 'generate_image', arguments: { executionId: `${bridgeId}/${lease.id}`, prompt: 'A vessel', requestId: 'request-mcp-2' } })
    expect(result.isError).toBeUndefined()
    const [file] = result.structuredContent.files
    expect(file.path.startsWith(join(workspace, 'outputs', 'image-'))).toBe(true)
    expect(await readFile(file.path)).toEqual(PNG)
    // A file, not a picture: looking at it on the canvas is the cheaper default.
    expect(result.content.map(item => item.type)).toEqual(['text'])

    await registry.release(lease.id)
    const stale = await client.callTool({ name: 'generate_image', arguments: { executionId: `${bridgeId}/${lease.id}`, prompt: 'Another vessel', requestId: 'request-mcp-3' } })
    expect(stale.isError).toBe(true)
    expect(fixture.count('POST', '/api/v3/images/generations')).toBe(1)
  } finally {
    await client.close(); await server.close(); await registry.close(); bridge.stop(true); generation.close()
    if (previous === undefined) delete process.env.GALTA_BRIDGE_DIRECTORY; else process.env.GALTA_BRIDGE_DIRECTORY = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('generation costs no context until a provider is connected, and the tool list is re-announced when one is', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galta-media-list-')), directory = join(root, 'media')
  const fixture = providerFixture(), generation = new MediaGeneration(directory, fixture.fetch)
  const server = createCanvasMcpServer({ capabilities: [mediaCapability({ directory, generation })] }), client = new Client({ name: 'External agent', version: '1' })
  let changed = 0
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed++ })
  const names = async () => (await client.listTools()).tools.map(tool => tool.name).filter(name => name.startsWith('generat'))
  const announced = async (before) => { for (let i = 0; i < 60 && changed === before; i++) await Bun.sleep(50); return changed > before }
  try {
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    expect(await names()).toEqual([])
    let before = changed
    await generation.keys.connect(generation.providers.byteplus, KEY)
    expect(await announced(before)).toBe(true)
    expect(await names()).toEqual(['generation_models', 'generate_image', 'generate_video', 'generation_get', 'generation_list'])
    before = changed
    await generation.keys.connect(generation.providers.openrouter, KEY)
    expect(await announced(before)).toBe(true)
    expect(await names()).toContain('generate_speech')
    await generation.keys.disconnect('byteplus'); await generation.keys.disconnect('openrouter')
    expect(await names()).toEqual([])
  } finally {
    await client.close(); await server.close(); generation.close()
    await rm(root, { recursive: true, force: true })
  }
})
