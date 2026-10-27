import { test, expect } from '@playwright/test'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'
import { storedWorkspace } from '../helpers/stored-workspace'

const item = {
  id: 'collection-one',
  mediaUrl: `${acceptanceOrigin}/icons/128.png`,
  sourceUrl: 'https://www.pinterest.com/pin/742179213638774765/',
  pageUrl: 'https://www.pinterest.com/',
  title: 'A quiet study',
  pageTitle: 'Pinterest',
  collectedAt: 1_735_000_000_000,
}
const secondItem = {
  ...item,
  id: 'collection-two',
  mediaUrl: `${acceptanceOrigin}/icons/48.png`,
  title: 'A smaller reference',
  collectedAt: 1_734_999_000_000,
}

async function installCollection(page: Parameters<typeof installReturningAccount>[0], initial = [item, secondItem]) {
  await installReturningAccount(page)
  await page.addInitScript(({ initial }) => {
    const chrome = (window as any).chrome
    chrome.runtime.id = 'galta-test'
    let items = Array.isArray(initial) ? initial : [initial]
    const listeners = new Set<(changes: Record<string, unknown>, area: string) => void>()
    const key = 'galta.collection.v1'
    const emit = (previous: unknown) => {
      const changes = { [key]: { oldValue: previous, newValue: items } }
      listeners.forEach(listener => listener(changes, 'local'))
    }
    const session = new Map<string, unknown>()
    chrome.storage = {
      local: {
        get: async (requested: string | string[] | undefined) => {
          if (requested === 'galta.ai.enabled') return { 'galta.ai.enabled': true }
          if (requested === key || Array.isArray(requested) && requested.includes(key)) return { [key]: items }
          return { [key]: items, 'galta.ai.enabled': true }
        },
        set: async (values: Record<string, unknown>) => {
          if (!(key in values)) return
          const previous = items
          items = Array.isArray(values[key]) ? values[key] : []
          emit(previous)
        },
      },
      session: {
        get: async (requested: string) => ({ [requested]: session.get(requested) }),
        set: async (values: Record<string, unknown>) => { Object.entries(values).forEach(([key, value]) => session.set(key, value)) },
        remove: async (requested: string) => { session.delete(requested) },
      },
      onChanged: {
        addListener: (listener: (changes: Record<string, unknown>, area: string) => void) => listeners.add(listener),
        removeListener: (listener: (changes: Record<string, unknown>, area: string) => void) => listeners.delete(listener),
      },
    }
    chrome.windows = { getCurrent: async () => ({ id: 1 }) }
    chrome.tabs = { getCurrent: async () => ({ id: 1, windowId: 1 }), onRemoved: { addListener() {}, removeListener() {} } }
    const send = chrome.runtime.sendMessage
    chrome.runtime.sendMessage = async (message: any) => {
      if (message.type === 'collection-list') return { ok: true, items }
      if (message.type === 'collection-remove') {
        const previous = items
        items = items.filter((entry: any) => entry.id !== message.id)
        emit(previous)
        return { ok: true, items }
      }
      return send(message)
    }
  }, { initial })
}

