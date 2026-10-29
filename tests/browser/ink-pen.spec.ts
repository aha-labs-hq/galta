import { test, expect, type Browser, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

import { brushStrokes } from '../helpers/brush-workload'

// The ink pen lands an edit's new work in turn (docs/design/canvas-reveal-and-grouping.md).
// Everything here is read from what the user sees: the pen has no layer of its
// own. Pixel equality is judged from screenshots, never from reading the canvas
// back: Chromium moves a canvas that is read back often to software rendering,
// which would make the test measure a renderer the user never sees.

/** A straight stroke `length` long, left to right, as an agent writes one. */
const line = (id: string, x: number, y: number, length = 600) => ({
  type: 'create_element', id, elementType: 'freedraw', x, y,
  props: { points: Array.from({ length: length / 2 + 1 }, (_, p) => [p * 2, 0]), strokeColor: '#39332e', strokeWidth: 2, simulatePressure: true, pressures: [] }
})

async function open(page: Page) {
  await page.goto(process.env.GALTA_SEMANTICS_URL ?? '/dev/scene-test.html')
  await page.waitForFunction(() => !!(window as any).engineTest)
  await page.evaluate(() => {
    const w = window as any
    w.tiles = () => document.querySelector('.excalidraw__canvas.static') as HTMLCanvasElement
    const device = (x: number, y: number) => {
      const s = w.scene.api.getAppState(), k = w.tiles().width / s.width * s.zoom.value
      return [Math.round((x + s.scrollX) * k), Math.round((y + s.scrollY) * k), k]
    }
    /** The strongest alpha around a world point. */
    w.ink = (x: number, y: number) => {
      const [px, py] = device(x, y), data = w.tiles().getContext('2d')!.getImageData(px! - 1, py! - 1, 3, 3).data
      let alpha = 0
      for (let i = 3; i < data.length; i += 4) alpha = Math.max(alpha, data[i]!)
      return alpha
    }
    /** Every pixel of a world rectangle, RGBA. */
    w.region = (x: number, y: number, width: number, height: number) => {
      const [px, py, k] = device(x, y)
      return w.tiles().getContext('2d')!.getImageData(px, py, Math.round(width * k!), Math.round(height * k!)).data as Uint8ClampedArray
    }
    w.frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    w.edit = (operations: unknown[], scope?: unknown) => w.engineTest.tool('canvas_edit', { revision: w.engineTest.revision(), operations }, scope)
  })
}

/** A fresh page at `scale` device pixels per CSS pixel, ready to edit. */
async function openAt(browser: Browser, scale: number) {
  const context = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  await open(page)
  return page
}

/** How two screenshots differ: pixels whose largest channel difference exceeds
 * each level, against the pixels inked in `b`; and how much ink each holds
 * (darkness summed over the image), which antialiasing moves but does not change. */
const difference = (page: Page, a: Buffer, b: Buffer) => page.evaluate(async ([a, b]) => {
  const pixels = async (png: string) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob())
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    return context.getImageData(0, 0, bitmap.width, bitmap.height).data
  }
  const x = await pixels(a!), y = await pixels(b!), over = { 8: 0, 32: 0, 64: 0 }
  let inked = 0, inkA = 0, inkB = 0
  for (let i = 0; i < x.length; i += 4) {
    const d = Math.max(Math.abs(x[i]! - y[i]!), Math.abs(x[i + 1]! - y[i + 1]!), Math.abs(x[i + 2]! - y[i + 2]!))
    for (const level of [8, 32, 64] as const) if (d > level) over[level]++
    if (y[i]! < 230) inked++
    inkA += 255 - x[i]!; inkB += 255 - y[i]!
  }
  return { inked, over8: over[8], over32: over[32], over64: over[64], ink: Math.abs(inkA - inkB) / inkB }
}, [a.toString('base64'), b.toString('base64')])

