import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { test, expect } from '@playwright/test'
import { historyWorkspace } from './history-helpers'
import { installCanvasPort, connectCodex, installReturningAccount } from '../helpers/canvas-port'

test('a large selection and a multiline draft keep the composer and conversation usable in a short sidebar', async ({ page }, testInfo) => {
  await installReturningAccount(page)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeVisible()
  const photos = ['pink', 'glass', 'citrus', 'flower']
  await page.locator('nav input[type=file]').setInputFiles(Array.from({ length: 12 }, (_, i) => `tests/fixtures/reference-${photos[i % photos.length]}.png`))
  await expect(page.getByRole('region', { name: 'Galta canvas, 12 objects', exact: true })).toBeVisible()
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await page.locator('.excalidraw').focus()
  await page.keyboard.press('Meta+a')
  await expect(page.getByLabel('12 selected objects', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Compare these photos.\nKeep the warm light.\nKeep the varied shapes.\nPreserve the original photos.\nArrange a quieter composition.')
  for (const size of [{ width: 360, height: 540 }, { width: 480, height: 640 }, { width: 1000, height: 800 }]) {
    await page.setViewportSize(size)
    await page.getByRole('button', { name: 'Canvas zoom', exact: true }).click()
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Fit canvas', exact: true })).toHaveCount(0)
    await expect(page.locator('.selection-actions')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`composer-selection-${size.width}.png`), animations: 'disabled' })
    const header = (await page.locator('.galta-topbar').boundingBox())!
    const dock = (await page.locator('.conversation-dock').boundingBox())!
    expect(dock.y).toBeGreaterThanOrEqual(header.y + header.height + 12)
    expect(dock.y + dock.height).toBeLessThanOrEqual(size.height)
    expect(dock.y + dock.height).toBeCloseTo(size.height, 0)
    const run = page.getByRole('button', { name: 'Send message', exact: true })
    await expect(run).toBeInViewport({ ratio: 1 })
    await expect(run).toBeEnabled()
    await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
    const openDock = (await page.locator('.conversation-dock').boundingBox())!
    expect(openDock.y).toBeGreaterThanOrEqual(header.y + header.height + 12)
    await expect.poll(async () => {
      if (!await page.locator('.selection-actions').count()) return true
      const actions = await page.locator('.selection-actions').boundingBox()
      const conversation = (await page.locator('.conversation-dock').boundingBox())!
      return !actions || actions.y + actions.height + 8 <= conversation.y
    }).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`composer-selection-open-${size.width}.png`), animations: 'disabled' })
    await expect(page.getByRole('button', { name: 'Collapse conversation', exact: true }).first()).toBeInViewport({ ratio: 1 })
    await page.getByRole('button', { name: 'Collapse conversation', exact: true }).first().click()
    await expect(page.locator('.selection-actions')).toBeVisible()
  }
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue(/^Compare these photos\./)
  await expect(page.getByRole('region', { name: 'Galta canvas, 12 objects', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('attached composer owns agent controls without changing the canvas or submitting its draft', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.assign(window, { chrome: { runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      connect: () => ({ onDisconnect: { addListener() {} }, disconnect() {} }),
      sendMessage: async (message: any) => message.type === 'codex-connect'
        ? { ok: true, models: [{ id: 'gpt-an-extremely-long-model-name', displayName: 'GPT a very long model name', supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) }] }
        : { ok: true, result: { thread: { id: 'fixture', turns: [] } } }
    } } })
  })
  await installCanvasPort(page)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect(page.locator('.conversation-dock').getByRole('button', { name: 'Connect an agent', exact: true })).toBeVisible()
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference-glass.png')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect.poll(async () => Object.keys((await historyWorkspace(page)).snapshots).length).toBe(2)
  // Long labels are a stored-workspace fixture, with no mounted editor writing concurrently.
  await page.goto(`${acceptanceOrigin}/composer-fixture`)
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('galta-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('workspaces', 'readwrite'), store = tx.objectStore('workspaces'), read = store.get('default-project')
      read.onsuccess = () => {
        const w = read.result
        w.runtimeDefaults.sessionLabel = 'A very long session about glass, morning light and composition'
        w.agentSessions = [{ id: w.runtimeDefaults.sessionId, label: w.runtimeDefaults.sessionLabel, turns: [] }]
        w.runtimeDefaults.modelId = 'gpt-an-extremely-long-model-name'
        store.put(w)
      }
      tx.oncomplete = () => { db.close(); resolve() }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error) }
    })
  })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await connectCodex(page)
  const draft = 'Keep this draft while I choose the model.'
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill(draft)
  const before = await historyWorkspace(page)
  await expect(page.locator('.galta-topbar .runtime-controls')).toHaveCount(0)
  await expect(page.locator('.conversation-composer .runtime-controls')).toHaveCount(1)
  await expect(page.getByRole('button', { name: /^(Expand|Collapse) tools$/ })).toHaveCount(0)
  await expect(page.locator('.drawing-tools button')).toHaveCount(8)
  await expect(page.locator('.conversation-composer .drawing-tools')).toHaveCount(0)
  const model = page.getByRole('button', { name: /^Model GPT/ })
  for (const size of [{ width: 1440, height: 900 }, { width: 620, height: 700 }, { width: 360, height: 540 }]) {
    await page.setViewportSize(size)
    await expect.poll(() => page.getByRole('textbox', { name: 'Ask Galta' }).evaluate(e => e.scrollHeight <= e.clientHeight)).toBe(true)
    const composer = (await page.locator('.conversation-composer').boundingBox())!
    expect(composer.y + composer.height).toBeCloseTo(size.height, 0)
    expect(await page.locator('.conversation-composer').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true)
    for (const selector of ['.composer-conversation', '.runtime-model', '.composer-submit']) {
      expect(await page.locator(selector).evaluate((element, target) => {
        const r = element.getBoundingClientRect()
        return r.height >= target && r.left >= 0 && r.right <= innerWidth && element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
      }, selector === '.composer-submit' ? 40 : 32), `${selector} must remain reachable at ${size.width}`).toBe(true)
    }
    await page.getByRole('button', { name: 'Draw — P', exact: true }).click()
    const lastTool = page.getByRole('button', { name: 'Drawing style', exact: true })
    await lastTool.scrollIntoViewIfNeeded()
    await lastTool.click()
    await expect(page.getByRole('slider', { name: 'Stroke width' })).toBeVisible()
    await page.keyboard.press('Escape')
    await model.click()
    await expect(page.getByRole('radiogroup', { name: 'Model', exact: true }).getByRole('radio').first()).toBeFocused()
    await expect(page.locator('.runtime-menu .runtime-account .runtime-agent-icon')).toHaveCount(1)
    await expect(page.locator('.runtime-menu .runtime-account .runtime-agent-icon')).toHaveCSS('width', '14px')
    const menu = (await page.locator('.runtime-menu').boundingBox())!
    expect(menu.y + menu.height).toBeLessThanOrEqual(composer.y - 8)
    await page.getByRole('button', { name: /^Effort / }).click()
    await page.getByRole('menuitemradio', { name: 'Medium', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath(`composer-agent-menu-${size.width}.png`), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(model).toBeFocused()
    if (size.width >= 620) {
      await expect(model.locator('.runtime-value')).toHaveText('GPT a very long model name')
      await expect(model.locator('.runtime-effort-value')).toHaveText('Medium')
      expect(await model.locator('.runtime-value, .runtime-effort-value').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth)), 'long model labels and effort must stay fully readable').toBe(true)
    }
    await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toHaveValue(draft)
    await expect(page.locator('.composer-progress')).toHaveCount(0)
  }
  const after = await historyWorkspace(page)
  expect(after.snapshots).toEqual(before.snapshots)
  expect(after.project).toEqual(before.project)
  expect(after.agentSessions).toEqual(before.agentSessions)
  expect(after.runtimeDefaults.effort).toBe('Medium')
  await page.reload()
  await connectCodex(page)
  await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toHaveValue(draft)
  expect(errors).toEqual([])
})

