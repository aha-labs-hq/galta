import { installReturningAccount } from '../helpers/canvas-port'
import { removeStoredWorkspace, storedWorkspaces } from '../helpers/stored-workspace'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { test, expect, type Page } from '@playwright/test'

test.beforeEach(async ({ context }) => { await installReturningAccount(context) })

const url = `${acceptanceOrigin}/sidepanel/index.html`
async function ready(page: Page) { await expect(page.locator('.conversation-composer textarea')).toBeEnabled(); await expect(page.locator('.excalidraw')).toBeVisible() }
async function menu(page: Page) { await page.getByRole('button', { name: 'Canvas menu', exact: true }).click() }
async function actions(page: Page) { await menu(page); await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click() }
async function project(page: Page) { return page.locator('.galta-shell').getAttribute('data-project-id') }
async function rename(page: Page, title: string) {
  await actions(page); await page.getByRole('button', { name: 'Rename canvas', exact: true }).click()
  await page.getByRole('textbox', { name: 'Canvas name', exact: true }).fill(title)
  await page.getByRole('button', { name: 'Save canvas name', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Canvas menu', exact: true })).toContainText(title)
}
async function create(page: Page, title: string, draft: string) {
  const before = await project(page)
  await menu(page); await page.getByRole('button', { name: 'New canvas', exact: true }).click(); await expect.poll(() => project(page)).not.toBe(before); await ready(page)
  await rename(page, title)
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference.svg')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await page.locator('.conversation-composer textarea').fill(draft)
  return (await project(page))!
}
async function archive(page: Page) {
  const before = await project(page)
  await actions(page); await page.getByRole('button', { name: 'Archive canvas', exact: true }).click(); await expect.poll(() => project(page)).not.toBe(before); await ready(page)
}
/** Every record a canvas owns, store by store. */
async function footprint(page: Page, id: string) {
  return page.evaluate(async id => {
    const open = (name: string) => new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    const count = (db: IDBDatabase, store: string, key: IDBValidKey | IDBKeyRange) => new Promise<number>(resolve => { const r = db.transaction(store).objectStore(store).count(key); r.onsuccess = () => resolve(r.result) })
    const galta = await open('galta-v1'), drafts = await open('galta-message-drafts'), range = IDBKeyRange.bound([id], [id, []])
    const result: Record<string, number> = {}
    for (const store of ['canvas-snapshots', 'canvas-assets', 'canvas-previews']) result[store] = await count(galta, store, range)
    for (const store of ['workspaces', 'canvas-catalog', 'canvas-views', 'migration-backups']) result[store] = await count(galta, store, id)
    result.drafts = await count(drafts, 'messages', range)
    galta.close(); drafts.close()
    return result
  }, id)
}

test('an archived canvas is deleted completely, after confirmation, and nothing else changes', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(url); await ready(page)
  await rename(page, 'Keep me')
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference.svg')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await page.locator('.conversation-composer textarea').fill('This draft stays.')
  const keptId = (await project(page))!
  const doomedId = await create(page, 'Delete me', 'This draft goes.')
  await archive(page)
  expect(await project(page)).toBe(keptId)
  // A migration backup belongs to the canvas too.
  await page.evaluate(async id => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('galta-v1'); r.onsuccess = () => resolve(r.result) })
    await new Promise(resolve => { const tx = db.transaction('migration-backups', 'readwrite'); tx.objectStore('migration-backups').put({ project: { id }, snapshots: {} }); tx.oncomplete = resolve })
    db.close()
  }, doomedId)
  const before = await footprint(page, doomedId)
  for (const store of ['canvas-snapshots', 'canvas-assets', 'workspaces', 'canvas-catalog', 'migration-backups', 'drafts']) expect(before[store], store).toBeGreaterThan(0)
  const kept = (await storedWorkspaces(page)).find(item => item.project.id === keptId)
  const keptFootprint = await footprint(page, keptId)

  await menu(page); await page.getByRole('button', { name: 'Archived', exact: true }).click()
  await page.getByRole('button', { name: 'Delete Delete me', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Delete “Delete me”?')
  await expect(dialog).toContainText('can’t be undone')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore Delete me', exact: true })).toBeVisible()
  expect(await footprint(page, doomedId)).toEqual(before)

  await page.getByRole('button', { name: 'Delete Delete me', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('No archived canvases.', { exact: true })).toBeVisible()
  expect(Object.values(await footprint(page, doomedId)).every(count => count === 0)).toBe(true)
  expect((await storedWorkspaces(page)).map(item => item.project.id)).toEqual([keptId])
  expect((await storedWorkspaces(page))[0]).toEqual(kept)
  // Previews are derived data the open canvas keeps warming in the background.
  const { 'canvas-previews': _, ...keptAfter } = await footprint(page, keptId), { 'canvas-previews': __, ...keptBefore } = keptFootprint
  expect(keptAfter).toEqual(keptBefore)
  expect(await project(page)).toBe(keptId)
  await page.keyboard.press('Escape')
  await expect(page.locator('.conversation-composer textarea')).toHaveValue('This draft stays.')
  expect(errors).toEqual([])
})

test('several archived canvases go together, and only an archived canvas can be deleted', async ({ page }) => {
  await page.goto(url); await ready(page)
  await rename(page, 'Working')
  const workingId = (await project(page))!
  for (const title of ['Old one', 'Old two', 'Old three']) { await create(page, title, `${title} draft`); await archive(page) }
  await menu(page); await page.getByRole('button', { name: 'Archived', exact: true }).click()
  await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
  await page.getByRole('button', { name: 'Delete 3 canvases…', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Delete 3 archived canvases?')
  for (const title of ['Old one', 'Old two', 'Old three']) await expect(dialog).toContainText(`“${title}”`)
  await dialog.getByRole('button', { name: 'Delete 3', exact: true }).click()
  await expect(page.getByText('No archived canvases.', { exact: true })).toBeVisible()
  expect((await storedWorkspaces(page)).map(item => item.project.id)).toEqual([workingId])
  // The storage boundary itself refuses a canvas that is not archived.
  const working = (await storedWorkspaces(page))[0]
  expect(await removeStoredWorkspace(page, workingId)).toBe('Archive this canvas before deleting it.')
  expect((await storedWorkspaces(page))[0]).toEqual(working)
  await page.keyboard.press('Escape'); await ready(page)
  await expect(page.getByRole('button', { name: 'Canvas menu', exact: true })).toContainText('Working')
})
