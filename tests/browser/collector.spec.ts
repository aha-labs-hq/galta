import { test, expect, type Page } from '@playwright/test'

const state = (page: Page) => page.evaluate(() => (window as any).__galtaCollector.state())
const image = (page: Page, index = 0) => page.locator('.card img').nth(index)
const messages = (page: Page) => page.evaluate(() => (window as any).__collectionMessages)
const clickMark = (page: Page, mark: any) => page.mouse.click(mark.left + mark.width / 2, mark.top + mark.height / 2)

async function moveOverImage(page: Page, index = 0) {
  const r = await image(page, index).boundingBox()
  expect(r).not.toBeNull()
  await page.mouse.move(r!.x + r!.width / 2, r!.y + r!.height / 2)
}

async function hover(page: Page, index = 0) {
  await moveOverImage(page, index)
  await expect.poll(async () => (await state(page)).shown).toBe(true)
  return (await state(page)).markRect
}

function inside(mark: any, media: any) {
  expect(mark.left).toBeGreaterThanOrEqual(Math.max(12, media.left + 12))
  expect(mark.top).toBeGreaterThanOrEqual(Math.max(12, media.top + 12))
  expect(mark.left + mark.width).toBeLessThanOrEqual(media.left + media.width - 12 + .1)
  expect(mark.top + mark.height).toBeLessThanOrEqual(media.top + media.height - 12 + .1)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const fixture = window as any
    fixture.__collectionMessages = []
    fixture.chrome = { runtime: {
      id: 'galta-fixture',
      onMessage: { addListener(listener: any) { fixture.__pageMessage = listener } },
      async sendMessage(message: any) {
        fixture.__collectionMessages.push(structuredClone(message))
        if (fixture.__holdCollection) return new Promise(resolve => { fixture.__finishCollection = resolve })
        return fixture.__failCollection ? { ok: false, error: 'Fixture storage failure' } : { ok: true, item: message.item }
      },
    } }
  })
  await page.goto('/dev/collector.html')
  await expect(image(page)).toBeVisible()
})

/* Serve the real content script at a Pinterest origin, without a production
   option that could override site detection. Network stays on the local Vite
   fixture, while URL-dependent behavior sees the actual page shape. */
async function sourceFixture(page: Page, baseURL: string, destination: string) {
  await page.route(`${new URL(destination).origin}/**`, async route => {
    const url = new URL(route.request().url())
    const local = new URL(url.pathname + url.search, baseURL)
    if (route.request().resourceType() === 'document') local.pathname = '/dev/collector.html'
    await route.fulfill({ response: await page.request.get(local.href) })
  })
  await page.goto(destination)
  await expect(image(page)).toBeVisible()
}

const pinterest = (page: Page, baseURL: string, path: string, layout = 'feed') =>
  sourceFixture(page, baseURL, `https://www.pinterest.com${path}?layout=${layout}`)

/* Match the real failure: a closed shadow button escapes a 0x0 body host.
   An inert viewport host tests the same retargeting with a misleadingly large
   rectangle. Only the test keeps a handle to the inaccessible child. */
async function peerCollector(page: Page, scene: 'card' | 'main', layer: number, viewportHost = false) {
  return page.evaluate(({ scene, layer, viewportHost }) => {
    const media = document.querySelector(scene === 'main' ? '#detail img' : '.card img')!
    const r = media.getBoundingClientRect(), size = scene === 'main' ? 38 : 33.5
    const host = document.createElement('div')
    host.id = 'peer-collector'
    host.style.cssText = viewportHost ? `position:fixed;inset:0;pointer-events:none;z-index:${layer}` : 'display:block;width:0;height:0'
    const root = host.attachShadow({ mode: 'closed' })
    const button = document.createElement('button')
    button.textContent = '✦'
    button.setAttribute('aria-label', 'Other collector')
    button.style.cssText = `position:fixed;left:${scene === 'main' ? r.left + 16 : r.right - size - 54}px;top:${scene === 'main' ? r.top + 16 : r.bottom - size - 13}px;width:${size}px;height:${size}px;border:0;border-radius:50%;background:#212020;color:#fff;pointer-events:auto;z-index:${layer}`
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); (window as any).__peerClicks = ((window as any).__peerClicks ?? 0) + 1 })
    root.append(button)
    document.body.append(host)
    ;(window as any).__peerButton = button
    return { button: button.getBoundingClientRect().toJSON(), host: host.getBoundingClientRect().toJSON(), closed: host.shadowRoot === null }
  }, { scene, layer, viewportHost })
}

