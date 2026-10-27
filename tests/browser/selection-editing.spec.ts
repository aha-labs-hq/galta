import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { restoreHistory } from './history-helpers'

import { storedWorkspace as workspace, seedWorkspace } from '../helpers/stored-workspace'
async function documentAtHead(page: Page) { const w = await workspace(page); return w.snapshots[w.project.headCommitId].document }
const original = { name: 'original.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><path fill="#e03131" d="M0 0h150v300H0z"/><path fill="#2f9e44" d="M150 0h150v300H150z"/></svg>') }
const replacement = { name: 'landscape.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><path fill="#1971c2" d="M0 0h400v200H0z"/></svg>') }
async function menu(page: Page) { await page.getByRole('button', { name: 'More selection actions', exact: true }).click() }

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.locator('nav input[type=file]').setInputFiles(original)
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
})

test('replace keeps identity, center and image ratio; undo, redo and reload preserve both images', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  const before = await documentAtHead(page), old = before.elements[0]
  await menu(page)
  const picker = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Replace image', exact: true }).click()
  await (await picker).setFiles(replacement)
  await expect.poll(async () => (await documentAtHead(page)).elements[0].fileId).not.toBe(old.fileId)
  const changed = await documentAtHead(page), next = changed.elements[0]
  expect(changed.elements).toHaveLength(1)
  expect(next.id).toBe(old.id); expect(next.angle).toBe(old.angle)
  expect(next.x + next.width / 2).toBe(old.x + old.width / 2)
  expect(next.y + next.height / 2).toBe(old.y + old.height / 2)
  expect(next.width / next.height).toBe(2)
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+z')
  await expect.poll(async () => (await documentAtHead(page)).elements[0].fileId).toBe(old.fileId)
  expect((await documentAtHead(page)).files[old.fileId]).toEqual(before.files[old.fileId])
  await page.keyboard.press('Meta+Shift+z')
  await expect.poll(async () => (await documentAtHead(page)).elements[0].fileId).toBe(next.fileId)
  await page.reload()
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  expect((await documentAtHead(page)).files[next.fileId]).toEqual(changed.files[next.fileId])
  expect(errors).toEqual([])
})

test('crop uses engine handles, exports the visible pixels and restores the original with one undo', async ({ page }) => {
  const before = await documentAtHead(page), old = before.elements[0]
  await page.getByRole('button', { name: 'Crop', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Done cropping', exact: true })).toBeVisible()
  const region = (await page.locator('.galta-canvas').boundingBox())!
  await page.mouse.move(region.x + old.x, region.y + old.y + old.height / 2)
  await page.mouse.down()
  await page.mouse.move(region.x + old.x + old.width / 2, region.y + old.y + old.height / 2, { steps: 12 })
  await page.mouse.up()
  await page.getByRole('button', { name: 'Done cropping', exact: true }).click()
  await expect.poll(async () => (await documentAtHead(page)).elements[0].crop?.width).toBeLessThan(old.width)
  const cropped = await documentAtHead(page), el = cropped.elements[0]
  expect(el.fileId).toBe(old.fileId)
  expect(cropped.files[el.fileId]).toEqual(before.files[old.fileId])
  await page.getByRole('button', { name: 'Export selection', exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: /^PNG image/ }).click()
  const path = test.info().outputPath('cropped.png')
  await (await download).saveAs(path)
  const exported = await page.evaluate(async base64 => {
    const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + base64)).blob())
    const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height
    const ctx = c.getContext('2d')!; ctx.drawImage(bitmap, 0, 0)
    return { width: c.width, height: c.height, pixel: [...ctx.getImageData(c.width / 2, c.height / 2, 1, 1).data] }
  }, readFileSync(path).toString('base64'))
  expect(exported.width / exported.height).toBeCloseTo(el.width / el.height, 1)
  expect(exported.pixel).toEqual([47, 158, 68, 255])
  await expect(page.getByRole('status')).toContainText('PNG image download started.')
  await expect(page.getByRole('button', { name: /^PNG image/ })).toBeFocused()
  const sourceDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: /^Original file/ }).click()
  const sourcePath = test.info().outputPath('original.svg')
  await (await sourceDownload).saveAs(sourcePath)
  expect(readFileSync(sourcePath)).toEqual(original.buffer)
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+z')
  await expect.poll(async () => (await documentAtHead(page)).elements[0].crop).toBeNull()
  expect((await documentAtHead(page)).elements[0].width).toBe(old.width)
})

test('a file picker cannot replace the same object after a history restore', async ({ page }) => {
  const initial = await workspace(page)
  await menu(page)
  const picker = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Replace image', exact: true }).click()
  const chooser = await picker
  await restoreHistory(page, Object.values(initial.project.commits).find((item: any) => item.parentId === null)!.id)
  await restoreHistory(page, initial.project.headCommitId)
  const resumed = await workspace(page)
  await chooser.setFiles(replacement)
  await expect(page.getByRole('alert')).toContainText('canvas version changed')
  expect((await workspace(page)).project.headCommitId).toBe(resumed.project.headCommitId)
})

