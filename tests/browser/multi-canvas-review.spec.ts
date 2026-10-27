import { storedWorkspaces } from '../helpers/stored-workspace'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { test, expect, type Page } from '@playwright/test'
import { installReturningAccount } from '../helpers/canvas-port'

const url = `${acceptanceOrigin}/sidepanel/index.html`
async function ready(page: Page) { await expect(page.getByRole('button', { name: 'Expand canvas', exact: true })).toBeEnabled() }
async function menu(page: Page) { await page.getByRole('button', { name: 'Canvas menu', exact: true }).click() }
const bundles = storedWorkspaces

test('leaving a stale view cannot reselect an older shared canvas version', async ({ page, context }) => {
  await page.goto(url); await ready(page)
  const stale = await context.newPage()
  await stale.addInitScript(() => {
    window.BroadcastChannel = class { postMessage() {} addEventListener() {} removeEventListener() {} close() {} } as any
    const listen = window.addEventListener.bind(window)
    window.addEventListener = ((type: string, ...args: any[]) => { if (type !== 'focus') (listen as any)(type, ...args) }) as any
  })
  await stale.goto(url + '?project=default-project'); await ready(stale)
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference.svg')
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  const before = (await bundles(page))[0]
  await expect(stale.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  await menu(stale); await stale.getByRole('button', { name: 'New canvas', exact: true }).click()
  await expect(stale.locator('.galta-shell')).not.toHaveAttribute('data-project-id', 'default-project')
  const after = (await bundles(page)).find(item => item.project.id === 'default-project')
  expect(after.project.headCommitId).toBe(before.project.headCommitId)
  expect(after.canvasView).toEqual(before.canvasView)
  expect(after.snapshots).toEqual(before.snapshots)
})

test('rename holds navigation until the owning project metadata is saved', async ({ page }) => {
  await page.goto(url); await ready(page)
  await page.evaluate(() => {
    const marked = new WeakSet<IDBTransaction>(), put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(value: any, ...args: any[]) {
      if (this.name === 'workspaces' && value.project.title === 'Slow rename') marked.add(this.transaction)
      return put.call(this, value, ...args)
    }
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { configurable: true, get: complete.get, set(callback) {
      complete.set!.call(this, function(this: IDBTransaction, event: Event) {
        if (marked.has(this)) (window as any).releaseRename = () => callback.call(this, event)
        else callback.call(this, event)
      })
    } })
  })
  await menu(page); await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
  await page.getByRole('button', { name: 'Rename canvas', exact: true }).click()
  await page.getByRole('textbox', { name: 'Canvas name' }).fill('Slow rename')
  await page.getByRole('button', { name: 'Save canvas name', exact: true }).click()
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseRename)).toBe('function')
  await expect(page.getByRole('button', { name: 'New canvas', exact: true })).toBeDisabled()
  await page.evaluate(() => (window as any).releaseRename())
  await expect(page.getByRole('button', { name: 'Canvas menu', exact: true })).toContainText('Slow rename')
  await expect(page.getByRole('button', { name: 'Canvas menu', exact: true })).toBeEnabled()
})