for (const layer of [2147479000, 2147483647]) {
  test(`Pinterest cards coexist with a closed shadow collector at layer ${layer}`, async ({ page, baseURL }) => {
    await pinterest(page, baseURL!, '/')
    const peer = await peerCollector(page, 'card', layer)
    expect(peer).toMatchObject({ closed: true, host: { width: 0, height: 0 } })
    const mark = await hover(page)
    inside(mark, (await state(page)).imageRect)
    expect(mark.left + mark.width).toBeLessThanOrEqual(peer.button.left - 12 + .1)
    expect(mark.top + mark.height).toBeCloseTo((await state(page)).imageRect.top + (await state(page)).imageRect.height - 12, 1)
    await page.mouse.click(peer.button.left + peer.button.width / 2, peer.button.top + peer.button.height / 2)
    expect(await page.evaluate(() => (window as any).__peerClicks)).toBe(1)
    expect(await messages(page)).toHaveLength(0)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await clickMark(page, await hover(page))
    await expect.poll(() => messages(page)).toHaveLength(1)
    expect(await page.evaluate(() => (window as any).__peerClicks)).toBe(1)
  })
}

test('detail main image clears a closed viewport collector and the native Back control', async ({ page, baseURL }) => {
  await pinterest(page, baseURL!, '/pin/913175261956120316/', 'detail')
  await page.locator('#detail').evaluate(el => {
    const back = document.createElement('button')
    back.id = 'native-back'
    back.textContent = 'Back'
    back.style.cssText = 'position:absolute;top:7px;left:7px;width:48px;height:48px'
    back.addEventListener('click', () => (window as any).__nativeBack = true)
    el.append(back)
  })
  const peer = await peerCollector(page, 'main', 2147483647, true)
  const main = await page.locator('#detail img').boundingBox()
  await page.mouse.move(main!.x + main!.width / 2, main!.y + main!.height / 2)
  await expect.poll(async () => (await state(page)).shown).toBe(true)
  const mark = (await state(page)).markRect
  expect(mark.left).toBeCloseTo(main!.x + 16, 1)
  expect(mark.top).toBeGreaterThanOrEqual(peer.button.bottom + 16)
  const back = await page.locator('#native-back').boundingBox()
  expect(mark.top).toBeGreaterThanOrEqual(back!.y + back!.height + 16)
  await page.mouse.move(mark.left + mark.width / 2, mark.top + mark.height / 2)
  await expect.poll(() => state(page)).toMatchObject({ shown: true, markRect: mark })
  await page.mouse.click(back!.x + 3, back!.y + 3)
  expect(await page.evaluate(() => (window as any).__nativeBack)).toBe(true)
  expect(await messages(page)).toHaveLength(0)
})

test('a crowded card keeps the peer collector clickable and hides Galta', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 336, height: 797 })
  await pinterest(page, baseURL!, '/')
  const peer = await peerCollector(page, 'card', 2147483647)
  const media = await image(page).boundingBox()
  await page.mouse.move(media!.x + media!.width / 2, media!.y + media!.height / 2)
  await expect.poll(async () => (await state(page)).shown).toBe(false)
  await page.mouse.click(peer.button.left + peer.button.width / 2, peer.button.top + peer.button.height / 2)
  expect(await page.evaluate(() => (window as any).__peerClicks)).toBe(1)
  expect(await messages(page)).toHaveLength(0)
})

