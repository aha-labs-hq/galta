import { storedWorkspace } from '../helpers/stored-workspace'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { test, expect, type Page, type Locator } from '@playwright/test'
import { restoreHistory } from './history-helpers'
import { installReturningAccount } from '../helpers/canvas-port'

const workspace = storedWorkspace
async function doc(page: Page) { const w = await workspace(page); return w.snapshots[w.project.headCommitId].document }
const geometry = (document: any) => document.elements.map((el: any) => [el.id, el.x, el.y, el.width, el.height, el.angle, el.fileId])
async function menu(page: Page) { await page.getByRole('button', { name: 'More selection actions', exact: true }).click() }
async function fit(page: Page) {
  await page.getByRole('button', { name: 'Canvas zoom', exact: true }).click()
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await page.keyboard.press('Escape')
}
async function reachable(locator: Locator) {
  await locator.scrollIntoViewIfNeeded()
  await expect.poll(() => locator.evaluate(el => {
    const r = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
  })).toBe(true)
}

test.beforeEach(async ({ page }) => {
  await installReturningAccount(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.locator('nav input[type=file]').setInputFiles(['pink', 'glass', 'citrus', 'flower'].map(name => `tests/fixtures/reference-${name}.png`))
  await expect(page.getByRole('region', { name: 'Galta canvas, 4 objects', exact: true })).toBeVisible()
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+a')
})

test('reference collage: tidy, undo, redo, historical edit and reopening preserve both futures', async ({ page }) => {
  const before = await workspace(page), original = await doc(page)
  await page.getByRole('button', { name: 'Tidy', exact: true }).click()
  await expect.poll(async () => geometry(await doc(page))).not.toEqual(geometry(original))
  const tidy = await workspace(page), arranged = await doc(page)
  expect(arranged.files).toEqual(original.files)
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+z')
  await expect.poll(async () => geometry(await doc(page))).toEqual(geometry(original))
  await page.keyboard.press('Meta+Shift+z')
  await expect.poll(async () => geometry(await doc(page))).toEqual(geometry(arranged))
  await restoreHistory(page, before.project.headCommitId)
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+a')
  await menu(page); await page.getByRole('button', { name: 'Rotate right', exact: true }).click()
  await expect.poll(async () => Object.keys((await workspace(page)).project.branches).length).toBe(2)
  const branch = await workspace(page)
  expect(branch.snapshots[tidy.project.headCommitId]).toEqual(tidy.snapshots[tidy.project.headCommitId])
  expect(branch.snapshots[branch.project.headCommitId].document.elements.every((el: any) => el.angle === Math.PI / 2)).toBe(true)
  await page.reload()
  await expect(page.getByRole('region', { name: 'Galta canvas, 4 objects', exact: true })).toBeVisible()
  await restoreHistory(page, tidy.project.headCommitId)
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+a')
  await fit(page)
  expect((await workspace(page)).snapshots[tidy.project.headCommitId]).toEqual(tidy.snapshots[tidy.project.headCommitId])
})

test('alignment and distribution use visible image bounds and remain one-step undoable', async ({ page }) => {
  const before = await doc(page)
  await menu(page); await page.getByRole('button', { name: 'Align top', exact: true }).click()
  await expect.poll(async () => new Set((await doc(page)).elements.map((el: any) => el.y)).size).toBe(1)
  await page.getByRole('button', { name: 'Distribute horizontally', exact: true }).click()
  await expect.poll(async () => new Set((await doc(page)).elements.map((el: any) => el.x)).size).toBe(4)
  const after = await doc(page), sorted = [...after.elements].sort((a, b) => a.x - b.x)
  const gaps = sorted.slice(1).map((el, i) => el.x - sorted[i].x - sorted[i].width)
  for (const gap of gaps) expect(gap).toBeCloseTo(12)
  expect(after.files).toEqual(before.files)
  for (const el of after.elements) {
    const old = before.elements.find((item: any) => item.id === el.id)
    expect([el.width, el.height, el.angle, el.fileId]).toEqual([old.width, old.height, old.angle, old.fileId])
  }
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'More selection actions', exact: true })).toBeFocused()
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+z')
  await expect.poll(async () => (await doc(page)).elements.map((el: any) => el.x)).toEqual(before.elements.map((el: any) => el.x))
})

