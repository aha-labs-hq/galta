import { installReturningAccount } from '../helpers/canvas-port'
import { storedWorkspaces, seedWorkspace } from '../helpers/stored-workspace'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { test, expect, type Page } from '@playwright/test'

test.beforeEach(async ({ context }) => { await installReturningAccount(context) })

const url = `${acceptanceOrigin}/sidepanel/index.html`
async function ready(page: Page) { await expect(page.locator('.conversation-composer textarea')).toBeEnabled(); await expect(page.locator('.excalidraw')).toBeVisible() }
async function menu(page: Page) { await page.getByRole('button', { name: 'Canvas menu', exact: true }).click() }
async function actions(page: Page) { await menu(page); await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click() }
async function rename(page: Page, title: string) {
  await actions(page); await page.getByRole('button', { name: 'Rename canvas', exact: true }).click()
  await page.getByRole('textbox', { name: 'Canvas name', exact: true }).fill(title)
  await page.getByRole('button', { name: 'Save canvas name', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Canvas menu', exact: true })).toContainText(title)
  await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toHaveCount(0)
}
async function project(page: Page) { return page.locator('.galta-shell').getAttribute('data-project-id') }
const bundles = storedWorkspaces

test('independent canvases retain artwork and drafts; copy, import and archive preserve originals', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(url); await ready(page)
  const originalId = await project(page)
  await rename(page, 'Mountain retreat')
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference.svg')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await page.mouse.move(700, 350); await page.mouse.wheel(120, 70)
  await page.locator('.conversation-composer textarea').fill('Keep this thought with the retreat.')
  await menu(page); await page.getByRole('button', { name: 'New canvas', exact: true }).click(); await expect.poll(() => project(page)).not.toBe(originalId); await ready(page)
  const secondId = await project(page); expect(secondId).not.toBe(originalId)
  const firstView = (await bundles(page)).find(item => item.project.id === originalId).canvasView
  await expect(page.locator('.conversation-composer textarea')).toHaveValue('')
  await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  await rename(page, 'Autumn journal')
  await page.locator('.conversation-composer textarea').fill('Another independent thought.')
  await menu(page); await page.getByRole('button', { name: 'Open Mountain retreat', exact: true }).click(); await expect.poll(() => project(page)).toBe(originalId); await ready(page)
  expect(await project(page)).toBe(originalId)
  await expect(page.locator('.conversation-composer textarea')).toHaveValue('Keep this thought with the retreat.')
  expect((await bundles(page)).find(item => item.project.id === originalId).canvasView).toEqual(firstView)
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await page.reload(); await ready(page)
  expect(await project(page)).toBe(originalId)
  await expect(page.locator('.conversation-composer textarea')).toHaveValue('Keep this thought with the retreat.')
  await actions(page); await page.getByRole('button', { name: 'Duplicate canvas', exact: true }).click(); await expect.poll(() => project(page)).not.toBe(originalId); await ready(page)
  expect(await project(page)).not.toBe(originalId)
  await expect(page.locator('.conversation-composer textarea')).toHaveValue('')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  const duplicateId = await project(page)
  await actions(page); await page.getByRole('button', { name: 'Archive canvas', exact: true }).click(); await expect.poll(() => project(page)).not.toBe(duplicateId); await ready(page)
  expect(await project(page)).not.toBe(duplicateId)
  await menu(page); await page.getByRole('button', { name: 'Archived', exact: true }).click()
  await page.getByRole('button', { name: 'Restore Mountain retreat · Copy', exact: true }).click(); await expect.poll(() => project(page)).toBe(duplicateId); await ready(page)
  expect(await project(page)).toBe(duplicateId)
  const original = (await bundles(page)).find(item => item.project.id === originalId)
  const envelope = { format: 'galta-workspace', schemaVersion: 1, exportedAt: 0, workspace: original }
  await page.locator('input[aria-label="Import canvas file"]').setInputFiles({ name: 'retreat.galta', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(envelope)) })
  await expect.poll(() => project(page)).not.toBe(duplicateId); await ready(page)
  const importedId = await project(page); expect(importedId).not.toBe(originalId)
  const all = await bundles(page)
  expect(all).toHaveLength(4)
  expect(all.find(item => item.project.id === originalId).snapshots).toEqual(original.snapshots)
  expect(all.find(item => item.project.id === importedId).agentCheckpoints).toBeUndefined()
  expect(errors).toEqual([])
})