test('HTTP source pages submit a stable collection ID and receive their save result', async ({ page, baseURL }) => {
  await sourceFixture(page, baseURL!, 'http://collector.galta.test/images/')
  expect(await page.evaluate(() => isSecureContext)).toBe(false)
  const read = await page.evaluate(() => {
    let response: any
    const fixture = window as any
    fixture.__pageMessage({ type: 'galta-page', tool: 'browser_inspect' }, { id: 'galta-fixture' }, (value: any) => { response = value })
    return response
  })
  expect(read.ok).toBe(true)
  expect(read.result.snapshotId).toContain(`${read.result.documentId}:`)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await clickMark(page, await hover(page))
  await expect.poll(async () => (await messages(page)).length).toBe(1)
  expect((await messages(page))[0].item).toMatchObject({ pageUrl: 'http://collector.galta.test/images/' })
  expect((await messages(page))[0].item.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  await expect.poll(() => state(page)).toMatchObject({ inFlight: false, feedback: 'collected' })
})

test('Pinterest cards use the bottom action row and leave native More clickable', async ({ page, baseURL }) => {
  await pinterest(page, baseURL!, '/')
  const mark = await hover(page)
  const current = await state(page)
  inside(mark, current.imageRect)
  const more = await page.locator('.more').first().boundingBox()
  expect(mark.top + mark.height).toBeCloseTo(current.imageRect.top + current.imageRect.height - 12, 1)
  expect(mark.left + mark.width).toBeLessThanOrEqual(more!.x - 12 + .1)
  await page.locator('.more').first().evaluate(el => el.addEventListener('click', () => (window as any).__nativeMore = true))
  await page.locator('.more').first().click()
  expect(await page.evaluate(() => (window as any).__nativeMore)).toBe(true)
  expect(await messages(page)).toHaveLength(0)
  await hover(page)
  const stable = (await state(page)).markRect
  await page.mouse.move(stable.left + stable.width / 2, stable.top + stable.height / 2)
  await expect.poll(() => state(page)).toMatchObject({ shown: true, markRect: stable })
})

test('board cards retain the bottom corner when the native action row is free', async ({ page, baseURL }) => {
  await pinterest(page, baseURL!, '/ada/project-moodboard/', 'board')
  const mark = await hover(page)
  const media = (await state(page)).imageRect
  expect(mark.left + mark.width).toBeCloseTo(media.left + media.width - 12, 1)
  expect(mark.top + mark.height).toBeCloseTo(media.top + media.height - 12, 1)
})

test('detail main image uses the left edge while its related cards keep the bottom row', async ({ page, baseURL }) => {
  await pinterest(page, baseURL!, '/pin/913175261956120316/', 'detail')
  const main = await page.locator('#detail img').boundingBox()
  await page.mouse.move(main!.x + main!.width / 2, main!.y + main!.height / 2)
  await expect.poll(async () => (await state(page)).shown).toBe(true)
  const mark = (await state(page)).markRect
  expect(mark.left).toBeCloseTo(main!.x + 16, 1)
  expect(mark.top).toBeCloseTo(main!.y + 16, 1)
  await page.locator('#detail').evaluate(el => {
    const back = document.createElement('button')
    back.textContent = 'Back'
    back.style.cssText = 'position:absolute;top:12px;left:12px;width:44px;height:44px'
    el.append(back)
  })
  await page.mouse.move(main!.x + main!.width / 2 + 1, main!.y + main!.height / 2)
  await expect.poll(async () => (await state(page)).markRect?.top).toBeGreaterThanOrEqual(main!.y + 72)
  expect((await state(page)).markRect.left).toBeCloseTo(main!.x + 16, 1)
  const related = await hover(page)
  const relatedImage = (await state(page)).imageRect
  expect(related.top + related.height).toBeCloseTo(relatedImage.top + relatedImage.height - 12, 1)
})

test('108px Pinterest cards offer one usable action, and hide when the row cannot fit it', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 336, height: 800 })
  await pinterest(page, baseURL!, '/')
  const mark = await hover(page)
  const media = (await state(page)).imageRect
  expect(media.width).toBe(108)
  inside(mark, media)
  expect(mark.width).toBe(34)
  await page.locator('.media').first().evaluate(el => {
    const share = document.createElement('button')
    share.textContent = 'Share'
    share.style.cssText = 'position:absolute;bottom:12px;left:12px;width:48px;height:32px'
    el.append(share)
  })
  await page.mouse.move(media.left + media.width / 2 + 1, media.top + media.height / 2)
  await expect.poll(async () => (await state(page)).shown).toBe(false)
})

