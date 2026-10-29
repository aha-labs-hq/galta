import { test, expect, type Page } from '@playwright/test'

// The static scene is drawn from world tiles (patches/README.md, "Tiled static
// scene"): bitmap memory must not grow with the element count, and every edit,
// reorder and zoom must show exactly what the document holds.
test.use({ deviceScaleFactor: 2 })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const created: WeakRef<HTMLCanvasElement>[] = []
    ;(window as any).createdCanvases = created
    const original = Document.prototype.createElement
    Document.prototype.createElement = function (this: Document, tag: string, options?: ElementCreationOptions) {
      const element = original.call(this, tag, options)
      if (tag.toLowerCase() === 'canvas') created.push(new WeakRef(element as HTMLCanvasElement))
      return element
    } as typeof Document.prototype.createElement
  })
  await page.goto(process.env.GALTA_SEMANTICS_URL ?? '/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
})

const frames = (page: Page, count = 2) => page.evaluate(count => new Promise<void>(resolve => {
  const step = (left: number) => left ? requestAnimationFrame(() => step(left - 1)) : resolve()
  step(count)
}), count)

/** Megabytes held by every live canvas the page created. */
const bitmapMegabytes = (page: Page) => page.evaluate(() => {
  let pixels = 0
  for (const ref of (window as any).createdCanvases as WeakRef<HTMLCanvasElement>[]) {
    const canvas = ref.deref()
    if (canvas) pixels += canvas.width * canvas.height
  }
  return pixels * 4 / 1048576
})

/** The static canvas colour at a world point, as [r, g, b]. */
const colourAt = (page: Page, x: number, y: number) => page.evaluate(([x, y]) => {
  const state = (window as any).scene.api.getAppState(), scale = state.zoom.value * window.devicePixelRatio
  const canvas = document.querySelector('canvas.excalidraw__canvas.static') as HTMLCanvasElement
  return [...canvas.getContext('2d')!.getImageData(Math.round((x + state.scrollX) * scale), Math.round((y + state.scrollY) * scale), 1, 1).data.slice(0, 3)]
}, [x, y] as const)

const near = (expected: string) => (actual: number[]) => {
  const target = [1, 3, 5].map(i => parseInt(expected.slice(i, i + 2), 16))
  return Math.max(...target.map((value, i) => Math.abs(value - actual[i]))) <= 24
}
const expectColour = (page: Page, x: number, y: number, colour: string) =>
  expect.poll(async () => near(colour)(await colourAt(page, x, y)), { timeout: 3000, intervals: [16, 32, 64, 128] }).toBe(true)
const expectNotColour = (page: Page, x: number, y: number, colour: string) =>
  expect.poll(async () => near(colour)(await colourAt(page, x, y)), { timeout: 3000, intervals: [16, 32, 64, 128] }).toBe(false)

const box = (id: string, x: number, y: number, colour: string) =>
  ({ type: 'create_element', id, elementType: 'rectangle', x, y, props: { width: 200, height: 150, backgroundColor: colour, strokeColor: colour, fillStyle: 'solid', roughness: 0 } })

test('thousands of brush strokes render from bounded bitmap memory, zoomed in or out', { tag: '@serial' }, async ({ page }) => {
  test.setTimeout(120_000)
  const strokes = Array.from({ length: 6000 }, (_, i) => ({
    type: 'create_element', id: `stroke-${i}`, elementType: 'freedraw', x: 100 + (i * 37) % 1000, y: 100 + (i * 53) % 700,
    props: { points: Array.from({ length: 24 }, (_, p) => [p * 3, Math.sin((p + i) / 3) * 12]), strokeColor: '#2f2a26', strokeWidth: 2, simulatePressure: true, pressures: [] }
  }))
  await page.evaluate(strokes => {
    const { engineTest, scene } = window as any
    engineTest.apply(strokes)
    scene.api.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } } })
  }, strokes)
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements.length)).toBe(6000)
  await frames(page, 30)
  // Upstream's per-element bitmaps hold about 1 GB here at this pixel density.
  expect(await bitmapMegabytes(page)).toBeLessThan(160)
  await expectColour(page, 400, 400, '#2f2a26')

  const slowest = await page.evaluate(async () => {
    const api = (window as any).scene.api
    let slowest = 0, last = performance.now()
    for (let i = 0; i < 30; i++) {
      api.updateScene({ appState: { zoom: { value: Math.min(3, api.getAppState().zoom.value * 1.05) } } })
      await new Promise(resolve => requestAnimationFrame(resolve))
      const now = performance.now(); slowest = Math.max(slowest, now - last); last = now
    }
    return slowest
  })
  // Generous guard for shared runners; upstream regenerates every bitmap per step (about 2 s here).
  expect(slowest).toBeLessThan(500)
  await frames(page, 60)
  expect(await bitmapMegabytes(page)).toBeLessThan(240)
  const ink = await page.evaluate(() => {
    const canvas = document.querySelector('canvas.excalidraw__canvas.static') as HTMLCanvasElement
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    let dark = 0
    for (let i = 0; i < data.length; i += 64) if (data[i] < 120 && data[i + 3]) dark++
    return dark
  })
  expect(ink).toBeGreaterThan(1000)
})

