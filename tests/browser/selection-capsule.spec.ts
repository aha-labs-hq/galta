import { test, expect } from '@playwright/test'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'
import { seedWorkspace, storedWorkspace } from '../helpers/stored-workspace'

test('capsule grouping preserves nested groups, bound text, native undo and deletion recovery', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const bundle = await page.evaluate(async () => {
    const w = window as any
    await w.engineTest.tool('canvas_edit', { revision: w.engineTest.revision(), operations: [
      { type: 'create_element', id: 'card', elementType: 'rectangle', x: 340, y: 220, props: { width: 240, height: 160, groupIds: ['inner', 'outer'] } },
      { type: 'create_text', id: 'caption', x: 360, y: 240, text: 'Stay together', props: { groupIds: ['inner', 'outer'] } },
      { type: 'bind_text', elementId: 'caption', containerId: 'card' },
      { type: 'create_element', id: 'circle', elementType: 'ellipse', x: 620, y: 220, props: { width: 160, height: 160, groupIds: ['outer'] } }
    ] })
    const { createInitialWorkspace, initializeWorkspaceSnapshot } = await import('/canvas/workspace.ts' as string)
    const initial = createInitialWorkspace()
    return initializeWorkspaceSnapshot(initial, initial.project.headCommitId, w.scene.snapshot())
  })
  await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/manifest.json`)
  await seedWorkspace(page, bundle)
  const selection = new URLSearchParams({ selection: JSON.stringify(['card', 'circle']) })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html#${selection}`)
  await expect(page.getByRole('region', { name: 'Galta canvas, 3 objects', exact: true })).toBeVisible()
  const head = async () => { const saved = await storedWorkspace(page); return saved.snapshots[saved.project.headCommitId].document.elements.filter((e: any) => !e.isDeleted) }
  const groups = async () => (await head()).map((e: any) => e.groupIds)
  await expect(page.getByRole('button', { name: 'Style', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'More selection actions', exact: true }).click()
  await page.getByRole('button', { name: 'Ungroup', exact: true }).click()
  await expect.poll(groups).toEqual([['inner'], ['inner'], []])
  await expect(page.getByRole('button', { name: 'Style', exact: true })).toBeFocused()
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+z')
  await expect.poll(groups).toEqual([['inner', 'outer'], ['inner', 'outer'], ['outer']])
  await page.getByRole('button', { name: 'More selection actions', exact: true }).click()
  await page.getByRole('button', { name: 'Ungroup', exact: true }).click()
  await expect.poll(groups).toEqual([['inner'], ['inner'], []])
  await page.getByRole('button', { name: 'More selection actions', exact: true }).click()
  await page.getByRole('button', { name: 'Group selection', exact: true }).click()
  await expect.poll(async () => (await groups()).map((ids: string[]) => ids.length)).toEqual([2, 2, 1])
  const grouped = await head(), group = grouped[0].groupIds.at(-1)
  expect(grouped.every((e: any) => e.groupIds.at(-1) === group)).toBe(true)
  expect(grouped.find((e: any) => e.id === 'caption').containerId).toBe('card')
  expect(grouped.find((e: any) => e.id === 'card').boundElements).toContainEqual({ id: 'caption', type: 'text' })
  await page.getByRole('button', { name: 'More selection actions', exact: true }).click()
  await page.getByRole('button', { name: 'Delete selection', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  await expect(page.locator('.excalidraw')).toBeFocused()
  await page.keyboard.press('Meta+z')
  await expect.poll(async () => (await head()).map((e: any) => [e.id, e.groupIds, e.containerId, e.boundElements])).toEqual(grouped.map((e: any) => [e.id, e.groupIds, e.containerId, e.boundElements]))
})

test('exact programmatic pointers only mark complete groups and PNG includes a selected container’s bound text', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const w = window as any, scene = w.scene
    await w.engineTest.tool('canvas_edit', { revision: w.engineTest.revision(), operations: [
      { type: 'create_element', id: 'card', elementType: 'rectangle', x: 200, y: 200, props: { width: 260, height: 180, strokeColor: '#252525', groupIds: ['inner', 'outer'] } },
      { type: 'create_text', id: 'caption', x: 220, y: 230, text: 'Keep this label', props: { strokeColor: '#ff0000', fontSize: 32, groupIds: ['inner', 'outer'] } },
      { type: 'bind_text', elementId: 'caption', containerId: 'card' },
      { type: 'create_element', id: 'sibling', elementType: 'ellipse', x: 500, y: 200, props: { width: 100, height: 100, groupIds: ['outer'] } }
    ] })
    const select = async (ids: string[]) => {
      scene.select(ids); await new Promise(requestAnimationFrame)
      const state = scene.api.getAppState()
      return { ids: Object.keys(state.selectedElementIds).filter(id => state.selectedElementIds[id]), groups: Object.keys(state.selectedGroupIds).filter(id => state.selectedGroupIds[id]) }
    }
    const whole = await select(['card', 'sibling'])
    const partial = await select(['caption'])
    const container = await select(['card'])
    const { exportSelection } = await import('/canvas/selectionExport.ts' as string)
    const bitmap = await createImageBitmap(await exportSelection(scene))
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close()
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let red = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 200 && pixels[i + 1]! < 30 && pixels[i + 2]! < 30 && pixels[i + 3]! > 100) red++
    return { whole, partial, container, red, cleared: await select([]) }
  })
  expect(result.whole).toEqual({ ids: ['card', 'sibling'], groups: ['outer'] })
  expect(result.partial).toEqual({ ids: ['caption'], groups: [] })
  expect(result.container).toEqual({ ids: ['card'], groups: ['inner'] })
  expect(result.cleared).toEqual({ ids: [], groups: [] })
  expect(result.red, 'the exported container retains its visible red bound label').toBeGreaterThan(100)
})