test('Pinterest bottom placement follows clipping and disappears behind an unrelated dialog', async ({ page, baseURL }) => {
  await pinterest(page, baseURL!, '/')
  await page.evaluate(() => {
    document.querySelectorAll('.card').forEach((card, i) => { if (i) card.remove() })
    document.getElementById('grid')!.style.height = '3000px'
  })
  await hover(page)
  const media = (await state(page)).imageRect
  await page.evaluate(y => window.scrollTo(0, y), media.top - 20)
  await expect.poll(async () => (await state(page)).markRect?.top).toBeCloseTo(20 + media.height - 46, 1)
  const current = await state(page)
  inside(current.markRect, current.imageRect)
  const dialog = current.markRect
  await page.evaluate(box => {
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'dialog')
    overlay.style.cssText = `position:fixed;left:${box.left}px;top:${box.top}px;width:34px;height:34px;z-index:1000000000;background:#444`
    document.body.append(overlay)
    window.dispatchEvent(new Event('resize'))
  }, dialog)
  /* It may move left within the same row, but must never cover the dialog. */
  await expect.poll(async () => {
    const next = await state(page)
    return !next.shown || next.markRect.left + next.markRect.width <= dialog.left - 12
  }).toBe(true)
  await page.evaluate(y => window.scrollTo(0, y), media.top + media.height - 30)
  await expect.poll(async () => (await state(page)).shown).toBe(false)
})

test('activation freezes the current image and Pin provenance before animation and awaits storage', async ({ page, baseURL }) => {
  await pinterest(page, baseURL!, '/search/pins/')
  const mark = await hover(page)
  const clickPage = page.url()
  const rendered = await image(page, 1).getAttribute('src')
  await page.evaluate(url => {
    const fixture = window as any
    fixture.__holdCollection = true
    document.title = 'Page at click'
    const img = document.querySelector<HTMLImageElement>('.card img')!
    img.src = url!
    img.alt = 'Image at click'
    img.closest('a')!.href = '/pin/12345/'
  }, rendered)
  await expect.poll(() => image(page).evaluate(el => (el as HTMLImageElement).currentSrc)).toBe(rendered)
  await clickMark(page, mark)
  await expect.poll(async () => (await messages(page)).length).toBe(1)
  expect(await image(page).evaluate(el => (el as HTMLImageElement).style.visibility)).toBe('hidden')
  const [sent] = await messages(page)
  expect(sent).toMatchObject({ type: 'collection-add', item: {
    mediaUrl: rendered, sourceUrl: 'https://www.pinterest.com/pin/12345/', pageUrl: clickPage,
    title: 'Image at click', pageTitle: 'Page at click',
  } })
  expect(sent.item.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(sent.item).not.toHaveProperty('image')
  await clickMark(page, mark)
  await page.evaluate(() => {
    document.title = 'Page after click'
    const img = document.querySelector<HTMLImageElement>('.card img')!
    img.alt = 'Image after click'
    img.closest('a')!.href = '/pin/99999/'
    history.replaceState({}, '', '/pin/99999/')
  })
  await expect.poll(() => image(page).evaluate(el => (el as HTMLImageElement).style.visibility)).toBe('')
  expect(await state(page)).toMatchObject({ inFlight: true, feedback: null })
  expect(await messages(page)).toEqual([sent])
  await page.evaluate(() => (window as any).__finishCollection({ ok: true }))
  await expect.poll(() => state(page)).toMatchObject({ inFlight: false, feedback: 'collected' })
})

test('a rejected save restores the image, reports failure and allows a fresh click', async ({ page }) => {
  const errors: string[] = []
  page.on('console', message => { if (message.type() === 'error' && message.text().includes('[Galta] Collection failed')) errors.push(message.text()) })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => (window as any).__failCollection = true)
  const mark = await hover(page)
  await clickMark(page, mark)
  await expect.poll(() => state(page)).toMatchObject({ inFlight: false, feedback: 'failed' })
  expect(errors).toHaveLength(1)
  expect(errors[0]).toContain('Fixture storage failure')
  expect(await image(page).evaluate(el => (el as HTMLImageElement).style.visibility)).toBe('')
  const first = (await messages(page))[0]
  await page.evaluate(() => (window as any).__failCollection = false)
  await clickMark(page, await hover(page))
  await expect.poll(() => state(page)).toMatchObject({ inFlight: false, feedback: 'collected' })
  expect(await messages(page)).toHaveLength(2)
  expect((await messages(page))[1].item.id).not.toBe(first.item.id)
})