test('tiles show every edit, reorder, drag and zoom exactly, without ghosts', async ({ page }) => {
  const apply = (operations: unknown[]) => page.evaluate(operations => { (window as any).engineTest.apply(operations) }, operations)
  await apply([box('a', 100, 100, '#e03131'), box('b', 200, 150, '#1971c2')])
  await page.evaluate(() => (window as any).scene.api.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } } }))
  await expectColour(page, 130, 130, '#e03131')
  await expectColour(page, 250, 200, '#1971c2')

  // Added on top: painted into the tiles it touches within a frame or two.
  await apply([box('c', 600, 100, '#f59f00')])
  await frames(page)
  expect(near('#f59f00')(await colourAt(page, 700, 175))).toBe(true)

  await apply([{ type: 'update_element', elementId: 'a', props: { backgroundColor: '#9c36b5', strokeColor: '#9c36b5' } }])
  await expectColour(page, 130, 130, '#9c36b5')
  await expectColour(page, 250, 200, '#1971c2')

  // Reordered: the overlap follows the document's z-order.
  await page.evaluate(() => {
    const api = (window as any).scene.api, elements = api.getSceneElements()
    api.updateScene({ elements: [...elements.filter((el: any) => el.id !== 'a'), elements.find((el: any) => el.id === 'a')] })
  })
  await expectColour(page, 250, 200, '#9c36b5')

  await apply([{ type: 'delete', elementId: 'b' }])
  await expectNotColour(page, 380, 280, '#1971c2')
  await expectColour(page, 250, 200, '#9c36b5')

  // A drag changes every frame: it is drawn live, and once still it is baked
  // back with nothing left where it started.
  for (let step = 1; step <= 12; step++) {
    await apply([{ type: 'move', elementId: 'c', x: 600 + step * 25, y: 100 + step * 25 }])
    await frames(page, 1)
  }
  expect(near('#f59f00')(await colourAt(page, 1000, 475))).toBe(true)
  await page.waitForTimeout(400)
  await expectNotColour(page, 610, 110, '#f59f00')
  await expectColour(page, 1000, 475, '#f59f00')

  await page.evaluate(() => (window as any).scene.api.updateScene({ appState: { scrollX: -40, scrollY: -60, zoom: { value: 2.5 } } }))
  await expectColour(page, 130, 130, '#9c36b5')
  await expectNotColour(page, 380, 280, '#1971c2')
})

test('an element dragged beneath another stays beneath it in every frame', async ({ page }) => {
  const apply = (operations: unknown[]) => page.evaluate(operations => { (window as any).engineTest.apply(operations) }, operations)
  await apply([box('under', 100, 100, '#e03131'), box('over', 200, 150, '#1971c2')])
  await page.evaluate(() => (window as any).scene.api.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } } }))
  await expectColour(page, 250, 200, '#1971c2')
  for (let step = 1; step <= 10; step++) {
    await apply([{ type: 'move', elementId: 'under', x: 100 + step * 5, y: 100 + step * 3 }])
    await frames(page, 1)
    // The overlap belongs to the upper box whatever the lower one is doing.
    expect(near('#1971c2')(await colourAt(page, 260, 210)), `frame ${step}`).toBe(true)
    expect(near('#e03131')(await colourAt(page, 100 + step * 5 + 20, 100 + step * 3 + 20)), `frame ${step}`).toBe(true)
  }
})