test('explicit canvas-tab addresses stay independent; archived writes and damaged targets cannot replace work', async ({ page, context }) => {
  // Full tabs own explicit addresses. Native side panels restore a canvas per
  // browsing window through panelCanvas, rather than the localhost fixture URL.
  const canvasUrl = `${acceptanceOrigin}/canvas/index.html`
  await page.goto(canvasUrl); await ready(page); await rename(page, 'First canvas')
  const first = await project(page)
  await menu(page); await page.getByRole('button', { name: 'New canvas', exact: true }).click(); await expect.poll(() => project(page)).not.toBe(first); await ready(page); await rename(page, 'Second canvas')
  const second = await project(page)
  expect(new URL(page.url()).searchParams.get('project')).toBe(second)
  const other = await context.newPage(); await other.goto(canvasUrl + '?project=' + first); await ready(other)
  expect(await project(page)).toBe(second)
  await other.locator('.conversation-composer textarea').fill('First window draft')
  await page.reload(); await ready(page); expect(await project(page)).toBe(second)
  const before = (await bundles(page)).find(item => item.project.id === second)
  const damaged = (await bundles(page)).find(item => item.project.id === first)
  await seedWorkspace(page, { ...damaged, snapshots: { ...damaged.snapshots, [damaged.project.headCommitId]: { broken: true } } })
  await menu(page); await page.getByRole('button', { name: 'Open First canvas', exact: true }).click()
  await expect(page.getByRole('alert').first()).toContainText('Unsupported')
  expect(await project(page)).toBe(second)
  expect((await bundles(page)).find(item => item.project.id === second).snapshots).toEqual(before.snapshots)
  await other.close()
})