test('an invalidated runtime stops the old page integration before another collection or drag', async ({ page }) => {
  const logs: string[] = [], errors: string[] = []
  page.on('console', message => { if (message.text().startsWith('[Galta]')) logs.push(message.text()) })
  page.on('pageerror', error => errors.push(error.message))
  await hover(page)
  await page.evaluate(() => { (window as any).chrome.runtime.id = undefined })
  const box = (await image(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2)
  await expect(page.locator('[data-galta-collector]')).toHaveCount(0)
  expect(await state(page)).toMatchObject({ shown: false, listenerCount: 0, inFlight: false, feedback: null })
  const drag = await image(page).evaluate(element => {
    const dataTransfer = new DataTransfer()
    element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
    return dataTransfer.getData('application/x-galta-reference')
  })
  expect(drag).toBe('')
  expect(await messages(page)).toHaveLength(0)
  await moveOverImage(page, 1)
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await expect(page.locator('[data-galta-collector]')).toHaveCount(0)
  expect(logs).toHaveLength(1)
  expect(logs[0]).toContain('Refresh this page')
  expect(errors).toEqual([])
  // A fresh document gets the new extension context and can collect normally.
  await page.reload()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await clickMark(page, await hover(page))
  await expect.poll(() => state(page)).toMatchObject({ inFlight: false, feedback: 'collected' })
})

for (const failure of ['throw', 'reject'] as const) {
  test(`an invalidated collection channel terminates its page surface (${failure})`, async ({ page }) => {
    const errors: string[] = []
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('pageerror', error => errors.push(error.message))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(failure => {
      const fixture = window as any
      fixture.chrome.runtime.sendMessage = (message: any) => {
        fixture.__collectionMessages.push(structuredClone(message))
        const error = new Error('Extension context invalidated.')
        if (failure === 'throw') throw error
        return Promise.reject(error)
      }
    }, failure)
    await clickMark(page, await hover(page))
    await expect(page.locator('[data-galta-collector]')).toHaveCount(0)
    await expect.poll(() => image(page).evaluate(element => (element as HTMLImageElement).style.visibility)).toBe('')
    await moveOverImage(page, 1)
    expect(await state(page)).toMatchObject({ shown: false, listenerCount: 0, inFlight: false, feedback: null })
    expect(await messages(page)).toHaveLength(1)
    expect(errors).toEqual([])
  })
}

test('context invalidation during a save removes the surface and restores the source image', async ({ page }) => {
  const errors: string[] = []
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', error => errors.push(error.message))
  await page.evaluate(() => (window as any).__holdCollection = true)
  await clickMark(page, await hover(page))
  await expect.poll(async () => (await messages(page)).length).toBe(1)
  await page.evaluate(() => {
    const fixture = window as any
    fixture.chrome.runtime.id = undefined
    fixture.__finishCollection({ ok: false, error: 'Extension context invalidated.' })
  })
  await expect(page.locator('[data-galta-collector]')).toHaveCount(0)
  await expect.poll(() => image(page).evaluate(element => (element as HTMLImageElement).style.visibility)).toBe('')
  await moveOverImage(page, 1)
  expect(await state(page)).toMatchObject({ shown: false, listenerCount: 0, inFlight: false, feedback: null })
  expect(await messages(page)).toHaveLength(1)
  expect(errors).toEqual([])
})

test('inline images are not offered and HTTP image drag preserves its provenance', async ({ page }) => {
  const payload = await image(page).evaluate(el => {
    const dataTransfer = new DataTransfer()
    const drag = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer })
    el.dispatchEvent(drag)
    return { image: (el as HTMLImageElement).currentSrc, data: dataTransfer.getData('application/x-galta-reference'), prevented: drag.defaultPrevented }
  })
  expect(JSON.parse(payload.data)).toEqual({ url: payload.image, sourceUrl: 'https://example.com/0' })
  expect(payload.prevented).toBe(false)
  await hover(page)
  await image(page).evaluate(el => (el as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><rect width="220" height="220" fill="gray"/></svg>')
  const box = await image(page).boundingBox()
  await page.mouse.move(box!.x + box!.width / 2 + 1, box!.y + box!.height / 2)
  await expect.poll(async () => (await state(page)).shown).toBe(false)
})

test('stopping during collection keeps its submitted handoff and removes the page surface', async ({ page }) => {
  await page.evaluate(() => (window as any).__holdCollection = true)
  await clickMark(page, await hover(page))
  await expect.poll(async () => (await messages(page)).length).toBe(1)
  await page.evaluate(() => (window as any).__galtaCollector.stop())
  await expect(page.locator('[data-galta-collector]')).toHaveCount(0)
  await page.evaluate(() => (window as any).__finishCollection({ ok: true }))
  await expect.poll(() => image(page).evaluate(el => (el as HTMLImageElement).style.visibility)).toBe('')
  const box = await image(page, 1).boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  expect(await state(page)).toMatchObject({ shown: false, listenerCount: 0, inFlight: false, feedback: null })
  await expect(page.locator('[data-galta-collector]')).toHaveCount(0)
  expect(await messages(page)).toHaveLength(1)
})

test('image-local hover layers keep one mark inside the image and clear of Save', async ({ page }) => {
  await hover(page)
  const current = await state(page)
  inside(current.markRect, current.imageRect)
  const save = await page.locator('.save').first().boundingBox()
  expect(current.markRect.top).toBeGreaterThanOrEqual(save!.y + save!.height + 12)
  await page.mouse.move(current.markRect.left + 17, current.markRect.top + 17)
  await expect.poll(() => state(page)).toMatchObject({ shown: true, markRect: current.markRect })
  await hover(page, 1)
  const next = await state(page)
  expect(next.imageRect).not.toEqual(current.imageRect)
  inside(next.markRect, next.imageRect)
  expect(await page.locator('[data-galta-collector]').count()).toBe(1)
  expect(next.listenerCount).toBe(7)
})

test('scrolling avoids fixed page chrome and hides a card with too little visible space', async ({ page }) => {
  /* Keep the clipping check on one card: a real pointer over a grid may
     correctly select the next image as the original scrolls away. */
  await page.evaluate(() => {
    document.querySelectorAll('.card').forEach((card, i) => { if (i) card.remove() })
    document.getElementById('grid')!.style.height = '3000px'
  })
  await hover(page)
  const initial = await state(page)
  await page.evaluate(y => window.scrollTo(0, y), initial.imageRect.top - 20)
  await expect.poll(async () => (await state(page)).markRect?.top).toBeGreaterThanOrEqual(68)
  const scrolled = await state(page)
  inside(scrolled.markRect, scrolled.imageRect)
  await page.evaluate(y => window.scrollTo(0, y), initial.imageRect.top + initial.imageRect.height - 30)
  await expect.poll(async () => (await state(page)).shown).toBe(false)
})

test('a separate overlay cannot offer an image through a dialog', async ({ page }) => {
  await hover(page)
  const r = await image(page).boundingBox()
  await page.evaluate(box => {
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'dialog')
    overlay.style.cssText = `position:fixed;left:${box!.x}px;top:${box!.y}px;width:${box!.width}px;height:${box!.height}px;z-index:1000000000;background:#444`
    document.body.append(overlay)
  }, r)
  await page.mouse.move(r!.x + r!.width / 2 + 1, r!.y + r!.height / 2)
  await expect.poll(async () => (await state(page)).shown).toBe(false)
})

