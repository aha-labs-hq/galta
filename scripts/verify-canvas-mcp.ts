import { chromium, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, sep } from 'node:path'
import { nativeBrowser } from './lib/native-browser'
import { storedWorkspace as workspace } from '../tests/helpers/stored-workspace'
import { GALTA_MCP_INSTRUCTIONS, CANVAS_TOOLS } from '../packages/canvas/src/index'

const root = resolve(import.meta.dir, '..'), release = join(root, 'apps/extension/release')
const temporary = await mkdtemp(join(tmpdir(), 'galta-mcp-')), directory = join(temporary, 'bridges')
await mkdir(directory, { mode: 0o700 })
const environment = { GALTA_BRIDGE_DIRECTORY: directory, GALTA_WORKSPACE_DIRECTORY: join(temporary, 'workspaces') }
const transport = await nativeBrowser(root, environment)
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = resolve(release, '.' + decodeURIComponent(new URL(request.url).pathname))
  if (!path.startsWith(release + sep)) return new Response('Not found', { status: 404 })
  const file = Bun.file(path)
  return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 })
} })
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
const clients: Client[] = [], receipt: Record<string, unknown> = {}
const deadline = setTimeout(() => { void browser.close(); void transport.close() }, 240_000)
async function client(name: string) {
  const client = new Client({ name, version: '1' })
  await client.connect(new StdioClientTransport({ command: join(root, 'native/mcp/galta-mcp'), env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => entry[1] !== undefined)), ...environment }, stderr: 'inherit' }))
  clients.push(client)
  return client
}
function text(result: any) { return result.content.find((item: any) => item.type === 'text')?.text }
async function call(client: Client, name: string, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) throw new Error(text(result))
  return result
}