test.describe('the ink pen', { tag: '@serial' }, () => {
  test.beforeEach(async ({ page }) => { await open(page) })

  test('an edit’s stroke grows from its first point to its last, and what is drawn never blinks', async ({ page }) => {
    const { committed, frames } = await page.evaluate(async op => {
      const w = window as any, frames: number[][] = []
      let sampling = true
      const sample = () => { frames.push([w.ink(104, 300), w.ink(400, 300), w.ink(696, 300)]); if (sampling) requestAnimationFrame(sample) }
      await w.edit([op])
      const committed = w.scene.elements.some((el: any) => el.id === 'pen-line')
      sample()
      await new Promise(resolve => setTimeout(resolve, 2000))
      sampling = false
      return { committed, frames }
    }, line('pen-line', 100, 300))
    // The document holds the stroke as soon as the edit returns; only its pixels wait.
    expect(committed).toBe(true)
    expect(frames[0]![2]).toBe(0)
    const reached = [0, 1, 2].map(i => frames.findIndex(f => f[i]! > 128))
    expect(reached[0]).toBeGreaterThanOrEqual(0)
    expect(reached[1]).toBeGreaterThan(reached[0]!)
    expect(reached[2]).toBeGreaterThan(reached[1]!)
    // About a second at a hand's pace for 600 px.
    expect(reached[2]! - reached[0]!).toBeGreaterThan(20)
    reached.forEach((from, i) => { for (const f of frames.slice(from)) expect(f[i]).toBeGreaterThan(128) })
  })

  for (const scale of [1, 2]) for (const [points, simulatePressure] of [[300, true], [28000, false], [280000, true]] as const) {
    test(`ink behind the pen never changes again, through the hand-off: ${scale}x, ${points} points, ${simulatePressure ? 'simulated' : 'recorded'} pressure`, async ({ browser }, info) => {
      const page = await openAt(browser, scale)
      await page.evaluate(async ({ points, simulatePressure }) => {
        const path = Array.from({ length: points }, (_, i) => [i * 1000 / points, Math.sin(i * 93.3 / points) * 55])
        const props = { points: path, strokeColor: '#39332e', strokeWidth: 2, opacity: 45, simulatePressure,
          pressures: simulatePressure ? [] : path.map((_, i) => .45 + Math.sin(i * 40 / points) * .2) }
        await (window as any).edit([{ type: 'create_element', id: 'behind', elementType: 'freedraw', x: 40, y: 200, props }])
      }, { points, simulatePressure })
      // The curve is about 3,600 px long, six seconds at a hand's pace. Its
      // first 300 px across, which no later part crosses, is behind the pen
      // from about 4 s; the hand-off comes at about 6 s.
      const clip = { x: 40, y: 130, width: 300, height: 140 }
      await page.waitForTimeout(4500)
      const drawing = await page.screenshot({ clip })
      await page.waitForTimeout(3000)
      const settled = await page.screenshot({ clip })
      const result = await difference(page, drawing, settled)
      await info.attach('behind-the-pen', { body: JSON.stringify(result), contentType: 'application/json' })
      expect(result.inked).toBeGreaterThan(1000)
      // The presented stroke and the tiles are one renderer on one pixel grid.
      expect(result.over8).toBeLessThanOrEqual(result.inked / 1000)
      await page.context().close()
    })
  }

  test('settled work is what a complete render of the document shows', async ({ page }, info) => {
    const operations = Array.from({ length: 1800 }, (_, i) => ({
      type: 'create_element', id: `shading-${i}`, elementType: 'freedraw',
      x: 150 + (i % 30) * 2.3, y: 160 + Math.floor(i / 30) * 1.7,
      props: { points: Array.from({ length: 36 }, (_, p) => [p * 3.7, Math.sin(p / 7 + i / 11) * 35]),
        strokeWidth: .07 + (i % 4) * .03, strokeColor: '#39332e', opacity: 30 + i % 40,
        simulatePressure: false, pressures: Array.from({ length: 36 }, (_, p) => .25 + Math.sin(p / 12) * .2) }
    }))
    await page.evaluate(async operations => { await (window as any).edit(operations) }, operations)
    await page.waitForTimeout(7000)
    const clip = { x: 100, y: 100, width: 400, height: 260 }
    const landed = await page.screenshot({ clip })
    const unchanged = await page.evaluate(() => {
      const w = window as any, before = JSON.stringify(w.scene.elements)
      w.scene.restore(w.scene.snapshot())
      return JSON.stringify(w.scene.elements) === before
    })
    await page.waitForTimeout(2500)
    const result = await difference(page, landed, await page.screenshot({ clip }))
    await info.attach('settled-versus-restore', { body: JSON.stringify(result), contentType: 'application/json' })
    expect(unchanged).toBe(true)
    expect(result.inked).toBeGreaterThan(10000)
    // A GPU canvas antialiases overlapping translucent strokes by how many it
    // paints in one pass, so even two complete renders on machines of different
    // speed differ slightly; the pen bakes in batches to stay within that
    // (patches/README.md). A missing or doubled stroke changes the ink by far more.
    expect(result.ink).toBeLessThan(.01)
    expect(result.over64).toBeLessThanOrEqual(result.inked / 1000)
  })

  test('a hand on the canvas lands everything at once, without a blank frame', async ({ page }) => {
    await page.evaluate(async operations => { await (window as any).edit(operations) }, brushStrokes)
    await page.waitForTimeout(300)
    // The last stroke in view: row 6, column 9; its end is at (1032.5, 703.3).
    expect(await page.evaluate(() => (window as any).ink(1032, 703))).toBe(0)
    const drawn = await page.evaluate(() => (window as any).ink(186, 220))
    await page.mouse.click(20, 20)
    const frames = await page.evaluate(async () => {
      const w = window as any, frames: number[][] = []
      for (let i = 0; i < 4; i++) { await new Promise(resolve => requestAnimationFrame(resolve)); frames.push([w.ink(186, 220), w.ink(1032, 703)]) }
      return frames
    })
    expect(drawn).toBeGreaterThan(128)
    for (const f of frames) expect(f[0]).toBeGreaterThan(128)
    expect(frames.at(-1)![1]).toBeGreaterThan(128)
  })

  test('a later edit lands after the earlier one instead of replacing it', async ({ page }) => {
    const frames = await page.evaluate(async ([a, b]) => {
      const w = window as any, frames: { aEnd: number; bStart: number }[] = []
      let sampling = true
      const sample = () => { frames.push({ aEnd: w.ink(696, 200), bStart: w.ink(104, 400) }); if (sampling) requestAnimationFrame(sample) }
      await w.edit([a])
      sample()
      await w.edit([b])
      await new Promise(resolve => setTimeout(resolve, 3000))
      sampling = false
      return frames
    }, [line('pen-a', 100, 200), line('pen-b', 100, 400)])
    const aLanded = frames.findIndex(f => f.aEnd > 128), bStarted = frames.findIndex(f => f.bStart > 128)
    expect(aLanded).toBeGreaterThan(10)
    expect(bStarted).toBeGreaterThanOrEqual(aLanded)
  })

  test('within an edit, strokes are drawn first and the label above them lands after', async ({ page }) => {
    const frames = await page.evaluate(async ops => {
      const w = window as any, frames: { stroke: number; label: number }[] = []
      let sampling = true
      const label = () => { const data = w.region(100, 330, 80, 30); let alpha = 0; for (let i = 3; i < data.length; i += 4) alpha = Math.max(alpha, data[i]); return alpha }
      const sample = () => { frames.push({ stroke: w.ink(696, 300), label: label() }); if (sampling) requestAnimationFrame(sample) }
      await w.edit(ops)
      sample()
      await new Promise(resolve => setTimeout(resolve, 2500))
      sampling = false
      return frames
    }, [line('mixed-line', 100, 300), { type: 'create_text', id: 'mixed-label', text: 'Label', x: 100, y: 330 }])
    const stroked = frames.findIndex(f => f.stroke > 128), labelled = frames.findIndex(f => f.label > 128)
    expect(stroked).toBeGreaterThan(10)
    expect(labelled).toBeGreaterThanOrEqual(stroked)
  })

  test('a shape a later edit lays over queued ink lands after it, in native stacking', async ({ page }) => {
    const result = await page.evaluate(async ([first, cover]) => {
      const w = window as any
      await w.edit([first])
      await new Promise(resolve => setTimeout(resolve, 150))
      await w.edit([cover])
      await w.frame()
      const waiting = w.ink(1000, 350)
      await new Promise(resolve => setTimeout(resolve, 2500))
      await w.frame()
      return { waiting, covered: [...w.region(200, 300, 1, 1)], cover: w.ink(1000, 350) }
    }, [line('covered', 100, 300, 1000), { type: 'create_element', id: 'cover', elementType: 'rectangle', x: 80, y: 260,
      props: { width: 1050, height: 200, backgroundColor: '#ffffff', strokeColor: '#ffffff', fillStyle: 'solid', roughness: 0 } }])
    expect(result.waiting).toBe(0)
    expect(result.cover).toBe(255)
    expect(result.covered).toEqual([255, 255, 255, 255])
  })

  test('presented ink follows the camera while it is drawn', async ({ page }) => {
    const result = await page.evaluate(async op => {
      const w = window as any, api = w.scene.api, frames: number[] = []
      await w.edit([op])
      await new Promise(resolve => setTimeout(resolve, 400))
      const before = w.ink(104, 300)
      api.updateScene({ appState: { scrollX: api.getAppState().scrollX + 120, scrollY: api.getAppState().scrollY + 60, zoom: { value: .75 } } })
      for (let i = 0; i < 20; i++) { await new Promise(resolve => requestAnimationFrame(resolve)); frames.push(w.ink(104, 300)) }
      return { before, frames, end: w.ink(1096, 300) }
    }, line('camera', 100, 300, 1000))
    expect(result.before).toBeGreaterThan(128)
    for (const alpha of result.frames) expect(alpha).toBeGreaterThan(64)
    expect(result.end).toBe(0)
  })

  test('undoing while the pen draws leaves nothing behind', async ({ page }) => {
    await page.evaluate(async ops => { await (window as any).edit(ops) }, [line('undo-a', 100, 200), line('undo-b', 100, 300), line('undo-c', 100, 400)])
    await page.waitForTimeout(200)
    await page.locator('.excalidraw').focus()
    await page.keyboard.press('Meta+z')
    await expect.poll(() => page.evaluate(() => (window as any).scene.elements.filter((el: any) => el.id.startsWith('undo-')).length)).toBe(0)
    await expect.poll(() => page.evaluate(() => [104, 696].flatMap(x => [200, 300, 400].map(y => (window as any).ink(x, y))).every(alpha => alpha === 0))).toBe(true)
  })

  test('another kind of apply lands everything at once', async ({ page }) => {
    const result = await page.evaluate(async op => {
      const w = window as any
      await w.edit([op])
      await new Promise(resolve => setTimeout(resolve, 200))
      const before = w.ink(1096, 300)
      w.engineTest.apply([{ type: 'create_text', id: 'elsewhere', text: 'Elsewhere', x: 40, y: 40 }])
      await w.frame()
      return { before, after: w.ink(1096, 300) }
    }, line('applied', 100, 300, 1000))
    expect(result.before).toBe(0)
    expect(result.after).toBeGreaterThan(128)
  })

  test('fifteen hundred strokes keep their catch-up deadline when a later edit joins', async ({ page }, info) => {
    const operations = Array.from({ length: 1500 }, (_, i) => line(`many-${i}`, 50 + (i % 10) * 120, 100 + Math.floor(i / 10) * 3.5, 100))
    const result = await page.evaluate(async ({ operations, extra }) => {
      const w = window as any, frames: number[] = []
      let previous = performance.now(), sampling = true
      const tick = () => { const now = performance.now(); frames.push(now - previous); previous = now; if (sampling) requestAnimationFrame(tick) }
      const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
      await w.edit(operations)
      const committed = performance.now()
      requestAnimationFrame(tick)
      await wait(3000)
      await w.edit([extra])
      // Read pixels only after timing: a canvas read back every frame is slower.
      await wait(committed + 5000 - performance.now())
      sampling = false
      const midway = [w.ink(1228, 621.5), w.ink(1348, 700)]
      await wait(committed + 6800 - performance.now())
      frames.sort((a, b) => a - b)
      return { p95: frames[Math.floor(frames.length * .95)]!, frames: frames.length, midway, landed: [w.ink(1228, 621.5), w.ink(1348, 700)] }
    }, { operations, extra: line('late', 1300, 700, 50) })
    await info.attach('performance', { body: JSON.stringify(result), contentType: 'application/json' })
    // At a hand's pace these take over five minutes; the budget is six seconds,
    // and the later edit lands after them without delaying them.
    expect(result.midway).toEqual([0, 0])
    for (const alpha of result.landed) expect(alpha).toBeGreaterThan(128)
    // Generous regression guard for shared runners, not a frame-rate promise.
    expect(result.p95).toBeLessThan(50)
  })

  test('stopping, hiding and reduced motion land committed work; a failed save shows none', async ({ page }) => {
    await page.evaluate(async op => {
      const w = window as any
      w.penAbort = new AbortController()
      await w.edit([op], { signal: w.penAbort.signal })
    }, line('stopped', 100, 200, 1000))
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => (window as any).ink(1096, 200))).toBe(0)
    await page.evaluate(() => (window as any).penAbort.abort())
    await page.evaluate(() => (window as any).frame())
    expect(await page.evaluate(() => (window as any).ink(1096, 200))).toBeGreaterThan(128)

    await page.evaluate(async op => { await (window as any).edit([op]) }, line('motion-change', 100, 300, 1000))
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => (window as any).ink(1096, 300))).toBe(0)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => page.evaluate(() => (window as any).ink(1096, 300))).toBeGreaterThan(128)
    await page.emulateMedia({ reducedMotion: 'no-preference' })

    await page.evaluate(async op => {
      const w = window as any
      await w.edit([op])
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    }, line('hidden', 100, 400, 1000))
    await page.evaluate(() => (window as any).frame())
    expect(await page.evaluate(() => (window as any).ink(1096, 400))).toBeGreaterThan(128)

    const failed = await page.evaluate(async op => {
      const w = window as any
      delete (document as any).hidden
      w.failSave = true
      try { await w.edit([op]) } catch {}
      await w.frame()
      return { exists: w.scene.elements.some((el: any) => el.id === op.id), pixel: w.ink(104, 600) }
    }, line('unsaved', 100, 600))
    expect(failed).toEqual({ exists: false, pixel: 0 })
  })

  test('reduced motion shows an edit’s strokes as they are committed', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const shown = await page.evaluate(async op => {
      const w = window as any
      await w.edit([op])
      await w.frame()
      return w.ink(696, 300)
    }, line('still-line', 100, 300))
    expect(shown).toBeGreaterThan(128)
  })
})