for (const width of [1440, 480, 360]) test(`canvas picker is usable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 720 })
  await page.goto(url); await ready(page)
  for (const [title, file] of [['Quiet forms', 'glass'], ['Summer studies', 'citrus']]) {
    await rename(page, title!)
    await page.locator('nav input[type=file]').setInputFiles(`tests/fixtures/reference-${file}.png`)
    await expect(page.locator('.pending-image')).toHaveCount(0)
    const id = await project(page)
    await expect.poll(async () => page.evaluate(async id => {
      const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('galta-v1'); r.onsuccess = () => resolve(r.result) })
      return new Promise<boolean>(resolve => { const r = db.transaction('canvas-catalog').objectStore('canvas-catalog').get(id!); r.onsuccess = () => { db.close(); resolve(Boolean(r.result?.preview)) } })
    }, id)).toBe(true)
    await menu(page); await page.getByRole('button', { name: 'New canvas', exact: true }).click(); await expect.poll(() => project(page)).not.toBe(id); await ready(page)
  }
  await rename(page, 'Mountain retreat — light and stillness')
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference.svg')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect.poll(async () => page.evaluate(async () => {
    const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open('galta-v1');r.onsuccess=()=>resolve(r.result)})
    return new Promise<boolean>(resolve=>{const r=db.transaction('canvas-catalog').objectStore('canvas-catalog').getAll();r.onsuccess=()=>{db.close();resolve(r.result.every(item => Boolean(item.preview)))}})
  })).toBe(true)
  await menu(page)
  const popup = page.getByRole('dialog', { name: 'Canvases', exact: true })
  const bounds = await popup.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720 + (width === 1440 ? 180 : 0))
  await expect(page.getByRole('searchbox', { name: 'Search canvases' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Canvas menu', exact: true })).toBeFocused()
})

test.describe('touch canvas picker', () => {
  test.use({ hasTouch: true, viewport: { width: 360, height: 720 } })
  test('creation, search clearing and utilities keep usable targets', async ({ page }) => {
    await page.goto(url); await ready(page); await menu(page)
    const search = page.getByRole('searchbox', { name: 'Search canvases', exact: true })
    await search.fill('Untitled')
    for (const name of ['New canvas', 'Clear canvas search', 'Current canvas actions', 'Archived', 'Open Untitled canvas']) {
      const target = await page.getByRole('button', { name, exact: true }).boundingBox()
      expect(target!.width).toBeGreaterThanOrEqual(44)
      expect(target!.height).toBeGreaterThanOrEqual(44)
    }
    await page.getByRole('button', { name: 'Clear canvas search', exact: true }).click()
    await expect(search).toHaveValue('')
    await expect(search).toBeFocused()
    await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
    const importButton = page.getByRole('button', { name: 'Import canvas', exact: true })
    expect((await importButton.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  })
})

test('archiving retires other views and restores the last canvas from the empty state', async ({ page, context }) => {
  await page.goto(url); await ready(page)
  await rename(page, 'Only canvas')
  const id = await project(page)
  const other = await context.newPage(); await other.goto(url + '?project=' + id); await ready(other)
  await actions(page); await page.getByRole('button', { name: 'Archive canvas', exact: true }).click()
  await expect(page.getByText('A fresh place to begin.', { exact: true })).toBeVisible()
  await expect(other.getByRole('status')).toContainText('This canvas is archived')
  await expect(other.locator('.conversation-composer textarea')).toBeDisabled()
  await menu(page); await page.getByRole('button', { name: 'Archived', exact: true }).click()
  await page.getByRole('button', { name: 'Restore Only canvas', exact: true }).click(); await ready(page)
  expect(await project(page)).toBe(id)
  await expect(other.locator('.conversation-composer textarea')).toBeEnabled()
  await other.close()
})

test('search and rename work entirely from the keyboard without losing a draft', async ({ page }) => {
  await page.goto(url); await ready(page); await rename(page, 'Quiet forms')
  await page.locator('.conversation-composer textarea').fill('Keep this unfinished thought.')
  await actions(page); await page.getByRole('button', { name: 'Rename canvas', exact: true }).click()
  const name = page.getByRole('textbox', { name: 'Canvas name', exact: true })
  await expect(name).toBeFocused()
  expect(await name.evaluate(input => (input as HTMLInputElement).selectionEnd! - (input as HTMLInputElement).selectionStart!)).toBe('Quiet forms'.length)
  await name.fill('Discard this name'); await page.keyboard.press('Escape')
  await expect(name).toHaveCount(0)
  await expect(page.getByRole('searchbox', { name: 'Search canvases' })).toBeFocused()
  await expect(page.getByRole('button', { name: 'Canvas menu', exact: true })).toContainText('Quiet forms')
  await page.getByRole('button', { name: 'New canvas', exact: true }).click(); await ready(page)
  await menu(page)
  await page.getByRole('searchbox', { name: 'Search canvases' }).fill('Quiet')
  await page.getByRole('searchbox', { name: 'Search canvases' }).dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Canvas menu', exact: true })).toContainText('Untitled canvas')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('button', { name: 'Open Quiet forms', exact: true })).toBeFocused()
  await page.keyboard.press('Enter'); await ready(page)
  await expect(page.locator('.conversation-composer textarea')).toHaveValue('Keep this unfinished thought.')
})

test('short sidebars keep every canvas menu action reachable', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 320 })
  await page.goto(url); await ready(page); await menu(page)
  const popup = page.getByRole('dialog', { name: 'Canvases', exact: true })
  await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
  const utilities = page.getByRole('dialog', { name: 'Canvas actions', exact: true })
  const importButton = utilities.getByRole('button', { name: 'Import canvas', exact: true })
  expect(await popup.evaluate(element => getComputedStyle(element).overflowY)).toBe('auto')
  await importButton.scrollIntoViewIfNeeded()
  const item = await importButton.boundingBox(), panel = await utilities.boundingBox()
  expect(item!.y + item!.height).toBeLessThanOrEqual(panel!.y + panel!.height)
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(320)
  const fileChooser = page.waitForEvent('filechooser'); await importButton.click(); await fileChooser
})

test('upgrading the catalog keeps the original document, history and native session identity', async ({ page }) => {
  await page.goto(url); await ready(page)
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference.svg')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await actions(page); const download=page.waitForEvent('download'); await page.getByRole('button', { name: 'Export canvas' }).click(); await download
  const original=(await bundles(page))[0]
  await page.goto(`${acceptanceOrigin}/migration-fixture`)
  await page.evaluate(async original => {
    original.agentSessions=[{ id:'old-session', label:'Original conversation', threadId:'original-native-thread', turns:[] }]
    const removed=indexedDB.deleteDatabase('galta-v1')
    await new Promise<void>((resolve,reject)=>{removed.onsuccess=()=>resolve();removed.onerror=()=>reject(removed.error)})
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('galta-v1',2);r.onupgradeneeded=()=>{r.result.createObjectStore('workspaces',{keyPath:'project.id'});r.result.createObjectStore('migration-backups',{keyPath:'project.id'})};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction('workspaces','readwrite');tx.objectStore('workspaces').put(original);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)})
  },original)
  await page.goto(url);await ready(page)
  const after=(await bundles(page))[0]
  expect(after.project.id).toBe(original.project.id)
  expect(after.project.commits).toEqual(original.project.commits)
  expect(after.snapshots).toEqual(original.snapshots)
  expect(after.agentSessions[0].threadId).toBe('original-native-thread')
  await page.reload();await ready(page)
  expect(await bundles(page)).toHaveLength(1)
})

test('malformed imports leave no project; valid imports detach native execution and preserve readable history', async ({ page }) => {
  await page.goto(url); await ready(page)
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference.svg')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await actions(page); const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export canvas' }).click(); await download
  const source = (await bundles(page))[0], id = source.project.id
  const upload = async (workspace: any) => page.locator('input[aria-label="Import canvas file"]').setInputFiles({ name: 'canvas.galta', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'galta-workspace', schemaVersion: 1, workspace })) })
  const invalid = structuredClone(source); invalid.project.headCommitId = 'missing-head'
  await menu(page); await upload(invalid)
  await expect(page.getByRole('alert')).toContainText('incomplete or damaged')
  expect(await project(page)).toBe(id); expect(await bundles(page)).toHaveLength(1)
  const cyclic = structuredClone(source); cyclic.project.commits[cyclic.project.headCommitId].parentId = cyclic.project.headCommitId
  await upload(cyclic); await expect(page.getByRole('alert')).toContainText('incomplete or damaged')
  expect(await bundles(page)).toHaveLength(1)
  const portable = structuredClone(source)
  portable.agentSessions = [{ id: 'old', label: 'Original ideas', providerId: 'codex-app-server', threadId: 'source-thread', lastTurnId: 'source-turn', forkFrom: { threadId: 'source-thread', lastTurnId: 'source-turn' }, turns: [{ id: 'message', instruction: 'Keep the light soft', status: 'streaming', threadId: 'source-thread', turnId: 'source-turn', items: [] }] }]
  portable.agentCheckpoints = { [portable.project.headCommitId]: { providerId: 'codex-app-server', sessionId: 'old', threadId: 'source-thread', turnId: 'source-turn' } }
  await upload(portable); await expect.poll(() => project(page)).not.toBe(id); await ready(page)
  const importedId = await project(page), all = await bundles(page), imported = all.find(b => b.project.id === importedId)
  expect(all).toHaveLength(2)
  expect(all.find(b => b.project.id === id).snapshots).toEqual(source.snapshots)
  expect(imported.agentCheckpoints).toBeUndefined()
  expect(imported.agentSessions[0]).toEqual({ id: 'old', label: 'Original ideas', providerId: 'codex-app-server', turns: [{ id: 'message', instruction: 'Keep the light soft', status: 'stopped', items: [] }] })
  expect(imported.runtimeDefaults.sessionId).not.toBe('old')
  for (const entry of [...Object.values(imported.project.commits), ...Object.values(imported.project.branches)] as any[]) expect(entry.projectId).toBe(importedId)
})

test('a failed save keeps the current canvas and draft without creating another project', async ({ page }) => {
  await page.goto(url); await ready(page)
  await page.locator('.conversation-composer textarea').fill('Do not lose this idea')
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
      if (this.name === 'workspaces') { IDBObjectStore.prototype.put = put; throw new DOMException('Fixture disk full', 'QuotaExceededError') }
      return put.call(this, value, key!)
    }
  })
  await menu(page); await page.getByRole('button', { name: 'New canvas', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Fixture disk full')
  expect(await project(page)).toBe('default-project'); expect(await bundles(page)).toHaveLength(1)
  await expect(page.locator('.conversation-composer textarea')).toHaveValue('Do not lose this idea')
  await expect(page.locator('.conversation-composer textarea')).toBeEnabled()
})

test('archive retains an unsaved edit from another view as history and keeps the archive closed', async ({ page, context }) => {
  await page.goto(url); await ready(page)
  const other = await context.newPage(); await other.goto(url + '?project=default-project'); await ready(other)
  // Hold only the normal debounce; the real archive preservation transaction runs.
  await other.evaluate(() => { const timeout = window.setTimeout; window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: any[]) => timeout(handler, delay === 650 ? 60_000 : delay, ...args)) as typeof setTimeout })
  await other.getByRole('button', { name: 'Draw — P', exact: true }).click()
  await other.mouse.move(500, 250); await other.mouse.down(); await other.mouse.move(680, 350, { steps: 8 }); await other.mouse.up()
  await expect(other.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await actions(page); await page.getByRole('button', { name: 'Archive canvas', exact: true }).click()
  await expect(other.getByRole('status')).toContainText('This canvas is archived')
  await expect.poll(async () => Object.values((await bundles(page))[0].snapshots).some((s: any) => s.document.elements.some((e: any) => e.type === 'freedraw'))).toBe(true)
  const archived = (await bundles(page))[0]
  expect(archived.project.archivedAt).toBeTruthy()
  expect(archived.snapshots[archived.project.headCommitId].document.elements).toHaveLength(0)
  await other.reload()
  expect((await bundles(other))[0].project.archivedAt).toBeTruthy()
  await other.close()
})

test('another view holding an agent execution prevents archive', async ({ page, context }) => {
  await page.goto(url); await ready(page)
  const other = await context.newPage(); await other.goto(`${acceptanceOrigin}/lock-fixture`)
  await other.evaluate(() => { void navigator.locks.request('galta-execution:default-project', { mode: 'shared' }, () => new Promise<void>(resolve => { (window as any).releaseExecution = resolve })) })
  await other.waitForFunction(() => Boolean((window as any).releaseExecution))
  await actions(page); await page.getByRole('button', { name: 'Archive canvas', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Stop it or let it finish')
  expect((await bundles(page))[0].project.archivedAt).toBeUndefined()
  await other.evaluate(() => (window as any).releaseExecution()); await other.close()
})

test('cancelled image import cannot arrive in a newly selected canvas', async ({ page }) => {
  await page.goto(url); await ready(page)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('https://images.test/slow.svg', async route => { await held; await route.fulfill({ contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="tan"/></svg>' }) })
  await page.locator('.galta-canvas').evaluate(el => {
    const data = new DataTransfer(); data.setData('application/x-galta-reference', JSON.stringify({ url: 'https://images.test/slow.svg', sourceUrl: 'https://images.test/gallery' }))
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: 400, clientY: 300, dataTransfer: data }))
  })
  await expect(page.locator('.pending-image')).toContainText('Adding media')
  await menu(page); await page.getByRole('button', { name: 'New canvas', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toContainText('Media is still arriving')
  await page.getByRole('button', { name: 'Cancel import and switch', exact: true }).click()
  await expect.poll(() => project(page)).not.toBe('default-project'); await ready(page)
  release(); await page.unrouteAll({ behavior: 'wait' })
  await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  const all = await bundles(page); expect(all).toHaveLength(2)
  for (const bundle of all) for (const snapshot of Object.values(bundle.snapshots) as any[]) expect(snapshot.document.elements).toHaveLength(0)
})

test('an archived view can restore itself and immediately edit again', async ({ page, context }) => {
  await page.goto(url); await ready(page); await rename(page, 'Restore here')
  const other = await context.newPage(); await other.goto(url + '?project=default-project'); await ready(other)
  await actions(page); await page.getByRole('button', { name: 'Archive canvas', exact: true }).click()
  await expect(other.getByRole('status')).toContainText('This canvas is archived')
  await menu(other); await other.getByRole('button', { name: 'Archived', exact: true }).click()
  await other.getByRole('button', { name: 'Restore Restore here', exact: true }).click(); await ready(other)
  await expect(other.getByRole('status')).toHaveCount(0)
  await other.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference.svg')
  await expect(other.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect.poll(async () => { const bundle = (await bundles(other))[0]; return bundle.snapshots[bundle.project.headCommitId].document.elements.length }).toBe(1)
  await other.close()
})

test('the repository rejects archived writes and stale previews without changing the catalog', async ({ page }) => {
  await page.goto('/dev/scene-test.html'); await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const { createInitialWorkspace } = await import('/canvas/workspace.ts' as string)
    const repo = (window as any).engineTest.repository, bundle = createInitialWorkspace('archive-test')
    await repo.create(bundle)
    await repo.preview(bundle.project.id, bundle.project.headCommitId, 'current-preview')
    await repo.preview(bundle.project.id, 'older-head', 'stale-preview')
    const preview = (await repo.list())[0].preview
    const archived = await repo.setArchived(bundle.project.id, true), failures: string[] = []
    for (const write of [() => repo.save(bundle), () => repo.update(bundle.project.id, () => bundle), () => repo.saveMigration(bundle, bundle), () => repo.create(bundle)]) {
      try { await write(); failures.push('unexpected success') } catch (error) { failures.push(String(error)) }
    }
    const saved = await repo.load(bundle.project.id), list = await repo.list()
    return { preview, failures, saved, archived, count: list.length, archivedInCatalog: Boolean(list[0].archivedAt) }
  })
  expect(result.preview).toBe('current-preview')
  expect(result.failures).toHaveLength(4)
  expect(result.failures.every(value => value !== 'unexpected success')).toBe(true)
  expect(result.saved).toEqual(result.archived)
  expect(result.count).toBe(1); expect(result.archivedInCatalog).toBe(true)
})

test('copying an image into another canvas preserves independent bytes after editing the original', { tag: '@serial' }, async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(url); await ready(page); await rename(page, 'Source artwork')
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference.svg')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+c')
  await menu(page); await page.getByRole('button', { name: 'New canvas', exact: true }).click(); await expect.poll(() => project(page)).not.toBe('default-project'); await ready(page)
  const targetId = await project(page)
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+v')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await menu(page); await page.getByRole('button', { name: 'Open Source artwork', exact: true }).click(); await expect.poll(() => project(page)).toBe('default-project'); await ready(page)
  const target = (await bundles(page)).find(b => b.project.id === targetId)
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace')
  await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  await menu(page); await page.getByRole('button', { name: 'Open Untitled canvas', exact: true }).click(); await expect.poll(() => project(page)).toBe(targetId); await ready(page)
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  const restored = (await bundles(page)).find(b => b.project.id === targetId)
  expect(restored.snapshots).toEqual(target.snapshots)
  expect(Object.values(restored.snapshots[restored.project.headCommitId].document.files).every((file: any) => file.dataURL.startsWith('data:'))).toBe(true)
})

test('failed creation from the empty library shows its error and leaves archived work intact', async ({ page }) => {
  await page.goto(url); await ready(page)
  await actions(page); await page.getByRole('button', { name: 'Archive canvas', exact: true }).click()
  await expect(page.getByText('A fresh place to begin.', { exact: true })).toBeVisible()
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function(value: any, key?: IDBValidKey) {
      if (this.name === 'workspaces') { IDBObjectStore.prototype.add = add; throw new DOMException('Fixture create quota', 'QuotaExceededError') }
      return add.call(this, value, key!)
    }
  })
  await page.getByRole('button', { name: 'New canvas', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Fixture create quota')
  const all = await bundles(page); expect(all).toHaveLength(1); expect(all[0].project.archivedAt).toBeTruthy()
})
