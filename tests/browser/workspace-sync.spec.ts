import { storedWorkspace } from '../helpers/stored-workspace'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { test, expect, type Page } from '@playwright/test'

const workspace = storedWorkspace

const image = {
  name: 'sync-reference.svg',
  mimeType: 'image/svg+xml',
  buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320"><rect width="100%" height="100%" fill="#becbd4"/></svg>')
}
const secondImage = {
  name: 'sync-reference-2.svg',
  mimeType: 'image/svg+xml',
  buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><circle cx="90" cy="90" r="80" fill="#d8b4a0"/></svg>')
}

test('open Galta panels observe committed canvas changes from another window', async ({ page }) => {
  await page.context().route('**/favicon.ico', route => route.fulfill({ status: 204 }))
  const other = await page.context().newPage()
  const errors: string[] = []
  for (const panel of [page, other]) {
    panel.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    panel.on('pageerror', error => errors.push(`${error.name}: ${error.message}`))
  }
  await Promise.all([
    page.goto(`${acceptanceOrigin}/sidepanel/index.html`),
    other.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  ])
  await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  await expect(other.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  await page.locator('nav input[type=file]').setInputFiles(image)
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect(other.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  const saved = await workspace(other)
  const snapshot = saved.snapshots[saved.project.headCommitId]
  const file = Object.values(snapshot.document.files)[0] as { dataURL: string }
  expect(Buffer.from(file.dataURL.split(',')[1]!, 'base64')).toEqual(image.buffer)
  await other.reload()
  await expect(other.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  expect((await workspace(other)).snapshots[saved.project.headCommitId]).toEqual(snapshot)
  expect(errors).toEqual([])
  await other.close()
})

test('a waking cached panel loads revisions whose broadcasts it missed', async ({ page }) => {
  const other = await page.context().newPage()
  await other.addInitScript(() => {
    window.BroadcastChannel = class { postMessage() {} addEventListener() {} removeEventListener() {} close() {} } as any
  })
  await Promise.all([page.goto(`${acceptanceOrigin}/sidepanel/index.html`), other.goto(`${acceptanceOrigin}/sidepanel/index.html`)])
  for (const p of [page, other]) await expect(p.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  await page.locator('nav input[type=file]').setInputFiles(image)
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await page.getByRole('button', { name: 'Canvas zoom', exact: true }).click()
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await workspace(page)).canvasView.zoom).toBe(1.25)
  const saved = await workspace(page)
  await expect(other.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  // Exercise the native lifecycle boundary without inventing a sync broadcast.
  await other.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(other.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect(other.getByRole('button', { name: 'Canvas zoom', exact: true })).toContainText('125%')
  await expect(other.getByRole('button', { name: 'Canvas menu', exact: true })).toBeEnabled()
  expect((await workspace(other)).snapshots[saved.project.headCommitId]).toEqual(saved.snapshots[saved.project.headCommitId])
  expect(Object.keys((await workspace(other)).project.commits)).toEqual(Object.keys(saved.project.commits))
  await other.close()
})

test('a pending local edit blocks automatic cross-window replacement', async ({ page }) => {
  const other = await page.context().newPage()
  await Promise.all([
    page.goto(`${acceptanceOrigin}/sidepanel/index.html`),
    other.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  ])
  await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  await expect(other.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()

  // Keep an uncommitted drawing in the second window while the first window
  // commits a different object. The sync signal must surface a choice instead
  // of replacing the local scene underneath the user's pointer.
  await other.getByRole('button', { name: 'Draw — P', exact: true }).click()
  const box = (await other.locator('.galta-canvas').boundingBox())!
  await other.mouse.move(box.x + 520, box.y + 260)
  await other.mouse.down()
  await other.mouse.move(box.x + 760, box.y + 420, { steps: 8 })
  await other.mouse.up()
  await expect(other.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await page.locator('nav input[type=file]').setInputFiles([image, secondImage])
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  await expect(other.getByRole('status')).toContainText('Another Galta window has newer canvas changes')
  await expect(other.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()

  await other.getByRole('button', { name: 'Load changes', exact: true }).click()
  await expect(other.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  const saved = await workspace(other)
  const snapshots = Object.values(saved.snapshots) as any[]
  expect(snapshots.some(s => s.document.elements.some((el: any) => el.type === 'freedraw'))).toBe(true)
  expect(snapshots.some(s => s.document.elements.filter((el: any) => el.type === 'image').length === 2)).toBe(true)
  expect(Object.keys(saved.project.branches)).toHaveLength(2)
  await other.reload()
  await expect(other.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  await expect(other.getByRole('button', { name: 'Open Time Machine', exact: true })).toBeVisible()
  expect((await workspace(other)).project.headCommitId).toBe(saved.project.headCommitId)
  await other.close()
})

test('simultaneous saves preserve both futures even before a broadcast is delivered', async ({ page }) => {
  const other = await page.context().newPage()
  for (const p of [page, other]) await p.addInitScript(() => {
    // Force the storage race independently of the optional invalidation channel.
    window.BroadcastChannel = class { postMessage() {} addEventListener() {} removeEventListener() {} close() {} } as any
  })
  await Promise.all([page.goto(`${acceptanceOrigin}/sidepanel/index.html`), other.goto(`${acceptanceOrigin}/sidepanel/index.html`)])
  for (const p of [page, other]) {
    await expect(p.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  }
  await Promise.all([page.locator('nav input[type=file]').setInputFiles(image), other.locator('nav input[type=file]').setInputFiles(secondImage)])
  for (const p of [page, other]) await expect(p.locator('.pending-image')).toHaveCount(0)
  await expect.poll(async () => Object.keys((await workspace(page)).project.commits).length).toBe(3)
  const saved = await workspace(page)
  expect(Object.keys(saved.project.branches)).toHaveLength(2)
  const documents = Object.values(saved.snapshots) as any[]
  expect(documents.filter(s => s.document.elements.length === 1)).toHaveLength(2)
  const ratios = documents.filter(s => s.document.elements.length === 1).map(s => s.document.elements[0].width / s.document.elements[0].height).sort()
  expect(ratios).toEqual([.75, 1])
  await page.reload()
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open Time Machine', exact: true })).toBeVisible()
  await other.close()
})

test('camera-only movement survives reopening without adding an artwork version', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.locator('nav input[type=file]').setInputFiles(image)
  await expect(page.locator('.pending-image')).toHaveCount(0)
  // Finish the preceding import's queued save before measuring a camera-only
  // interaction. History is the product's explicit persistence barrier.
  await page.getByRole('button', { name: 'Open Time Machine', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Time Machine', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close Time Machine', exact: true }).click()
  // The new version's picker thumbnail is background work after the import;
  // it settles before the camera-only interaction is measured.
  await expect.poll(() => page.evaluate(() => new Promise<boolean>(resolve => {
    const r = indexedDB.open('galta-v1')
    r.onsuccess = () => { const g = r.result.transaction('canvas-catalog').objectStore('canvas-catalog').get('default-project'); g.onsuccess = () => { r.result.close(); resolve(g.result?.previewHead === g.result?.headCommitId) } }
  })), { timeout: 15000 }).toBe(true)
  const before = await workspace(page)
  await page.evaluate(() => {
    const w = window as any, original = IDBObjectStore.prototype.get
    w.cameraArtworkReads = 0
    w.finishCameraInspection = () => { IDBObjectStore.prototype.get = original; return w.cameraArtworkReads }
    IDBObjectStore.prototype.get = function(...args) { if (this.name === 'workspaces' || this.name === 'canvas-snapshots' || this.name === 'canvas-assets') w.cameraArtworkReads++; return original.apply(this, args) }
  })
  await page.getByRole('button', { name: 'Canvas zoom', exact: true }).click()
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('galta-v1'); r.onsuccess = () => resolve(r.result) })
    return new Promise<number>(resolve => { const r = db.transaction('canvas-views').objectStore('canvas-views').get('default-project'); r.onsuccess = () => { db.close(); resolve(r.result.zoom) } })
  })).toBeGreaterThan(1)
  expect(await page.evaluate(() => (window as any).finishCameraInspection())).toBe(0)
  const changed = await workspace(page)
  expect(Object.keys(changed.project.commits)).toEqual(Object.keys(before.project.commits))
  await page.reload()
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Canvas zoom', exact: true })).toContainText(String(Math.round(changed.canvasView.zoom * 100)))
  expect((await workspace(page)).canvasView).toEqual(changed.canvasView)
})