test('native focus owns the navigation boundary until Chrome completes or fails', async ({ page }) => {
  await installReturningAccount(page)
  await page.goto(url); await ready(page)
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference.svg')
  await expect(page.getByRole('group', { name: 'Selection actions', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const host = window as any
    host.chrome = { storage: { session: { get: async () => ({}), set: async () => {} } }, runtime: { id: 'host-fixture', getURL: (path: string) => `chrome-extension://host-fixture/${path}` }, tabs: {
      query: async () => [{ id: 42, windowId: 1 }],
      create: () => new Promise((_, reject) => { host.failFocus = () => reject(new Error('Controlled tab creation failure')) })
    } }
  })
  await page.locator('.conversation-composer textarea').fill('Keep this before focusing')
  await page.getByRole('button', { name: 'Expand canvas', exact: true }).click()
  await expect.poll(() => page.evaluate(() => typeof (window as any).failFocus)).toBe('function')
  await expect(page.locator('.galta-application')).toHaveAttribute('inert', '')
  await expect(page.locator('.galta-document')).toHaveAttribute('inert', '')
  await expect(page.locator('.conversation-composer textarea')).toBeDisabled()
  await expect(page.locator('.galta-canvas')).toHaveAttribute('inert', '')
  await page.keyboard.press('Backspace')
  await page.evaluate(() => (window as any).failFocus())
  await expect(page.getByRole('alert')).toContainText('Controlled tab creation failure')
  await expect(page.getByRole('button', { name: 'Canvas menu', exact: true })).toBeEnabled()
  await expect(page.locator('.conversation-composer textarea')).toHaveValue('Keep this before focusing')
  await expect(page.getByRole('group', { name: 'Selection actions', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await ready(page)
})

test('an unreadable archived canvas stays archived after a failed restore', async ({ page }) => {
  await page.goto(url); await ready(page)
  await menu(page); await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
  await page.getByRole('button', { name: 'Archive canvas', exact: true }).click()
  await expect(page.getByText('A fresh place to begin.', { exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('galta-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['workspaces', 'canvas-snapshots'], 'readwrite'), snapshots = tx.objectStore('canvas-snapshots')
        const workspace = tx.objectStore('workspaces').get('default-project')
        workspace.onsuccess = () => {
          // Corrupt the payload while retaining a readable storage manifest.
          const value = workspace.result, key = ['default-project', value.snapshots[value.project.headCommitId]]
          snapshots.put({ value: { broken: true }, assets: [] }, key)
        }
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error)
      })
    } finally { db.close() }
  })
  await page.reload() // Discard cached immutable records before reading the damaged storage.
  await expect(page.getByText('A fresh place to begin.', { exact: true })).toBeVisible()
  const before = (await bundles(page))[0]
  await menu(page); await page.getByRole('button', { name: 'Archived', exact: true }).click()
  await page.getByRole('button', { name: 'Restore Untitled canvas', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Unsupported')
  expect((await bundles(page))[0]).toEqual(before)
})

test('invalid imported runtime data fails visibly before a project is created', async ({ page }) => {
  await page.goto(url); await ready(page)
  const original = (await bundles(page))[0]
  const damaged = structuredClone(original); damaged.runtimeDefaults.modelId = { malformed: true }
  const envelope = { format: 'galta-workspace', schemaVersion: 1, exportedAt: 0, workspace: damaged }
  await page.locator('input[aria-label="Import canvas file"]').setInputFiles({ name: 'damaged.galta', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(envelope)) })
  await expect(page.getByRole('alert')).toContainText('incomplete or damaged')
  expect(await bundles(page)).toHaveLength(1)
  await ready(page)
})

test('a later conversation save cannot hide an earlier unsaved draft when leaving', async ({ page }) => {
  await installReturningAccount(page)
  await page.goto(url); await ready(page)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(value: any, ...args: any[]) {
      if (this.name === 'messages' && value.command === 'Keep the unsaved idea') throw new DOMException('Controlled draft quota', 'QuotaExceededError')
      return put.call(this, value, ...args)
    }
    ;(window as any).restoreDraftWrites = () => { IDBObjectStore.prototype.put = put }
  })
  await page.locator('.conversation-composer textarea').fill('Keep the unsaved idea')
  await expect(page.getByRole('alert')).toContainText('draft was not saved')
  await page.getByRole('button', { name: 'Dismiss notice', exact: true }).click()
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await page.getByRole('button', { name: 'New conversation', exact: true }).click()
  await expect(page.locator('.conversation-composer textarea')).toHaveValue('')
  await page.locator('.conversation-composer textarea').fill('The second draft is saved')
  await menu(page); await page.getByRole('button', { name: 'New canvas', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('draft')
  expect(await bundles(page)).toHaveLength(1)
  await page.keyboard.press('Escape'); await page.evaluate(() => (window as any).restoreDraftWrites())
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Switch conversation', exact: true }).click()
  await page.getByRole('menuitemradio', { name: /New conversation Draft: Keep the unsaved idea/ }).click()
  await expect(page.locator('.conversation-composer textarea')).toHaveValue('Keep the unsaved idea')
  await page.locator('.conversation-composer textarea').fill('Keep the unsaved idea, now saved')
  await page.keyboard.press('Escape'); await menu(page)
  await page.getByRole('button', { name: 'New canvas', exact: true }).click()
  await expect(page.locator('.galta-shell')).not.toHaveAttribute('data-project-id', 'default-project')
  await menu(page); await page.getByRole('button', { name: 'Open Untitled canvas', exact: true }).and(page.locator(':not([aria-current])')).click()
  await expect(page.locator('.galta-shell')).toHaveAttribute('data-project-id', 'default-project')
  await expect(page.locator('.conversation-composer textarea')).toHaveValue('Keep the unsaved idea, now saved')
})