try {
  const page = await context.newPage()
  page.on('pageerror', error => transport.errors.push(error.message))
  await transport.attach(page)
  await page.goto(`http://127.0.0.1:${server.port}/sidepanel/index.html`)
  await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  await expect.poll(async () => (await readdir(directory)).length).toBe(1)
  await page.evaluate(() => { const url = new URL(location.href); url.hash = 'same-document'; history.replaceState(null, '', url) })
  const descriptor = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]!), 'utf8'))
  const endpoint = `http://127.0.0.1:${descriptor.port}/bridge`
  expect((await fetch(endpoint)).status).toBe(401)
  expect((await fetch(endpoint, { headers: { Authorization: `Bearer ${descriptor.token}`, Origin: 'https://example.test' } })).status).toBe(401)
  receipt.localAccessBoundary = true
  const primary = await client('MCP acceptance'), competitor = await client('Concurrent client')
  let canvases: any[] = []
  await expect.poll(async () => { canvases = JSON.parse(text(await call(primary, 'canvas_list'))); return canvases.length }).toBe(1)
  const canvasId = canvases[0].id
  receipt.sameDocumentNavigationPreservesConnection = true
  // Old MCP processes may remain alive across an extension update. Reject them
  // at the native boundary before they acquire a lease or dispatch a tool.
  const staleClient = new WebSocket(`ws://127.0.0.1:${descriptor.port}/bridge`, { headers: { Authorization: `Bearer ${descriptor.token}` } })
  try {
    await new Promise<void>((resolve, reject) => {
      staleClient.addEventListener('open', () => resolve(), { once: true })
      staleClient.addEventListener('error', () => reject(new Error('Contract probe could not connect')), { once: true })
    })
    for (const method of ['connect', 'call', 'execution/call']) for (const toolContract of [undefined, 'old-contract']) {
      const response = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Contract probe timed out')), 5000)
        staleClient.addEventListener('message', event => { clearTimeout(timeout); resolve(JSON.parse(String(event.data))) }, { once: true })
      })
      staleClient.send(JSON.stringify({ id: crypto.randomUUID(), method, params: { canvasId, tool: 'canvas_status', toolContract } }))
      expect((await response).error.message).toContain('incompatible tools')
    }
    receipt.staleToolContractsRejected = true
  } finally { staleClient.close() }
  const advertised = (await primary.listTools()).tools
  receipt.tools = advertised.map(tool => tool.name)
  expect(receipt.tools).toEqual(['browser_inspect', 'browser_capture', 'browser_act', 'canvas_list', 'canvas_connect', 'canvas_disconnect', 'canvas_inspect', 'canvas_capture', 'canvas_report', 'canvas_edit', 'canvas_place', 'canvas_reserve', 'canvas_extract', 'canvas_deliver'])
  expect(primary.getInstructions()).toBe(GALTA_MCP_INSTRUCTIONS)
  expect(primary.getInstructions()).not.toMatch(/Codex|seed-media|Keep all user-facing text in English/)
  for (const tool of CANVAS_TOOLS) expect(advertised.find(item => item.name === tool.name)?.description).toBe(tool.description)
  receipt.sharedCanvasContract = true
  const bound = JSON.parse(text(await call(primary, 'canvas_connect', { canvasId })))
  // External connections own their lease internally; returning a different ID
  // under that name would misdirect agents. Embedded calls are bound by MCP.
  expect(bound.executionId).toBeUndefined()
  expect(bound.canvasId).toBe(canvasId)
  await call(competitor, 'canvas_list')
  const refused = await competitor.callTool({ name: 'canvas_connect', arguments: { canvasId } })
  expect(refused.isError).toBe(true); expect(text(refused)).toContain('active agent')
  const status = JSON.parse(text(await call(primary, 'canvas_inspect')))
  const operations = Array.from({ length: 36 }, (_, i) => ({ type: 'create_text', id: `evidence-${i}`, x: 150 + i % 6 * 145, y: 100 + Math.floor(i / 6) * 75, text: `Evidence ${i + 1}`, props: { fontFamily: 2, fontSize: 18 } }))
  await call(primary, 'canvas_edit', { revision: status.revision, operations })
  const stale = await primary.callTool({ name: 'canvas_edit', arguments: { revision: status.revision, operations: [{ type: 'delete', elementId: 'evidence-0' }] } })
  expect(stale.isError).toBe(true)
  await expect(page.getByRole('region', { name: 'Galta canvas, 36 objects', exact: true })).toBeVisible()
  const firstPage = JSON.parse(text(await call(primary, 'canvas_inspect')))
  expect(firstPage.coverage).toEqual({ scope: 'canvas', total: 36, offset: 0, returned: 32, nextOffset: 32 })
  const lastPage = JSON.parse(text(await call(primary, 'canvas_inspect', firstPage.next)))
  expect(lastPage.coverage).toEqual({ scope: 'canvas', total: 36, offset: 32, returned: 4, nextOffset: null })
  expect(new Set([...firstPage.elements, ...lastPage.elements].map((el: any) => el.id)).size).toBe(36)
  const stalePage = await primary.callTool({ name: 'canvas_inspect', arguments: { offset: 32, revision: status.revision } })
  expect(stalePage.isError).toBe(true)
  receipt.pagedReads = { complete: true, staleRejected: true, sizes: [32, 4] }
  const found = JSON.parse(text(await call(primary, 'canvas_inspect', { query: 'EVIDENCE 3', kind: 'text' })))
  expect(found.elements.map((element: any) => element.id)).toEqual(['evidence-2', 'evidence-29', 'evidence-30', 'evidence-31', 'evidence-32', 'evidence-33', 'evidence-34', 'evidence-35'])
  expect(lastPage.next).toBeNull()
  const invalidLimit = await primary.callTool({ name: 'canvas_inspect', arguments: { limit: 100 } })
  expect(invalidLimit.isError).toBe(true); expect(text(invalidLimit)).toContain('returned next')
  const invalidTarget = await primary.callTool({ name: 'canvas_edit', arguments: { revision: firstPage.revision, operations: [
    { type: 'move', elementId: 'evidence-0', x: 0, y: 0 },
    { type: 'update_element', id: 'evidence-1', props: { text: 'Must not be applied' } }
  ] } })
  expect(invalidTarget.isError).toBe(true); expect(text(invalidTarget)).toContain('operations[1] (update_element): Missing elementId')
  expect(JSON.parse(text(await call(primary, 'canvas_inspect'))).revision).toBe(firstPage.revision)
  receipt.agentReadWriteContract = { search: true, reusableContinuation: true, targetedError: true, invalidBatchUnchanged: true }
  const view = await call(primary, 'canvas_capture', { scope: 'canvas', detail: 'high' })
  expect((view.content as any[]).some(item => item.type === 'image' && item.mimeType === 'image/jpeg' && item.data.length > 1000)).toBe(true)
  receipt.batch = { count: 36, staleRejected: true, imageBlocks: (view.content as any[]).filter(item => item.type === 'image').length }
  const first = await workspace(page)
  expect(first.snapshots[first.project.headCommitId].document.elements.length).toBe(36)
  expect(first.project.commits[first.project.headCommitId].runtime.providerId).toBe('mcp')

  // Exercise the actual artifact boundary in both directions.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8uoAAAAASUVORK5CYII=', 'base64')
  const imagePath = join(bound.workspace, 'outputs', `mcp-${crypto.randomUUID()}.png`)
  await writeFile(imagePath, png)
  const fresh = JSON.parse(text(await call(primary, 'canvas_inspect')))
  const placed = JSON.parse(text(await call(primary, 'canvas_place', { revision: fresh.revision, path: imagePath, x: 300, y: 600 })))
  receipt.placement = placed
  const all = JSON.parse(text(await call(primary, 'canvas_inspect', { detail: 'elements', ids: [placed.elementId] })))
  const image = all.elements.find((item: any) => item.type === 'image' || item.kind === 'image')
  if (!image) throw new Error(`No image in ${JSON.stringify(all).slice(0,1000)}`)
  const exported = JSON.parse(text(await call(primary, 'canvas_extract', { element: image.id, source: 'current' })))
  expect(await Bun.file(exported.path).bytes()).toEqual(new Uint8Array(png))
  const prepared = JSON.parse(text(await call(primary, 'canvas_extract', { ids: [image.id, 'evidence-0'] })))
  expect(prepared.elements[0].file.path).toBe(exported.path)
  expect(prepared.elements[1].file).toBeUndefined()
  const secondImagePath = join(bound.workspace, 'outputs', 'replacement.png')
  const replacement = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 2
    const context = canvas.getContext('2d')!; context.fillStyle = '#008866'; context.fillRect(0, 0, 4, 2)
    return canvas.toDataURL().split(',')[1]!
  })
  await writeFile(secondImagePath, Buffer.from(replacement, 'base64'))
  const beforeBatch = await workspace(page)
  const committed = JSON.parse(text(await call(primary, 'canvas_edit', { revision: prepared.revision, operations: [
    { type: 'update_element', elementId: image.id, props: { mediaPath: secondImagePath, groupIds: ['mcp-card'] } },
    { type: 'update_element', elementId: 'evidence-0', props: { text: 'Updated with its image', groupIds: ['mcp-card'] } }
  ] })))
  expect(committed.elements).toHaveLength(2)
  expect(committed.elements.every((element: any) => element.change === 'updated' && element.groupIds[0] === 'mcp-card')).toBe(true)
  expect(committed.elements.find((element: any) => element.id === image.id).generatedPath).toBe(secondImagePath)
  const members = JSON.parse(text(await call(primary, 'canvas_inspect', { groupId: 'mcp-card' })))
  expect(members.elements.map((element: any) => element.id).sort()).toEqual([image.id, 'evidence-0'].sort())
  const afterBatch = await workspace(page)
  expect(Object.keys(afterBatch.project.commits).length - Object.keys(beforeBatch.project.commits).length).toBe(1)
  const revised = JSON.parse(text(await call(primary, 'canvas_extract', { ids: [image.id], source: 'current' })))
  expect(revised.elements[0].file.path).not.toBe(exported.path)
  expect((await readFile(revised.elements[0].file.path)).toString('base64')).toBe(replacement)
  expect(await readFile(exported.path)).toEqual(png)
  const invalid = await primary.callTool({ name: 'canvas_edit', arguments: { revision: committed.revision, operations: [
    { type: 'update_element', elementId: 'evidence-0', props: { text: 'Must not commit' } },
    { type: 'update_element', elementId: image.id, props: { mediaPath: join(bound.workspace, 'outputs', 'missing.png') } }
  ] } })
  expect(invalid.isError).toBe(true)
  expect((await workspace(page)).project.headCommitId).toBe(afterBatch.project.headCommitId)
  receipt.mediaWorkflow = { sourcesReused: true, mixedBatchCommits: 1, changedElements: 2, originalPreserved: true, failedBatchPreserved: true }
  await rm(imagePath); await rm(exported.path)
  receipt.artifactRoundTrip = true

  const authored = 'A longer editable sentence that wraps inside a narrow card.'
  const beforeWrap = JSON.parse(text(await call(primary, 'canvas_inspect')))
  const wrapped = JSON.parse(text(await call(primary, 'canvas_edit', { revision: beforeWrap.revision, operations: [
    { type: 'create_element', id: 'search-card', elementType: 'rectangle', x: 100, y: 100, props: { width: 140, height: 200 } },
    { type: 'create_text', id: 'search-label', x: 150, y: 150, text: authored, props: { fontFamily: 2 } },
    { type: 'bind_text', elementId: 'search-label', containerId: 'search-card' }
  ] })))
  const authoredResult = JSON.parse(text(await call(primary, 'canvas_inspect', { query: authored, detail: 'elements' })))
  expect(authoredResult.elements.map((element: any) => element.id)).toEqual(['search-label'])
  expect(authoredResult.elements[0].text).toContain('\n')
  expect(authoredResult.elements[0].originalText).toBe(authored)
  const savedWrap = await workspace(page)
  expect(savedWrap.snapshots[savedWrap.project.headCommitId].document.elements.find((element: any) => element.id === 'search-label')?.originalText).toBe(authored)
  await call(primary, 'canvas_edit', { revision: wrapped.revision, operations: [
    { type: 'delete', elementId: 'search-label' }, { type: 'delete', elementId: 'search-card' }
  ] })
  receipt.authoredTextSearch = { acrossNativeSoftWraps: true, persistedSource: true }
  const secondPage = await context.newPage()
  await transport.attach(secondPage)
  await secondPage.goto(`http://127.0.0.1:${server.port}/sidepanel/index.html`)
  await expect(secondPage.getByRole('region', { name: 'Galta canvas, 37 objects', exact: true })).toBeVisible()
  let secondList: any[] = []
  // Rendering the second canvas precedes its native registration acknowledgement.
  await expect.poll(async () => { secondList = JSON.parse(text(await call(competitor, 'canvas_list'))); return secondList.length }).toBe(2)
  const other = secondList.find((canvas: any) => canvas.id !== canvasId)
  expect((await competitor.callTool({ name: 'canvas_connect', arguments: { canvasId: other.id } })).isError).toBe(true)
  await secondPage.close()

  // Hold the browser's actual persistence callback after its database commit.
  // The candidate is saved on a branch; Stop before application must preserve the active canvas.
  const beforeHeldSave = await workspace(page)
  await page.evaluate(commitCount => {
    const w = window as any, put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
      if (this.name !== 'workspaces' || Object.keys(value?.project?.commits ?? {}).length <= commitCount) return put.call(this, value, key!)
      IDBObjectStore.prototype.put = put
      const tx = this.transaction, complete = tx.oncomplete!
      tx.oncomplete = event => { w.__held = true; w.__release = () => complete.call(tx, event) }
      return put.call(this, value, key!)
    }
  }, Object.keys(beforeHeldSave.project.commits).length)
  const beforeCancel = JSON.parse(text(await call(primary, 'canvas_inspect')))
  const pending = primary.callTool({ name: 'canvas_edit', arguments: { revision: beforeCancel.revision, operations: [{ type: 'create_text', text: 'Must not apply', x: 0, y: 0 }] } })
  await page.waitForFunction(() => (window as any).__held)
  await page.getByRole('button', { name: 'Stop agent', exact: true }).click()
  await page.evaluate(() => (window as any).__release())
  expect((await pending).isError).toBe(true)
  await expect(page.getByRole('region', { name: 'Galta canvas, 37 objects', exact: true })).toBeVisible()
  const cancelled = await workspace(page)
  expect(cancelled.snapshots[cancelled.project.headCommitId].document.elements.some((element: any) => element.text === 'Must not apply')).toBe(false)
  receipt.stopBeforeApply = true
  receipt.multipleSurfaces = true
  await call(primary, 'canvas_disconnect')
  await page.reload()
  await expect(page.getByRole('region', { name: 'Galta canvas, 37 objects', exact: true })).toBeVisible()
  await expect.poll(async () => { canvases = JSON.parse(text(await call(primary, 'canvas_list'))); return canvases.length }).toBe(1)
  await call(primary, 'canvas_connect', { canvasId: canvases[0].id })
  await primary.close()
  await expect(page.getByRole('button', { name: 'Stop agent', exact: true })).toHaveCount(0)
  await expect.poll(async () => JSON.parse(text(await call(competitor, 'canvas_list')))[0]?.busy).toBe(false)
  receipt.reloadAndDisconnect = true
  expect(transport.hosts.every(name => name === 'com.galta.canvas')).toBe(true)
  receipt.hosts = transport.hosts
  receipt.codexStarted = false
  await page.screenshot({ path: join(temporary, 'canvas.png') })
  expect(transport.errors).toEqual([])
  receipt.passed = true
  await writeFile(join(temporary, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ evidence: temporary, ...receipt }, null, 2))
} finally {
  clearTimeout(deadline)
  await Promise.allSettled(clients.map(client => client.close()))
  await browser.close(); await transport.close(); server.stop(true)
}
