// Opt-in, paid model acceptance. This uses a real installed extension and native
// Codex/MCP hosts in an isolated profile; Codex owns authentication and threads.
import { expect, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { installedExtension } from './lib/installed-extension'
import { storedWorkspace } from '../tests/helpers/stored-workspace'

const installed = await installedExtension(resolve(import.meta.dir, '..'), { prefix: 'galta-live-canvas-operations-' })
const { browser, worker, origin, directory } = installed
const receipt: Record<string, unknown> = { evidence: directory, provider: 'real Codex app-server and model', installedHosts: installed.hashes }
const errors: string[] = []
let stage = 'connect'
let observedPage: Page | undefined
const deadline = setTimeout(() => { console.error(JSON.stringify({ stage, evidence: directory, error: 'Live acceptance deadline reached' })); void browser.close() }, 240_000)
try {
  await worker.evaluate(() => chrome.storage.local.set({ 'galta.ai.enabled': true }))
  const page = observedPage = await browser.newPage(); page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/canvas/index.html`)
  await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toBeEnabled({ timeout: 30_000 })
  const initial = await storedWorkspace(page), model = process.env.GALTA_VERIFY_MODEL ?? initial.runtimeDefaults.modelId
  const connection = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'codex-connect' }))
  if (!connection.ok || connection.requiresAuth) throw new Error('The real Codex connection is not authenticated')
  const selected = connection.models.find((item: any) => item.id === model)
  if (!selected?.supportedReasoningEfforts?.some((item: any) => item.reasoningEffort === 'low')) throw new Error(`Requested model/low effort is unavailable: ${model}`)
  await page.getByRole('button', { name: /^Model / }).click()
  await page.getByRole('radiogroup', { name: 'Model', exact: true }).getByText(selected.displayName ?? selected.id, { exact: true }).click()
  await page.getByRole('button', { name: /^Effort / }).click()
  await page.getByRole('menuitemradio', { name: 'Low', exact: true }).click()
  await expect(page.getByRole('menu', { name: 'Effort', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Model settings', exact: true })).toHaveCount(0)
  const actions = async () => {
    await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
    await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
  }
  await actions(); await page.getByRole('button', { name: 'Rename canvas', exact: true }).click()
  await page.getByRole('textbox', { name: 'Canvas name', exact: true }).fill('Live task source')
  await page.getByRole('button', { name: 'Save canvas name', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toHaveCount(0)
  stage = 'start real task'; console.log(JSON.stringify({ stage, model, evidence: directory }))
  const instruction = 'Use Galta canvas_edit to create exactly one text object saying Canvas operation acceptance at x=240 y=240, then canvas_inspect to verify it. After that, run the shell command sleep 90 and wait for it. Do nothing else before that command completes. This is an isolated acceptance canvas; do not change any other files or canvas.'
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill(instruction)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible({ timeout: 120_000 })
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions?.some((session: any) => session.turns.some((turn: any) => turn.items.some((item: any) => item.type === 'commandExecution' && /sleep\s+90/.test(item.text ?? '') && ['inProgress', 'running'].includes(item.status)))), { timeout: 90_000 }).toBe(true)
  const running = await storedWorkspace(page), sessionId = running.runtimeDefaults.sessionId
  const session = (bundle: any) => bundle.agentSessions.find((item: any) => item.id === sessionId)
  receipt.model = model; receipt.threadId = session(running).threadId; receipt.build = await page.locator('.galta-shell').getAttribute('data-build')
  receipt.offscreenContexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] }))
  stage = 'file operations during real task'; console.log(JSON.stringify({ stage, evidence: directory }))
  await actions(); const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export canvas', exact: true }).click()
  const path = join(directory, 'running.galta'); await (await download).saveAs(path)
  await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toHaveCount(0)
  await actions(); await page.getByRole('button', { name: 'Archive canvas', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Stop it or let it finish before archiving.')
  expect((await storedWorkspace(page)).project.archivedAt).toBeUndefined()
  await page.screenshot({ path: join(directory, 'archive-protected.png') })
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toHaveCount(0)
  await actions(); await page.getByRole('button', { name: 'Duplicate canvas', exact: true }).click()
  await expect(page.locator('.galta-shell')).not.toHaveAttribute('data-project-id', 'default-project')
  await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toBeEnabled()
  const duplicateId = (await page.locator('.galta-shell').getAttribute('data-project-id'))!
  expect((await storedWorkspace(page, duplicateId)).agentSessions ?? []).toHaveLength(0)
  await page.getByLabel('Import canvas file', { exact: true }).setInputFiles(path)
  await expect(page.locator('.galta-shell')).not.toHaveAttribute('data-project-id', duplicateId)
  await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toBeEnabled()
  const importedId = (await page.locator('.galta-shell').getAttribute('data-project-id'))!
  const imported = await storedWorkspace(page, importedId)
  expect(imported.agentCheckpoints).toBeUndefined(); expect(imported.codexProject).toBeUndefined()
  expect(imported.agentSessions.every((item: any) => !item.threadId && item.turns.every((turn: any) => turn.status !== 'streaming'))).toBe(true)
  await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
  await page.locator('.workspace-canvas-item[data-project-id="default-project"]').click()
  await expect(page.locator('.galta-shell')).toHaveAttribute('data-project-id', 'default-project')
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible()
  expect(session(await storedWorkspace(page)).turns.at(-1).status).toBe('streaming')
  await page.screenshot({ path: join(directory, 'running-after-operations.png') })
  stage = 'explicit stop and durable recovery'; console.log(JSON.stringify({ stage, evidence: directory }))
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click()
  await expect.poll(async () => session(await storedWorkspace(page)).turns.at(-1).status, { timeout: 30_000 }).toBe('stopped')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  const stopped = await storedWorkspace(page)
  expect(stopped.snapshots[stopped.project.headCommitId].document.elements[0].text).toBe('Canvas operation acceptance')
  expect(session(stopped).turns.at(-1).status).toBe('stopped')
  await actions(); await page.getByRole('button', { name: 'Archive canvas', exact: true }).click()
  await expect(page.locator('.galta-shell')).not.toHaveAttribute('data-project-id', 'default-project')
  await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toBeEnabled()
  await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
  await page.getByRole('button', { name: 'Archived', exact: true }).click()
  await page.locator('.workspace-canvas-item[data-project-id="default-project"]').click()
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  expect(errors).toEqual([])
  receipt.checks = { exportDuringTask: true, archiveProtected: true, duplicateId, importedId, sourceTaskContinued: true, explicitStop: true, reloadPreservesArtworkAndTerminalConversation: true, archiveAndRestoreAfterStop: true }
  receipt.exportSchema = JSON.parse(await readFile(path, 'utf8')).schemaVersion
  receipt.errors = errors; receipt.passed = true
  await page.screenshot({ path: join(directory, 'restored-after-stop.png') })
  await writeFile(join(directory, 'verification.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2))
} catch (error) {
  receipt.stage = stage; receipt.passed = false; receipt.error = String(error)
  if (observedPage && !observedPage.isClosed()) {
    await observedPage.screenshot({ path: join(directory, 'failed.png') }).catch(() => undefined)
    receipt.conversations = (await storedWorkspace(observedPage).catch(() => null))?.agentSessions
  }
  await writeFile(join(directory, 'verification.json'), JSON.stringify(receipt, null, 2)); throw error
} finally { clearTimeout(deadline); await browser.close() }