test('the composer keeps sliding from its centered grip, without a footer column', async ({ page }, testInfo) => {
  await installReturningAccount(page)
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  const input = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  await input.fill('Keep the entrance soft.')
  const rail = page.getByRole('slider', { name: 'Move composer', exact: true })
  await expect(rail).toBeVisible()
  const handle = (await rail.boundingBox())!, dock = (await page.locator('.conversation-dock').boundingBox())!
  const tools = (await page.locator('.drawing-dock').boundingBox())!
  const inputBox = (await input.boundingBox())!
  // The grip is centered on the surface edge and owns no layout column, so the
  // gesture stays discoverable without moving the draft or footer groups. Its
  // hit area ends before the input row begins.
  expect(handle.width).toBeGreaterThanOrEqual(32)
  expect(handle.x + handle.width / 2).toBeCloseTo(dock.x + dock.width / 2, 0)
  expect(handle.y).toBeLessThanOrEqual(dock.y + 1)
  expect(handle.y + handle.height).toBeLessThanOrEqual(inputBox.y)
  await page.mouse.move(0, 0)
  await expect(rail.locator('.composer-resize-glyph')).toHaveCSS('opacity', '0.24')
  await expect(page.getByRole('tooltip', { name: 'Drag to move composer', exact: true })).toHaveCount(0)
  await rail.hover()
  await expect(rail.locator('.composer-resize-glyph')).toHaveCSS('opacity', '0.56')
  await expect(page.getByRole('tooltip', { name: 'Drag to move composer', exact: true })).toBeVisible()
  const before = (await page.locator('.conversation-dock').boundingBox())!.x
  await page.mouse.move(0, 0)
  await rail.focus()
  await expect.poll(() => rail.evaluate(element => getComputedStyle(element.querySelector('.composer-resize-glyph')!, '').opacity)).toBe('0.24')
  await expect(page.getByRole('tooltip', { name: 'Drag to move composer', exact: true })).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await page.locator('.conversation-dock').boundingBox())!.x).toBeCloseTo(before + 24, 0)
  await rail.evaluate(element => {
    let capture = false
    Object.assign(element, { setPointerCapture: () => { capture = true }, hasPointerCapture: () => capture, releasePointerCapture: () => { capture = false } })
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 0 }))
  })
  await expect(page.locator('.conversation-dock')).toHaveClass(/is-dragging/)
  await expect(page.locator('.conversation-dock')).toHaveCSS('transition-duration', '0s')
  await rail.evaluate(element => element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 80 })))
  await rail.evaluate(element => element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 80 })))
  await expect(page.locator('.conversation-dock')).not.toHaveClass(/is-dragging/)
  // Chromium serializes the same CSS duration as `0.2s` in computed style.
  await expect(page.locator('.conversation-dock')).toHaveCSS('transition-duration', '0.2s')
  await expect.poll(async () => (await page.locator('.conversation-dock').boundingBox())!.x).toBeGreaterThan(before + 80)
  expect(await page.locator('.drawing-dock').boundingBox(), 'moving the composer does not move the left toolbar').toEqual(tools)
  // The footer is status and actions only; the rail is not a column in it.
  expect(await page.locator('.composer-footer').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(2)
  await page.screenshot({ path: testInfo.outputPath('composer-rail.png'), animations: 'disabled' })
})