test('a pending export keeps its captured artwork and cannot overwrite a new capsule', async ({ page }) => {
  // Hold the real PNG encoder at its asynchronous boundary, after the selected
  // artwork has been rendered. The browser still produces the actual download.
  await page.evaluate(() => {
    const encode = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      HTMLCanvasElement.prototype.toBlob = encode
      ;(window as any).completeExport = () => encode.call(this, callback, type, quality)
    }
  })
  await page.getByRole('button', { name: 'Export selection', exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'PNG image', exact: true }).click()
  await expect(page.getByRole('button', { name: 'PNG image', exact: true })).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByRole('button', { name: 'Original file', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Back to selection actions', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Export selection', exact: true })).toBeFocused()
  await page.locator('nav input[type=file]').setInputFiles(replacement)
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await page.getByRole('button', { name: 'Export selection', exact: true }).click()
  await page.evaluate(() => (window as any).completeExport())
  const path = test.info().outputPath('captured-selection.png')
  await (await download).saveAs(path)
  const size = await page.evaluate(async base64 => {
    const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + base64)).blob())
    const size = [bitmap.width, bitmap.height]; bitmap.close(); return size
  }, readFileSync(path).toString('base64'))
  expect(size).toEqual([300, 300])
  await expect(page.locator('.selection-export [role=status]')).toHaveText('')
  await expect(page.getByRole('button', { name: 'PNG image', exact: true })).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByRole('button', { name: 'Original file', exact: true })).toBeEnabled()
})

test('an encoder failure leaves the export choices available for an explicit retry', async ({ page }) => {
  await page.evaluate(() => {
    const encode = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback) {
      HTMLCanvasElement.prototype.toBlob = encode
      callback(null)
    }
  })
  await page.getByRole('button', { name: 'Export selection', exact: true }).click()
  await page.getByRole('button', { name: 'PNG image', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('button', { name: 'PNG image', exact: true })).toBeFocused()
  await expect(page.getByRole('button', { name: 'PNG image', exact: true })).toBeEnabled()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'PNG image', exact: true }).click()
  expect((await download).suggestedFilename()).toBe('galta-selection.png')
  await expect(page.locator('.selection-export [role=status]')).toHaveText('PNG image download started.')
})

test('an unreadable replacement leaves the original and history intact', async ({ page }) => {
  const before = await workspace(page)
  await menu(page)
  const picker = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Replace image', exact: true }).click()
  await (await picker).setFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') })
  await expect(page.getByRole('alert')).toContainText('could not be decoded')
  expect((await workspace(page)).snapshots).toEqual(before.snapshots)
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
})

test('replacement stays on the captured target when another image becomes selected', async ({ page }) => {
  const old = (await documentAtHead(page)).elements[0]
  await menu(page)
  const picker = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Replace image', exact: true }).click()
  const chooser = await picker
  await page.locator('nav input[type=file]').setInputFiles(original)
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  await expect(page.locator('.pending-image')).toHaveCount(0)
  const other = (await documentAtHead(page)).elements.find((el: any) => el.id !== old.id)
  await chooser.setFiles(replacement)
  await expect.poll(async () => (await documentAtHead(page)).elements.find((el: any) => el.id === old.id).fileId).not.toBe(old.fileId)
  expect((await documentAtHead(page)).elements.find((el: any) => el.id === other.id)).toEqual(other)
})

test('failed replacement save retries without replacing twice or losing the original version', async ({ page }) => {
  const before = await workspace(page), old = (await documentAtHead(page)).elements[0]
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'workspaces') { IDBObjectStore.prototype.put = put; throw new DOMException('Replacement save test', 'QuotaExceededError') }
      return put.apply(this, args)
    }
  })
  await menu(page)
  const picker = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Replace image', exact: true }).click()
  await (await picker).setFiles(replacement)
  await expect(page.getByRole('alert')).toContainText('Media replaced, but not saved')
  expect((await workspace(page)).project.headCommitId).toBe(before.project.headCommitId)
  await page.getByRole('button', { name: 'Retry saving media', exact: true }).click()
  await expect(page.locator('.pending-image')).toHaveCount(0)
  const saved = await workspace(page)
  expect(saved.snapshots[before.project.headCommitId]).toEqual(before.snapshots[before.project.headCommitId])
  expect(saved.snapshots[saved.project.headCommitId].document.elements).toHaveLength(1)
  expect(saved.snapshots[saved.project.headCommitId].document.elements[0].fileId).not.toBe(old.fileId)
  expect(Object.keys(saved.project.commits)).toHaveLength(Object.keys(before.project.commits).length + 1)
})