test('selection Style uses native editing and returns focus at desktop and narrow widths', async ({ page }) => {
  await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.getByRole('button', { name: 'Shapes and more tools' }).click()
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click()
  await page.mouse.move(360, 240); await page.mouse.down(); await page.mouse.move(580, 400, { steps: 12 }); await page.mouse.up()
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+a')
  const color = async () => { const saved = await storedWorkspace(page); return saved.snapshots[saved.project.headCommitId].document.elements[0]?.strokeColor }
  await expect.poll(color).toBeTruthy()
  const original = await color()
  await page.getByRole('button', { name: 'Style', exact: true }).click()
  await page.getByRole('button', { name: 'Stroke Clay', exact: true }).click()
  await expect.poll(color).toBe('#b65f46')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Style', exact: true })).toBeFocused()
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+z')
  await expect.poll(color).toBe(original)
  const directDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export selection', exact: true }).click()
  expect((await directDownload).suggestedFilename()).toBe('galta-selection.png')
  await expect(page.locator('.selection-export')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Export selection', exact: true })).toBeFocused()
  await expect(page.locator('.selection-actions [role=status]')).toHaveText('PNG image download started.')
  await page.setViewportSize({ width: 360, height: 560 })
  await page.getByRole('button', { name: 'Canvas zoom', exact: true }).click()
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Style', exact: true }).click()
  await page.getByRole('textbox', { name: 'Stroke color value', exact: true }).press('Shift+Tab')
  await expect(page.locator('.drawing-style-panel')).toBeVisible()
  const bounds = (await page.locator('.drawing-style-panel').boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(12)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(348)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(548)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Style', exact: true })).toBeFocused()
  const keyboardDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export selection', exact: true }).press('Enter')
  expect((await keyboardDownload).suggestedFilename()).toBe('galta-selection.png')
  await expect(page.getByRole('button', { name: 'Export selection', exact: true })).toBeFocused()
})

test('format choices stay in the same capsule and preserve keyboard context', async ({ page }) => {
  await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.locator('nav input[type=file]').setInputFiles({ name: 'image.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#536760"/></svg>') })
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Export selection', exact: true })).toBeVisible()
  const initialCapsule = (await page.locator('.selection-actions').boundingBox())!
  await page.getByRole('button', { name: 'Export selection', exact: true }).click()
  const exportRow = page.getByRole('group', { name: 'Export formats', exact: true })
  await expect(exportRow, 'pointer opening leaves the first action visually neutral').toBeFocused()
  await expect(page.locator('.selection-popover')).toHaveCount(0)
  await expect.poll(async () => {
    const innerWidth = await page.locator('.selection-actions').evaluate(element => element.clientWidth), content = (await exportRow.boundingBox())!
    return Math.abs(innerWidth - content.width)
  }).toBeLessThan(1)
  const capsule = (await page.locator('.selection-actions').boundingBox())!
  expect(Math.abs(capsule.x + capsule.width / 2 - initialCapsule.x - initialCapsule.width / 2), 'the same shell keeps its center').toBeLessThan(1)
  expect(capsule.y).toBe(initialCapsule.y)
  expect(capsule.height).toBe(initialCapsule.height)
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Back to selection actions', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Original file', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'PNG image', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Export selection', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Export selection', exact: true }).press('Enter')
  await expect(page.getByRole('button', { name: 'Original file', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('button', { name: 'Back to selection actions', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Export selection', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Export selection', exact: true }).press('Enter')
  await page.getByRole('button', { name: 'Canvas zoom', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Export selection', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Fit canvas', exact: true })).toBeVisible()
})

test.describe('Touch selection', () => {
  test.use({ hasTouch: true, viewport: { width: 360, height: 560 } })
  test('the capsule and format chooser remain reachable with full touch targets', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await installReturningAccount(page)
    await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
    await page.locator('nav input[type=file]').setInputFiles({ name: 'touch.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#536760"/></svg>') })
    await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
    await expect(page.locator('.pending-image')).toHaveCount(0)
    for (const button of await page.locator('.selection-actions-row > button').all()) {
      const box = (await button.boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(await button.evaluate(element => { const r = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })).toBe(true)
    }
    await page.getByRole('button', { name: 'Export selection', exact: true }).click()
    const panel = (await page.locator('.selection-export').boundingBox())!
    expect(panel.x).toBeGreaterThanOrEqual(12)
    expect(panel.x + panel.width).toBeLessThanOrEqual(348)
    expect(panel.y + panel.height).toBeLessThanOrEqual(548)
    for (const button of await page.locator('.selection-export button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await expect(page.locator('.selection-actions')).toHaveCSS('transition-duration', '0s')
    await expect(page.locator('.selection-actions-row')).toHaveCSS('animation-name', 'none')
    await page.screenshot({ path: test.info().outputPath('capsule-export.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Export selection', exact: true })).toBeFocused()
    await page.emulateMedia({ forcedColors: 'active' })
    await expect(page.locator('.selection-actions')).toHaveCSS('box-shadow', 'none')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'More selection actions', exact: true })).toHaveCSS('outline-style', 'solid')
  })
})