// Private artwork stays outside the repository; supply generated canvas_edit
// operations to replay the same renderer without opening a live workspace.
test('external brush workload replays within the ink budget @serial', async ({ page }, info) => {
  test.skip(!process.env.GALTA_INK_REPLAY, 'Set GALTA_INK_REPLAY to a local operations JSON file')
  const operations = JSON.parse(readFileSync(process.env.GALTA_INK_REPLAY!, 'utf8'))
  await page.addInitScript(() => {
    const canvases: WeakRef<HTMLCanvasElement>[] = [], create = Document.prototype.createElement
    ;(window as any).replayCanvases = canvases
    Document.prototype.createElement = function(this: Document, tag: string, options?: ElementCreationOptions) {
      const element = create.call(this, tag, options)
      if (tag.toLowerCase() === 'canvas') canvases.push(new WeakRef(element as HTMLCanvasElement))
      return element
    } as typeof Document.prototype.createElement
  })
  await open(page)
  const metrics = await page.evaluate(async operations => {
    const w = window as any
    const gaps: number[] = []
    await w.edit(operations)
    const committed = performance.now(); let previous = committed
    // Time frames alone: reading back a retina canvas every frame would be measured too.
    do {
      await new Promise(resolve => requestAnimationFrame(resolve))
      const now = performance.now(); gaps.push(now - previous); previous = now
    } while (performance.now() - committed < 6500)
    gaps.sort((a, b) => a - b)
    return { elapsed: performance.now() - committed, p95: gaps[Math.floor(gaps.length * .95)], max: gaps.at(-1), frames: gaps.length, count: w.scene.elements.length }
  }, operations)
  const landed = await page.screenshot({ path: info.outputPath('replay-settled.png') })
  const unchanged = await page.evaluate(() => {
    const w = window as any, before = JSON.stringify(w.scene.elements)
    w.scene.restore(w.scene.snapshot())
    return JSON.stringify(w.scene.elements) === before
  })
  await page.waitForTimeout(4000)
  const settled = await difference(page, landed, await page.screenshot())
  await info.attach('replay-metrics', { body: JSON.stringify({ ...metrics, unchanged, settled }), contentType: 'application/json' })
  expect(metrics.frames).toBeGreaterThan(20)
  expect(metrics.p95).toBeLessThan(80)
  expect(metrics.count).toBe(operations.length)
  expect(unchanged).toBe(true)
  expect(settled.ink).toBeLessThan(.01)
  expect(settled.over64).toBeLessThanOrEqual(settled.inked / 1000)
  const scale = await page.evaluate(async () => {
    const w = window as any, api = w.scene.api
    const memory = () => (w.replayCanvases as WeakRef<HTMLCanvasElement>[]).reduce((sum, ref) => {
      const canvas = ref.deref(); return sum + (canvas ? canvas.width * canvas.height * 4 / 1048576 : 0)
    }, 0)
    const beforeMiB = memory(), gaps: number[] = []; let previous = performance.now()
    for (let i = 0; i < 30; i++) {
      api.updateScene({ appState: { zoom: { value: Math.min(3, api.getAppState().zoom.value * 1.05) } } })
      await new Promise(resolve => requestAnimationFrame(resolve))
      const now = performance.now(); gaps.push(now - previous); previous = now
    }
    for (let i = 0; i < 60; i++) await new Promise(resolve => requestAnimationFrame(resolve))
    gaps.sort((a, b) => a - b)
    return { deviceScale: devicePixelRatio, beforeMiB, afterMiB: memory(), zoomP95: gaps[Math.floor(gaps.length * .95)], zoomMax: gaps.at(-1) }
  })
  await info.attach('replay-scale', { body: JSON.stringify(scale), contentType: 'application/json' })
  expect(scale.afterMiB).toBeLessThan(240)
  expect(scale.zoomMax).toBeLessThan(500)
})