test('collection panel retrieves and removes a saved web reference', async ({ page }) => {
  await installCollection(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)

  const trigger = page.getByRole('button', { name: 'Collection', exact: true })
  await expect(trigger).toBeVisible()
  await expect(trigger.getByText('Collection', { exact: true })).toBeVisible()
  await expect(trigger).toHaveAttribute('title', 'Open collection')
  await expect(page.getByRole('heading', { name: /^References/ })).toHaveCount(0)
  const canvas = page.locator('.galta-canvas')
  const closedTriggerBox = (await trigger.boundingBox())!
  const closedBrandBox = (await page.locator('.galta-brand-mark').boundingBox())!
  const closedContextBox = (await page.getByRole('group', { name: 'Current canvas', exact: true }).boundingBox())!
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBe(1440)
  await trigger.click()
  const panel = page.getByRole('complementary', { name: 'Collection', exact: true })
  await expect(panel).toBeVisible()
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(320)
  expect((await panel.boundingBox())!.y, 'the library region reaches the application header').toBe(0)
  expect((await panel.boundingBox())!.height).toBe(1000)
  const search = panel.getByRole('searchbox', { name: 'Search collection', exact: true })
  await expect(search).toBeFocused()
  await expect(search).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  expect((await canvas.boundingBox())!.x).toBe(320)
  expect((await canvas.boundingBox())!.width).toBe(1120)
  const tools = (await page.locator('.drawing-dock').boundingBox())!
  expect(tools.x - (await canvas.boundingBox())!.x, 'the drawing rail keeps its documented inset inside the canvas column').toBe(8)
  const composer = (await page.locator('.conversation-composer').boundingBox())!
  expect(composer.x).toBeGreaterThan(320)
  expect(composer.x + composer.width).toBeLessThan(1440)
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(trigger).toHaveAttribute('title', 'Close collection')
  await expect(trigger.getByText('Collection', { exact: true })).toBeVisible()
  const openTriggerBox = (await trigger.boundingBox())!
  expect(openTriggerBox.x).toBeGreaterThan(closedTriggerBox.x)
  expect(openTriggerBox.x + openTriggerBox.width, 'the toggle belongs to the library edge').toBe(320 - 12)
  expect(openTriggerBox.y).toBe(closedTriggerBox.y)
  expect(await page.locator('.galta-brand-mark').boundingBox(), 'the brand stays in application space').toEqual(closedBrandBox)
  const openContextBox = (await page.getByRole('group', { name: 'Current canvas', exact: true }).boundingBox())!
  expect(openContextBox.x, 'document context begins inside its editing column').toBe(320 + 16)
  expect(openContextBox.y).toBe(closedContextBox.y)
  expect(openContextBox.y).toBe(openTriggerBox.y)
  await expect(panel.getByRole('heading', { name: /^References/ })).toContainText('2')
  await expect(trigger).toHaveAttribute('aria-controls', (await panel.getAttribute('id'))!)
  await expect(page.locator('[aria-label="2 collected references"]')).toHaveCount(1)
  await expect(panel.getByRole('listitem', { name: 'A quiet study', exact: true })).toBeVisible()
  await expect(panel.getByRole('listitem', { name: 'A smaller reference', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Add A quiet study to canvas', exact: true }).focus()
  const referenceActions = panel.getByRole('button', { name: 'Reference actions for A quiet study', exact: true })
  await expect(referenceActions).toHaveCSS('opacity', '1')
  await page.keyboard.press('Tab')
  await expect(referenceActions).toBeFocused()
  await expect(referenceActions).toHaveCSS('color', 'rgb(37, 37, 37)')
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu', { name: 'Reference actions for A quiet study', exact: true })
  await expect(menu.getByRole('menuitem', { name: 'Open source for A quiet study', exact: true })).toHaveAttribute('href', item.sourceUrl)
  await page.keyboard.press('Escape')
  await expect(referenceActions).toBeFocused()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => panel.locator('img').evaluateAll(images => images.filter(image => (image as HTMLImageElement).naturalWidth > 0).length)).toBe(2)

  await panel.getByRole('button', { name: 'Add A quiet study to canvas', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect(page.locator('.pending-image')).toHaveCount(0)

  await panel.getByRole('listitem', { name: 'A smaller reference', exact: true }).dragTo(page.locator('.galta-canvas'))
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  await expect(page.locator('.pending-image')).toHaveCount(0)

  for (const name of ['A quiet study', 'A smaller reference']) {
    await panel.getByRole('listitem', { name, exact: true }).hover()
    await panel.getByRole('button', { name: `Reference actions for ${name}`, exact: true }).click()
    await page.getByRole('menuitem', { name: `Remove ${name}`, exact: true }).click()
    await expect(search).toBeFocused()
  }
  await expect(panel.getByText('Nothing collected yet', { exact: true })).toBeVisible()
  await expect(panel.getByRole('heading', { name: /^References/ })).toContainText('0')
  await trigger.click()
  await expect(trigger).toBeFocused()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBe(1440)
  expect(await trigger.boundingBox()).toEqual(closedTriggerBox)
  expect(await page.getByRole('group', { name: 'Current canvas', exact: true }).boundingBox()).toEqual(closedContextBox)
  await expect(page.getByRole('heading', { name: /^References/ })).toHaveCount(0)
  await expect(page.getByRole('searchbox', { name: 'Search collection', exact: true })).toHaveCount(0)
  await trigger.click()
  await trigger.focus()
  await page.keyboard.press('Escape')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger).toBeFocused()
})

test('collection becomes a page inside a narrow browser side panel and returns after placing a reference', async ({ page }) => {
  await installCollection(page)
  await page.setViewportSize({ width: 360, height: 540 })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)

  const trigger = page.getByRole('button', { name: 'Collection', exact: true })
  const draft = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  await draft.fill('Keep this draft while I find a reference.')
  const triggerBox = await trigger.boundingBox()
  expect(triggerBox).not.toBeNull()
  expect(triggerBox!.x).toBeGreaterThanOrEqual(12)
  expect(triggerBox!.x + triggerBox!.width).toBeLessThanOrEqual(344)
  await trigger.click()
  const panel = page.getByRole('complementary', { name: 'Collection', exact: true })
  await expect(panel).toBeVisible()
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(360)
  const panelBox = await panel.boundingBox()
  expect(panelBox).not.toBeNull()
  expect(panelBox!.width).toBeLessThanOrEqual(360)
  expect(panelBox!.x).toBeGreaterThanOrEqual(0)
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(360)
  expect(panelBox!.y + panelBox!.height).toBe(540)
  await expect(page.locator('.conversation-composer')).toBeHidden()
  await expect(page.locator('.drawing-dock')).toBeHidden()
  await expect(page.locator('.galta-canvas')).toBeHidden()
  await expect(page.getByRole('group', { name: 'Canvas view controls', exact: true })).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Current canvas', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Canvas zoom', exact: true })).toHaveCount(0)
  await expect(page.getByText('Galta', { exact: true })).toBeVisible()
  await expect(trigger.getByText('Collection', { exact: true })).toBeVisible()
  await expect(panel.getByRole('searchbox', { name: 'Search collection', exact: true })).toBeFocused()
  await panel.getByRole('button', { name: 'Add A quiet study to canvas', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(draft).toBeVisible()
  await expect(draft).toHaveValue('Keep this draft while I find a reference.')
  await expect(trigger.getByText('Collection', { exact: true })).toBeVisible()
  await expect(trigger).toBeFocused()
  await expect(page.getByRole('button', { name: 'Canvas zoom', exact: true })).toBeVisible()
})

test('a failed collection import keeps the library page open and retries the same import', async ({ page }) => {
  await installCollection(page)
  await page.setViewportSize({ width: 360, height: 700 })
  await page.route(item.mediaUrl, route => route.fulfill({ status: 404, body: 'Not found' }))
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  const trigger = page.getByRole('button', { name: 'Collection', exact: true })
  await trigger.click()
  const panel = page.getByRole('complementary', { name: 'Collection', exact: true })
  await panel.getByRole('button', { name: 'Add A quiet study to canvas', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('Unable to download image (404)')
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.galta-canvas')).toHaveAttribute('aria-label', 'Galta canvas, 0 objects')
  await page.unroute(item.mediaUrl)
  await panel.getByRole('button', { name: 'Add A quiet study to canvas', exact: true }).click()
  await expect(page.locator('.galta-canvas')).toHaveAttribute('aria-label', 'Galta canvas, 1 objects')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('entering the library page dismisses an open canvas view popover and restores its entry on return', async ({ page }) => {
  await installCollection(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.getByRole('button', { name: 'Collection', exact: true }).click()
  const search = page.getByRole('searchbox', { name: 'Search collection', exact: true })
  await search.fill('quiet')
  const zoom = page.getByRole('button', { name: 'Canvas zoom', exact: true })
  await zoom.click()
  await expect(page.getByRole('button', { name: 'Fit canvas', exact: true })).toBeVisible()

  await page.setViewportSize({ width: 719, height: 700 })
  await expect(page.getByRole('group', { name: 'Canvas view controls', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Fit canvas', exact: true })).toHaveCount(0)
  await expect(page.locator('.galta-canvas')).toBeHidden()
  await expect(search).toHaveValue('quiet')

  await page.setViewportSize({ width: 720, height: 700 })
  await expect(zoom).toBeVisible()
  await expect(page.locator('.galta-canvas')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Fit canvas', exact: true })).toHaveCount(0)
  await zoom.click()
  await expect(page.getByRole('button', { name: 'Fit canvas', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(zoom).toBeFocused()
})

test('closing document portals for the library page releases history before switching canvases', async ({ page }) => {
  await installCollection(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  const projectId = await page.locator('.galta-shell').getAttribute('data-project-id')
  await page.getByRole('button', { name: 'Collection', exact: true }).click()
  await page.getByRole('button', { name: 'Open Time Machine', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Time Machine', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 719, height: 700 })
  await expect(page.getByRole('dialog', { name: 'Time Machine', exact: true })).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Current canvas', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Collection', exact: true }).click()
  await expect(page.locator('.galta-canvas')).toBeVisible()
  await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
  await page.getByRole('button', { name: 'New canvas', exact: true }).click()
  await expect(page.locator('.galta-shell')).not.toHaveAttribute('data-project-id', projectId!)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

for (const [name, selector] of [['Shapes and more tools', '.tool-palette'], ['Drawing style', '.drawing-style-panel']]) {
  test(`the collection page dismisses ${name} and returns to usable left tools`, async ({ page }) => {
    await installCollection(page)
    await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
    const collection = page.getByRole('button', { name: 'Collection', exact: true })
    await collection.click()
    await page.getByRole('button', { name, exact: true }).click()
    await expect(page.locator(selector!)).toBeVisible()
    await page.setViewportSize({ width: 719, height: 700 })
    await expect(page.getByRole('searchbox', { name: 'Search collection', exact: true })).toBeVisible()
    await expect(page.locator(selector!)).toBeHidden()
    await expect(page.getByRole('searchbox', { name: 'Search collection', exact: true })).toBeFocused()
    await collection.click()
    await expect(page.locator('.drawing-dock')).toBeVisible()
    await page.getByRole('button', { name, exact: true }).click()
    await expect(page.locator(selector!)).toBeVisible()
    await expect(page.locator(selector!)).toHaveAttribute('data-side', 'right')
  })
}

test('collection panel searches a thousand references without rendering them all at once', async ({ page }) => {
  const many = Array.from({ length: 1000 }, (_, index) => ({
    id: `collection-${index}`,
    mediaUrl: `${acceptanceOrigin}/icons/48.png?reference=${index}`,
    sourceUrl: `https://www.pinterest.com/pin/${index}/`,
    pageUrl: 'https://www.pinterest.com/',
    title: index === 937 ? 'Needle reference' : `Reference ${index}`,
    pageTitle: 'Pinterest',
    collectedAt: 1_735_000_000_000 - index,
  }))
  await installCollection(page, many)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)

  const trigger = page.getByRole('button', { name: 'Collection', exact: true })
  await expect(trigger).toHaveAttribute('title', 'Open collection')
  await trigger.click()
  const panel = page.getByRole('complementary', { name: 'Collection', exact: true })
  await expect(panel.getByRole('heading', { name: /^References/ })).toContainText('1,000')
  await expect(panel.getByRole('listitem')).toHaveCount(60)
  const search = panel.getByRole('searchbox', { name: 'Search collection', exact: true })
  await expect(search).toBeFocused()
  const firstPositions = await panel.getByRole('listitem').evaluateAll(cards => cards.slice(0, 6).map(card => card.getBoundingClientRect().y))
  // Keep this explicit keyboard action separate from scroll-triggered loading.
  await panel.getByRole('button', { name: 'Show more 940', exact: true }).evaluate(button => button.focus({ preventScroll: true }))
  await page.keyboard.press('Enter')
  await expect(panel.getByRole('listitem')).toHaveCount(120)
  expect(await panel.getByRole('listitem').evaluateAll(cards => cards.slice(0, 6).map(card => card.getBoundingClientRect().y))).toEqual(firstPositions)
  await panel.getByRole('region', { name: 'Collection results', exact: true }).evaluate(region => { region.scrollTop = region.scrollHeight })
  await expect(panel.getByRole('listitem')).toHaveCount(180)

  await search.fill('Needle')
  await expect(panel.getByRole('listitem')).toHaveCount(1)
  await expect(panel.getByRole('listitem', { name: 'Needle reference', exact: true })).toBeVisible()
  await expect(panel.getByText('1 matching references', { exact: true })).toBeVisible()
  await search.press('Escape')
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(search).toHaveValue('Needle')
  await expect(panel.getByRole('listitem', { name: 'Needle reference', exact: true })).toBeVisible()
})

test('collection animates the reserved column and restores the camera and draft on collapse', { tag: '@serial' }, async ({ page }) => {
  await installCollection(page)
  await page.goto(`${acceptanceOrigin}/canvas/index.html`)
  const draft = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  await expect(draft).toBeEnabled()
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference.svg')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await draft.fill('Keep working on this composition.')
  await expect.poll(async () => (await storedWorkspace(page)).canvasView?.zoom).toBeGreaterThan(0)
  const before = await storedWorkspace(page)
  const canvas = page.locator('.galta-canvas')
  const trigger = page.getByRole('button', { name: 'Collection', exact: true })
  // Sample rendered frames, not just a CSS declaration: the editor must
  // actually give up width continuously while the library opens.
  const sampleToggles = (toggleAt = [0]) => page.evaluate(async toggleAt => {
    const trigger = document.querySelector<HTMLButtonElement>('.collection-trigger')!
    const canvas = document.querySelector('.galta-canvas')!
    const header = document.querySelector('.galta-canvas-header')!
    const application = document.querySelector('.galta-application')!
    const toolbar = document.querySelector('.drawing-dock')!
    const tool = toolbar.querySelector('button')!
    const read = () => ({ width: canvas.getBoundingClientRect().width, canvasX: canvas.getBoundingClientRect().x,
      headerX: header.getBoundingClientRect().x, applicationWidth: application.getBoundingClientRect().width,
      toolbarX: toolbar.getBoundingClientRect().x, toolbarWidth: toolbar.getBoundingClientRect().width,
      sameToolbar: document.querySelector('.drawing-dock') === toolbar,
      toolReachable: (() => { const r = tool.getBoundingClientRect(); return tool.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })() })
    const frames = [read()]
    const start = performance.now(), end = start + toggleAt.at(-1)! + 350
    let next = 0
    while (performance.now() < end) {
      if (next < toggleAt.length && performance.now() - start >= toggleAt[next]!) { trigger.click(); next++ }
      await new Promise(requestAnimationFrame)
      frames.push(read())
    }
    return frames
  }, toggleAt)
  const frames = await sampleToggles()
  expect(frames[0]!.width).toBe(1440)
  expect(frames.some(frame => frame.width > 1120 && frame.width < 1440)).toBe(true)
  expect(frames.at(-1)!.width).toBe(1120)
  const checkFrames = (samples: Awaited<ReturnType<typeof sampleToggles>>) => { for (const frame of samples) {
    expect(frame.headerX, 'the header follows the real library boundary on every frame').toBeCloseTo(Math.max(frames[0]!.applicationWidth, frame.canvasX), 1)
    expect(frame.applicationWidth).toBeCloseTo(frame.headerX, 1)
    expect(frame.toolbarX, 'the floating tools retain their canvas clearance throughout collection motion').toBeCloseTo(frame.canvasX + 8, 1)
    expect(frame.toolbarWidth).toBe(40)
    expect(frame.sameToolbar, 'collection motion does not replace the toolbar').toBe(true)
    expect(frame.toolReachable, 'the moving toolbar stays hit-testable').toBe(true)
  } }
  checkFrames(frames)
  const panel = page.getByRole('complementary', { name: 'Collection', exact: true })
  await expect(panel.getByRole('searchbox', { name: 'Search collection', exact: true })).toBeFocused()
  // The working canvas remains usable and the panel stays open.
  await canvas.click({ position: { x: 750, y: 250 } })
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  const closingFrames = await sampleToggles()
  expect(closingFrames.some(frame => frame.width > 1120 && frame.width < 1440)).toBe(true)
  checkFrames(closingFrames)
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBe(1440)
  const reversedFrames = await sampleToggles([0, 65, 130, 195])
  checkFrames(reversedFrames)
  expect(reversedFrames.at(-1)!.width).toBe(1440)
  await expect(draft).toHaveValue('Keep working on this composition.')
  await expect.poll(async () => (await storedWorkspace(page)).canvasView.scrollX).toBeCloseTo(before.canvasView.scrollX, 3)
  const after = await storedWorkspace(page)
  expect(after.canvasView.zoom).toBeCloseTo(before.canvasView.zoom, 5)
  expect(after.canvasView.scrollY).toBeCloseTo(before.canvasView.scrollY, 3)
  expect(after.snapshots).toEqual(before.snapshots)
  await expect(trigger).toBeFocused()
})

test('collection disables motion when requested and keeps the composer inside the reduced workspace', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 980, height: 700 })
  await installCollection(page)
  await page.goto(`${acceptanceOrigin}/canvas/index.html`)
  const trigger = page.getByRole('button', { name: 'Collection', exact: true })
  await expect(trigger).toBeEnabled()
  const draft = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  await draft.fill('Keep this draft.')
  const handle = page.getByRole('slider', { name: 'Move composer', exact: true })
  await handle.focus()
  await page.keyboard.press('End')
  await trigger.click()
  await expect.poll(async () => (await page.locator('.galta-canvas').boundingBox())!.width).toBe(660)
  expect(await page.locator('.collection-layout').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
  await handle.focus()
  await page.keyboard.press('Home')
  const composer = (await page.locator('.conversation-composer').boundingBox())!
  expect(composer.x).toBeGreaterThanOrEqual(320 + 20)
  expect(composer.x + composer.width).toBeLessThanOrEqual(980 - 20)
  await expect(draft).toHaveValue('Keep this draft.')
  await trigger.click()
  await expect.poll(async () => (await page.locator('.galta-canvas').boundingBox())!.width).toBe(980)
})

test('collection and selected artwork occupy separate layout columns', async ({ page }) => {
  const examples = [
    { name: 'glass', title: 'Glass studies' }, { name: 'flower', title: 'Botanical form' },
    { name: 'citrus', title: 'Citrus and shadow' }, { name: 'pink', title: 'Rose light' },
  ]
  const references = Array.from({ length: 12 }, (_, index) => ({
    ...item,
    id: `visual-${index}`,
    mediaUrl: `${acceptanceOrigin}/collection-fixture/${examples[index % 4]!.name}-${index}.png`,
    title: examples[index % 4]!.title,
    collectedAt: item.collectedAt - index,
  }))
  await installCollection(page, references)
  await page.route(`${acceptanceOrigin}/collection-fixture/*.png`, route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1)!.split('-')[0]
    return route.fulfill({ path: `tests/fixtures/reference-${name}.png`, contentType: 'image/png' })
  })
  await page.goto(`${acceptanceOrigin}/canvas/index.html`)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeEnabled()
  await page.locator('nav input[type=file]').setInputFiles(examples.map(example => `tests/fixtures/reference-${example.name}.png`))
  await expect(page.getByRole('region', { name: 'Galta canvas, 4 objects', exact: true })).toBeVisible()
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await page.locator('.excalidraw').focus()
  await page.keyboard.press('Meta+a')
  await page.getByRole('button', { name: 'Tidy', exact: true }).click()
  await page.getByRole('button', { name: 'Collection', exact: true }).click()
  await expect.poll(async () => (await page.locator('.galta-canvas').boundingBox())!.width).toBe(1120)
  const actions = page.getByRole('group', { name: 'Selection actions', exact: true })
  await expect(actions).toBeVisible()
  const toolbar = (await actions.boundingBox())!
  expect(toolbar.x).toBeGreaterThanOrEqual((await page.locator('.drawing-dock').boundingBox())!.x + (await page.locator('.drawing-dock').boundingBox())!.width + 12)
  expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(1440 - 12)
  const images = page.getByRole('complementary', { name: 'Collection', exact: true }).locator('img')
  await expect.poll(() => images.evaluateAll(images => images.filter(image => (image as HTMLImageElement).naturalWidth > 0).length)).toBe(12)
  await expect(images.first()).toHaveCSS('object-fit', 'contain')
  for (const image of await images.all()) {
    const geometry = await image.evaluate(image => {
      const rect = image.getBoundingClientRect(), card = image.closest('article')!.getBoundingClientRect()
      const media = image as HTMLImageElement
      return { widthDifference: Math.abs(rect.width - card.width), heightDifference: Math.abs(rect.height - card.height),
        ratio: rect.height / rect.width, naturalRatio: media.naturalHeight / media.naturalWidth,
        radius: getComputedStyle(image).borderTopLeftRadius, targetRadius: getComputedStyle(image.closest('button')!).borderTopLeftRadius }
    })
    expect(geometry.widthDifference, 'image fills its column').toBeLessThan(1)
    expect(geometry.heightDifference, 'there is no permanent caption row').toBeLessThan(1)
    expect(geometry.ratio, 'image retains its native aspect ratio').toBeCloseTo(geometry.naturalRatio, 2)
    expect(geometry.radius, 'images keep their original square corners').toBe('0px')
    expect(geometry.targetRadius).toBe('0px')
  }
  const masonry = await images.evaluateAll(images => images.map(image => {
    const rect = image.getBoundingClientRect(), gallery = image.closest('.collection-gallery')!.getBoundingClientRect()
    return { x: rect.x - gallery.x, y: rect.y - gallery.y, width: rect.width, height: rect.height }
  }))
  const columnHeights = [0, 0]
  for (const rect of masonry) {
    const column = columnHeights.indexOf(Math.min(...columnHeights))
    expect(rect.x).toBeCloseTo(column * (rect.width + 12), 1)
    expect(rect.y).toBeCloseTo(columnHeights[column]!, 1)
    columnHeights[column]! += rect.height + 12
  }
  expect(masonry[2]!.y).not.toBe(masonry[3]!.y)
  await page.locator('.galta-canvas').click({ position: { x: 1040, y: 240 } })
  await expect(actions).toHaveCount(0)
  const firstReference = page.getByRole('listitem', { name: 'Glass studies', exact: true }).first()
  const more = firstReference.getByRole('button', { name: 'Reference actions for Glass studies', exact: true })
  await page.mouse.move(700, 100)
  await expect(firstReference.locator('.collection-description')).toHaveCSS('opacity', '0')
  await firstReference.hover()
  await expect(firstReference.locator('.collection-description')).toHaveCSS('opacity', '1')
  await expect(more).toBeVisible()
  const moreBox = (await more.boundingBox())!, imageBox = (await firstReference.locator('img').boundingBox())!
  expect(moreBox.y).toBeGreaterThanOrEqual(imageBox.y)
  expect(moreBox.y + moreBox.height).toBeLessThanOrEqual(imageBox.y + imageBox.height)
  await more.click()
  const sourceMenu = page.getByRole('menu', { name: 'Reference actions for Glass studies', exact: true })
  await expect(sourceMenu).toBeVisible()
  const menuBox = (await sourceMenu.boundingBox())!
  expect(menuBox.x).toBeGreaterThanOrEqual(8)
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(1440 - 8)
  await page.keyboard.press('Escape')
  await page.locator('.galta-canvas').click({ position: { x: 1040, y: 240 } })
  await page.mouse.move(700, 100)
  await expect(firstReference.locator('.collection-details')).toHaveCSS('opacity', '0')
  await page.setViewportSize({ width: 360, height: 750 })
  await expect.poll(async () => (await page.getByRole('complementary', { name: 'Collection', exact: true }).boundingBox())!.width).toBe(360)
  await expect(page.getByRole('group', { name: 'Canvas view controls', exact: true })).toHaveCount(0)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(page.getByRole('button', { name: 'Canvas zoom', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Collection', exact: true }).click()
  await expect.poll(async () => (await page.locator('.galta-canvas').boundingBox())!.width).toBe(1440)
  await page.locator('.galta-canvas').click({ position: { x: 1000, y: 180 } })
  await page.mouse.move(700, 100)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  // Opening and closing animate the layout's shared inset, opacity and transform.
  for (const state of ['opening', 'closing']) {
    const transitions = await page.evaluate(async () => {
      document.querySelector<HTMLButtonElement>('.collection-trigger')!.click()
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
      return document.querySelector('.collection-layout')!.getAnimations({ subtree: true })
        .filter(animation => animation instanceof CSSTransition && ['--collection-inset', 'opacity', 'transform'].includes(animation.transitionProperty)).length
    })
    expect(transitions).toBeGreaterThan(0)
    await expect.poll(async () => (await page.locator('.galta-canvas').boundingBox())!.width).toBe(state === 'opening' ? 1120 : 1440)
  }
})