test('photo controls are hit-testable across narrow, short and desktop viewports', async ({ page }) => {
  await page.getByRole('button', { name: 'Tidy', exact: true }).click()
  for (const [width, height] of [[1440, 1000], [1000, 800], [700, 700], [480, 640], [360, 540]]) {
    await page.setViewportSize({ width: width!, height: height! })
    await fit(page)
    await expect(page.locator('.selection-actions')).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      // History is a global action in the topbar; it intentionally shares that
      // region instead of occupying a second, unrelated canvas corner.
      // The zoom trigger is intentionally inside the topbar action group. Test
      // the owning surfaces so the parent/child relationship is not reported
      // as an accidental overlap.
      const selectors = ['.galta-topbar', '.conversation-dock', '.drawing-dock']
      const overlaps: string[] = []
      for (let i = 0; i < selectors.length; i++) for (let j = i + 1; j < selectors.length; j++) {
        const a = document.querySelector(selectors[i]!)!.getBoundingClientRect(), b = document.querySelector(selectors[j]!)!.getBoundingClientRect()
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) overlaps.push(`${selectors[i]} / ${selectors[j]}`)
      }
      return overlaps
    })).toEqual([])
    await expect.poll(() => page.locator('.selection-actions').evaluate(el => {
      const a = el.getBoundingClientRect()
      return ['.galta-topbar', '.conversation-dock', '.drawing-dock'].filter(selector => {
        const b = document.querySelector(selector)!.getBoundingClientRect()
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      })
    })).toEqual([])
    for (const button of await page.locator('.selection-actions-row > button').all()) await reachable(button)
    await menu(page)
    for (const button of await page.locator('.selection-menu button:not([disabled])').all()) await reachable(button)
    await page.keyboard.press('Escape')
    await expect(page.locator('.selection-menu')).toHaveCount(0)
  }
})

test('native viewport handoff keeps content in view and round trips without changing artwork or accumulating zoom', async ({ page }) => {
  await fit(page)
  const clearArea = () => page.evaluate(() => {
    const header = document.querySelector('.galta-topbar')!.getBoundingClientRect(), composer = document.querySelector('.conversation-composer')!.getBoundingClientRect()
    const bounds = document.querySelector('.galta-workspace')!.getBoundingClientRect()
    const left = document.querySelector('.drawing-dock')!.getBoundingClientRect().right - bounds.left + 16, right = 16, top = header.height + 16
    return { left, top, width: bounds.width - left - right, height: bounds.height - composer.height - 48 - top }
  })
  const originalSize = page.viewportSize()!
  await expect.poll(async () => (await workspace(page)).canvasView?.zoom).toBeGreaterThan(0)
  const before = await workspace(page), view = before.canvasView, originalFrame = await clearArea()
  const center = { x: (originalFrame.left + originalFrame.width / 2) / view.zoom - view.scrollX, y: (originalFrame.top + originalFrame.height / 2) / view.zoom - view.scrollY }
  const span = Math.min(originalFrame.width, originalFrame.height) / view.zoom
  const state = new URLSearchParams({ viewport: JSON.stringify({ center, span }), selection: JSON.stringify((await doc(page)).elements.filter((el: any) => !el.isDeleted).map((el: any) => el.id)) })
  await page.setViewportSize({ width: 386, height: 755 })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html?visit=narrow#${state}`)
  await expect(page.getByRole('region', { name: 'Galta canvas, 4 objects', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeEnabled()
  const narrowFrame = await clearArea()
  await expect.poll(async () => (await workspace(page)).canvasView?.zoom).toBeCloseTo(narrowFrame.width / span, 5)
  const narrow = await workspace(page), nv = narrow.canvasView
  expect((narrowFrame.left + narrowFrame.width / 2) / nv.zoom - nv.scrollX).toBeCloseTo(center.x, 3)
  expect((narrowFrame.top + narrowFrame.height / 2) / nv.zoom - nv.scrollY).toBeCloseTo(center.y, 3)
  expect(narrow.snapshots).toEqual(before.snapshots)
  expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).has('viewport')).toBe(false)
  await page.reload()
  await expect(page.getByRole('region', { name: 'Galta canvas, 4 objects', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeEnabled()
  expect((await workspace(page)).canvasView).toEqual(nv)
  await page.setViewportSize({ width: 360, height: 755 })
  const resizedFrame = await clearArea()
  await expect.poll(async () => (await workspace(page)).canvasView?.zoom).toBeCloseTo(resizedFrame.width / span, 5)
  const resizedView = (await workspace(page)).canvasView
  expect((resizedFrame.left + resizedFrame.width / 2) / resizedView.zoom - resizedView.scrollX).toBeCloseTo(center.x, 3)
  expect((resizedFrame.top + resizedFrame.height / 2) / resizedView.zoom - resizedView.scrollY).toBeCloseTo(center.y, 3)
  await page.setViewportSize(originalSize)
  const back = new URLSearchParams({ viewport: JSON.stringify({ center, span: narrowFrame.width / nv.zoom }), selection: state.get('selection')! })
  await page.goto(`${acceptanceOrigin}/canvas/index.html?visit=wide#${back}`)
  await expect(page.getByRole('region', { name: 'Galta canvas, 4 objects', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeEnabled()
  await expect.poll(async () => (await workspace(page)).canvasView?.zoom).toBeCloseTo(view.zoom, 5)
  const restored = await workspace(page)
  expect(restored.canvasView.scrollX).toBeCloseTo(view.scrollX, 3)
  expect(restored.canvasView.scrollY).toBeCloseTo(view.scrollY, 3)
  expect(restored.snapshots).toEqual(before.snapshots)
})