test('small images and detached cards do not leave a floating action', async ({ page }) => {
  await hover(page)
  await page.evaluate(() => {
    const tiny = document.querySelector<HTMLImageElement>('#tiny img')!
    tiny.style.cssText = 'position:fixed;left:8px;top:70px;width:16px;height:16px'
  })
  await page.mouse.move(16, 78)
  await expect.poll(async () => (await state(page)).shown).toBe(false)
  await hover(page)
  await image(page).evaluate(el => el.remove())
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await expect.poll(async () => (await state(page)).shown).toBe(false)
})

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`collect click finishes and restores the source without following its link (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion })
    const mark = await hover(page)
    const url = page.url()
    await page.mouse.move(mark.left + 17, mark.top + 17)
    await page.mouse.click(mark.left + 17, mark.top + 17)
    await expect.poll(async () => (await state(page)).inFlight).toBe(true)
    if (reducedMotion === 'no-preference') {
      const next = await image(page, 1).boundingBox()
      await page.mouse.move(next!.x + next!.width / 2, next!.y + next!.height / 2)
      const busy = await state(page)
      expect(busy.inFlight).toBe(true)
      expect(busy.imageRect.left).toBe((await image(page).boundingBox())!.x)
    }
    await expect.poll(async () => (await state(page)).inFlight).toBe(false)
    expect(page.url()).toBe(url)
    expect(await image(page).evaluate(el => (el as HTMLImageElement).style.visibility)).toBe('')
  })
}
