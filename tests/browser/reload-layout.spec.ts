import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'

test('a short sidebar can grow its draft and reload without observer errors', async ({ page }) => {
  await installReturningAccount(page)
  await page.addInitScript(() => {
    const errors: string[] = JSON.parse(sessionStorage.getItem('fixture.layout-errors') ?? '[]')
    window.addEventListener('error', event => {
      errors.push(event.message)
      sessionStorage.setItem('fixture.layout-errors', JSON.stringify(errors))
    })
  })
  await page.setViewportSize({ width: 440, height: 1000 })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  const composer = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  const dock = page.getByRole('navigation', { name: 'Galta tools', exact: true })
  await expect(composer).toBeVisible()
  const checkSpace = () => expect.poll(() => page.evaluate(() => {
    const tools = document.querySelector('.drawing-dock')!.getBoundingClientRect()
    const draft = document.querySelector('.conversation-composer')!.getBoundingClientRect()
    return draft.top - tools.bottom
  })).toBeGreaterThanOrEqual(16)
  // What the reader sees, not a pixel threshold: a full toolbar shows every
  // tool whole; a compact one keeps every tool reachable by scrolling.
  const toolbar = () => page.evaluate(() => {
    const dock = document.querySelector<HTMLElement>('.drawing-dock')!, viewport = dock.querySelector<HTMLElement>('.drawing-tools')!
    const box = viewport.getBoundingClientRect()
    const whole = [...viewport.querySelectorAll('button')].every(button => { const b = button.getBoundingClientRect(); return b.top >= box.top - .5 && b.bottom <= box.bottom + .5 })
    return { compact: dock.dataset.overflow === 'true', whole, scrolls: viewport.scrollHeight > viewport.clientHeight + .5 }
  })
  // The composer eases to its new height; read the toolbar once it has settled.
  const settled = () => page.evaluate(async () => {
    await Promise.all(document.querySelector('.conversation-dock')!.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const checkTools = async () => {
    await settled()
    await checkSpace()
    // Two reads a frame apart must agree, so no passing frame is taken for the layout.
    let state = await toolbar(), again = state
    for (let reads = 0; reads < 10; reads++) { state = again; await settled(); again = await toolbar(); if (JSON.stringify(state) === JSON.stringify(again)) break }
    expect(again, 'the toolbar settles').toEqual(state)
    if (state.compact) expect(state.whole || state.scrolls, 'every tool stays reachable').toBe(true)
    else expect(state.whole && !state.scrolls, 'a full toolbar shows every tool whole').toBe(true)
    return state.compact
  }
  // A growing draft must take room from the toolbar somewhere in this sweep,
  // and give it back when cleared; that height is then carried across a reload.
  let flips: number | undefined
  for (const height of [1000, 800, 680, 600, 540, 500, 480, 460, 450, 800, 1000]) {
    await page.setViewportSize({ width: 440, height })
    await composer.fill('Line one\nLine two\nLine three\nLine four')
    const grown = await checkTools()
    await composer.fill('')
    const cleared = await checkTools()
    if (grown && !cleared) flips ??= height
    if (height === 1000) expect(grown || cleared, 'a tall sidebar keeps the full toolbar').toBe(false)
  }
  expect(flips, 'some short sidebar makes a growing draft compact the toolbar').toBeDefined()
  await page.setViewportSize({ width: 440, height: flips! })
  await composer.fill('Line one\nLine two\nLine three\nLine four')
  await expect(dock).toHaveAttribute('data-overflow', 'true')
  await page.reload()
  await expect(composer).toBeVisible()
  await composer.fill('Line one\nLine two\nLine three\nLine four')
  await expect(dock).toHaveAttribute('data-overflow', 'true')
  await checkTools()
  await composer.fill('')
  await expect(dock).toHaveAttribute('data-overflow', 'false')
  await checkTools()
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture.layout-errors') ?? '[]'))).toEqual([])
})

test('a populated sidebar reloads and resizes without observer errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await installReturningAccount(page)
  await page.addInitScript(({ origin }) => {
    const layoutErrors: string[] = JSON.parse(sessionStorage.getItem('fixture.layout-errors') ?? '[]')
    window.addEventListener('error', event => {
      layoutErrors.push(event.message)
      sessionStorage.setItem('fixture.layout-errors', JSON.stringify(layoutErrors))
    })
    const chrome = (window as any).chrome
    chrome.runtime.id = 'galta-test'
    chrome.windows = { getCurrent: async () => ({ id: 1 }) }
    chrome.tabs = { getCurrent: async () => ({ id: 1, windowId: 1 }), onRemoved: { addListener() {}, removeListener() {} } }
    chrome.storage.onChanged = { addListener() {}, removeListener() {} }
    chrome.storage.session = {
      get: async (key: string) => ({ [key]: JSON.parse(sessionStorage.getItem(key) ?? 'null') }),
      set: async (values: Record<string, unknown>) => Object.entries(values).forEach(([key, value]) => sessionStorage.setItem(key, JSON.stringify(value))),
      remove: async (key: string) => sessionStorage.removeItem(key),
    }
    const send = chrome.runtime.sendMessage
    chrome.runtime.sendMessage = async (message: any) => message.type === 'collection-list' ? {
      ok: true, items: Array.from({ length: 7 }, (_, i) => ({
        id: `reference-${i}`, mediaUrl: `${origin}/reload-reference-${i}.png`,
        pageUrl: 'https://www.pinterest.com/', title: `Reference ${i}`, collectedAt: 1000 - i,
      })),
    } : send(message)
  }, { origin: acceptanceOrigin })
  const files = ['glass', 'pink', 'citrus', 'flower']
  await page.route('**/reload-reference-*.png', async route => {
    const index = Number(/reference-(\d+)/.exec(route.request().url())![1])
    await route.fulfill({ contentType: 'image/png', body: await readFile(`tests/fixtures/reference-${files[index % files.length]}.png`) })
  })
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Collection', exact: true }).click()
  const references = page.getByRole('list', { name: 'Collected references', exact: true })
  const arranged = () => expect.poll(() => references.evaluate(gallery => {
    const bounds = gallery.getBoundingClientRect()
    const bottom = Math.max(...[...gallery.children].map(card => card.getBoundingClientRect().bottom)) - bounds.top
    return Math.abs(bounds.height - bottom)
  })).toBeLessThan(1)
  await expect(references.locator('article')).toHaveCount(7)
  await expect.poll(() => references.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true)
  await arranged()
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Keep the light soft.\nLeave more room around the subject.')
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Collection', exact: true }).click()
  await expect(references.locator('article')).toHaveCount(7)
  for (const width of [780, 720, 420, 1000]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(references).toBeVisible()
    await arranged()
  }
  await page.getByRole('button', { name: 'Collection', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture.layout-errors') ?? '[]'))).toEqual([])
  expect(errors).toEqual([])
})
