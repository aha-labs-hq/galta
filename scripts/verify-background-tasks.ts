import { expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { storedWorkspace } from '../tests/helpers/stored-workspace'
import { installedExtension } from './lib/installed-extension'

const root = resolve(import.meta.dir, '..')
const installed = await installedExtension(root, { prefix: 'galta-background-tasks-', codexCommand: async ({ directory }) => {
  const host = join(directory, 'task-codex-host.js')
  const fixture = await Bun.build({ entrypoints: [join(root, 'tests/helpers/task-codex-host.ts')], target: 'bun' })
  if (!fixture.success) throw new Error(fixture.logs.map(String).join('\n'))
  await writeFile(host, await fixture.outputs[0]!.text())
  return [process.execPath, host, join(directory, 'fixture-port')]
} })
const { browser, worker, origin, directory: temporary, bridgeDirectory: directory } = installed
const client = new Client({ name: 'Background task acceptance', version: '1' })
try {
  await worker.evaluate(() => {
    const events: unknown[] = []; (globalThis as any).__taskAcceptancePorts = events
    chrome.runtime.onConnect.addListener(port => {
      events.push({ name: port.name, event: 'open' })
      port.onMessage.addListener(message => events.push({ name: port.name, event: 'message', method: message.method, id: message.id }))
      port.onDisconnect.addListener(() => events.push({ name: port.name, event: 'close' }))
    })
  })
  await worker.evaluate(() => chrome.storage.local.set({ 'galta.ai.enabled': true }))
  let page = await browser.newPage()
  const errors: string[] = []
  browser.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/canvas/index.html`)
  await expect.poll(async () => readFile(join(temporary, 'fixture-port'), 'utf8').catch(() => ''), { timeout: 15000 }).not.toBe('')
  const control = `http://127.0.0.1:${await readFile(join(temporary, 'fixture-port'), 'utf8')}`
  const fixture = async (action = '') => (await fetch(`${control}/${action}`)).json() as Promise<any>
  try { await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toBeEnabled({ timeout: 15000 }) }
  catch (error) { console.error({ evidence: temporary, fixture: JSON.stringify(await fixture()), ports: await worker.evaluate(() => (globalThis as any).__taskAcceptancePorts), errors }); throw error }
  const ready = async (stage: string) => {
    try { await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible() }
    catch (error) { console.error(JSON.stringify({ stage, evidence: temporary, ports: await worker.evaluate(() => (globalThis as any).__taskAcceptancePorts), page: await page.locator('body').innerText(), fixture: await fixture().catch(error => String(error)), codex: await readFile(join(temporary, 'codex.log'), 'utf8') }, null, 2)); throw error }
  }
  const start = async (text: string) => {
    await page.getByRole('textbox', { name: 'Ask Galta' }).fill(text)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    try { await expect.poll(async () => (await fixture()).active?.turn.status, { timeout: 15000 }).toBe('inProgress') }
    catch (error) { console.error({ evidence: temporary, instruction: text, ports: await worker.evaluate(() => (globalThis as any).__taskAcceptancePorts), contexts: await worker.evaluate(() => chrome.runtime.getContexts({})), page: await page.locator('body').innerText(), canvas: await readFile(join(temporary, 'canvas.log'), 'utf8'), fixture: JSON.stringify(await fixture().catch(error => String(error))), errors }); throw error }
  }
  await start('Keep working while this page is closed')
  await expect.poll(async () => worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length)).toBe(1)
  const executionId = (await fixture()).active.executionId
  await client.connect(new StdioClientTransport({ command: installed.mcp, env: { GALTA_BRIDGE_DIRECTORY: directory }, stderr: 'inherit' }))
  const tool = async (name: string, args = {}) => {
    const result = await client.callTool({ name, arguments: { executionId, ...args } })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    return result.content as any[]
  }
  const other = await browser.newPage(); await other.goto('about:blank'); await other.bringToFront()
  await page.close()
  expect((await fixture()).interrupts).toBe(0)
  const status = JSON.parse((await tool('canvas_inspect'))[0].text)
  const imagePath = join((await fixture()).active.cwd, 'outputs', 'background.png')
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8uoAAAAASUVORK5CYII=', 'base64'))
  const committed = JSON.parse((await tool('canvas_edit', { revision: status.revision, operations: [
    { type: 'create_text', text: 'Rendered with the canvas closed', x: 240, y: 260, props: { fontSize: 28, groupIds: ['background-card'] } },
    { type: 'create_element', elementType: 'image', id: 'background-image', x: 240, y: 330, props: { mediaPath: imagePath, width: 80, groupIds: ['background-card'] } }
  ] }))[0].text)
  expect(committed.elements.map((element: any) => element.change)).toEqual(['created', 'created'])
  const prepared = JSON.parse((await tool('canvas_extract', { ids: ['background-image'] }))[0].text)
  expect(await readFile(prepared.elements[0].file.path)).toEqual(await readFile(imagePath))
  const [preview, concurrentStatus] = await Promise.all([tool('canvas_capture', { scope: 'canvas' }), tool('canvas_inspect')])
  expect(JSON.parse(concurrentStatus[0].text).elements).toHaveLength(2)
  expect(preview.some(item => item.type === 'image' && item.data.length > 1000)).toBe(true)
  await fixture('ask')
  page = await browser.newPage(); await page.goto(`${origin}/canvas/index.html?project=default-project`)
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible()
  await expect(page.locator('.codex-question')).toContainText('fixture command')
  expect((await fixture()).interrupts).toBe(0)
  const paintedPixels = await page.evaluate(async data => {
    const image = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob())
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); image.close()
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let dark = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! < 100 && pixels[i + 3]! > 200) dark++
    return dark
  }, preview.find(item => item.type === 'image')!.data)
  expect(paintedPixels).toBeGreaterThan(100)
  await page.screenshot({ path: join(temporary, 'reattached.png') })
  await page.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect.poll(async () => (await fixture()).responses.some((response: any) => response.id === 'approval' && response.result?.decision === 'accept')).toBe(true)
  await fixture('ask')
  await expect(page.locator('.codex-question')).toBeVisible()
  const answered = (await fixture()).responses.length
  await fixture('resolve')
  await expect(page.locator('.codex-question')).toHaveCount(0)
  expect((await fixture()).responses).toHaveLength(answered)
  const actions = async () => {
    await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
    await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
  }
  await actions(); await page.getByRole('button', { name: 'Rename canvas', exact: true }).click()
  await page.getByRole('textbox', { name: 'Canvas name', exact: true }).fill('Task operation source')
  await page.getByRole('button', { name: 'Save canvas name', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toHaveCount(0)
  await actions(); const exported = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export canvas', exact: true }).click()
  const exportedPath = join(temporary, 'running-task.galta'); await (await exported).saveAs(exportedPath)
  await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toHaveCount(0)
  await actions(); await page.getByRole('button', { name: 'Archive canvas', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Stop it or let it finish before archiving.')
  expect((await storedWorkspace(page)).project.archivedAt).toBeUndefined()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toHaveCount(0)
  await actions(); await page.getByRole('button', { name: 'Duplicate canvas', exact: true }).click()
  await expect(page.locator('.galta-shell')).not.toHaveAttribute('data-project-id', 'default-project')
  await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toBeEnabled()
  const duplicateId = (await page.locator('.galta-shell').getAttribute('data-project-id'))!
  expect((await storedWorkspace(page, duplicateId)).agentSessions ?? []).toHaveLength(0)
  await page.getByLabel('Import canvas file', { exact: true }).setInputFiles(exportedPath)
  await expect(page.locator('.galta-shell')).not.toHaveAttribute('data-project-id', duplicateId)
  await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toBeEnabled()
  const importedId = (await page.locator('.galta-shell').getAttribute('data-project-id'))!
  const imported = await storedWorkspace(page, importedId)
  expect(imported.agentCheckpoints).toBeUndefined()
  expect(imported.agentSessions.every((session: any) => !session.threadId && session.turns.every((turn: any) => turn.status !== 'streaming'))).toBe(true)
  await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
  await page.getByRole('button', { name: 'Open Task operation source', exact: true }).and(page.locator('[data-project-id="default-project"]')).click()
  await expect(page.locator('.galta-shell')).toHaveAttribute('data-project-id', 'default-project')
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible()
  expect((await fixture()).interrupts).toBe(0)
  expect((await fixture()).active.executionId).toBe(executionId)
  await page.screenshot({ path: join(temporary, 'running-task-operations.png') })
  await fixture('ask')
  await expect(page.locator('.codex-question')).toBeVisible()
  await fixture('hold-interrupt')
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click()
  await expect.poll(async () => (await fixture()).interrupts).toBe(1)
  expect((await fixture()).active.turn.status).toBe('inProgress')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0)
  await fixture('finish-interrupt')
  await ready('explicit stop')
  expect((await fixture()).interrupts).toBe(1)
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions?.[0]?.turns.at(-1)?.items.find(item => item.id === 'interrupted-command')).toMatchObject({ status: 'failed', exitCode: 130, output: 'Stopped after cleanup' })
  const stopped = await client.callTool({ name: 'canvas_inspect', arguments: { executionId } })
  expect(stopped.isError).toBe(true)
  await start('Continue across project navigation')
  await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
  await page.getByRole('button', { name: 'New canvas', exact: true }).click()
  await expect(page.locator('.galta-shell')).not.toHaveAttribute('data-project-id', 'default-project')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect((await fixture()).interrupts).toBe(1)
  await fixture('finish')
  await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
  await page.getByRole('button', { name: 'Open Task operation source', exact: true }).and(page.locator('[data-project-id="default-project"]')).click()
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  await ready('project return')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Canvas zoom', exact: true }).click()
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await page.keyboard.press('Escape')
  await ready('mobile completion')
  await page.screenshot({ path: join(temporary, 'completed-mobile.png') })
  await start('Wait for the authoritative terminal failure')
  await fixture('fail')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0)
  await fixture('finish-failed')
  await ready('terminal failure')
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions?.[0]?.turns.at(-1)).toMatchObject({ status: 'failed', items: [{ type: 'error', text: 'Fixture terminal failure' }] })
  await start('Record an interrupted host without replaying work')
  const starts = (await fixture()).requests.filter((request: any) => request.method === 'turn/start' && request.params.additionalContext?.execution).length
  await worker.evaluate(() => chrome.offscreen.closeDocument())
  await page.bringToFront()
  await ready('host shutdown')
  try { await expect.poll(async () => (await storedWorkspace(page)).agentSessions?.[0]?.turns.at(-1)?.completedAt, { timeout: 20_000 }).toBeTruthy() }
  catch (error) {
    console.error(JSON.stringify({ stage: 'durable host recovery', evidence: temporary, visibility: await page.evaluate(() => document.visibilityState), contexts: await worker.evaluate(() => chrome.runtime.getContexts({})), workspace: await storedWorkspace(page), page: await page.locator('body').innerText() }, null, 2)); throw error
  }
  expect(['failed', 'stopped']).toContain((await storedWorkspace(page)).agentSessions![0]!.turns.at(-1)!.status)
  expect((await fixture()).requests.filter((request: any) => request.method === 'turn/start' && request.params.additionalContext?.execution)).toHaveLength(starts)
  await start('Run again only after a new explicit request')
  expect((await fixture()).requests.filter((request: any) => request.method === 'turn/start' && request.params.additionalContext?.execution)).toHaveLength(starts + 1)
  await fixture('finish'); await ready('explicit request after host recovery')
  await page.screenshot({ path: join(temporary, 'host-recovered.png') })
  expect(errors).toEqual([])
  const receipt = { evidence: temporary, build: await page.locator('.galta-shell').getAttribute('data-build'), installedHosts: installed.hashes, realOffscreen: true, realNativeCanvasBridge: true, provider: 'deterministic fixture; no paid inference', pageClosedDuringWrite: true, approvalReattached: true, serverResolvedPromptDismissed: true, stopWaitsForFinalReceipts: true, errorWaitsForCompletion: true, explicitStop: true, projectNavigation: true, canvasFileOperationsDuringTask: { rename: true, export: true, archiveBlocked: true, duplicateId, importedId, sourceExecutionPreserved: true }, hostShutdownWithoutReplay: true, explicitRequestWorksAfterHostRecovery: true, errors, passed: true }
  await writeFile(join(temporary, 'verification.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify(receipt, null, 2))
} finally { await client.close(); await browser.close() }
