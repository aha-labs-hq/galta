import { test, expect } from '@playwright/test'

import { brushBase as base, brushStrokes as strokes, brushOperations as operations } from '../helpers/brush-workload'
import { mixedOperations, frameOperations } from '../helpers/reveal-workload'

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.GALTA_SEMANTICS_URL ?? '/dev/scene-test.html')
  await page.waitForFunction(() => !!(window as any).engineTest)
  await page.evaluate(base => { (window as any).engineTest.apply(base) }, base)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
})

test('120 operations prepare progressively, save once, and undo/redo as one edit', { tag: '@serial' }, async ({ page }, info) => {
  const result = await page.evaluate(async operations => {
    const w = window as any, t = w.engineTest, s = w.scene
    const frames: number[] = [], tasks: number[] = []
    let previous = performance.now(), done = false, previewFrames = 0, saves = 0
    const observer = new PerformanceObserver(list => { tasks.push(...list.getEntries().map(entry => entry.duration)) })
    observer.observe({ entryTypes: ['longtask'] })
    Object.defineProperty(w, 'saved', { configurable: true, set(value) { saves++; w.lastSaved = value } })
    const tick = () => {
      const now = performance.now(); frames.push(now - previous); previous = now
      const staged = document.querySelector('.canvas-presentation [data-preview]')
      if (staged) {
        previewFrames++
        // The reveal replays committed elements, so the document must already be
        // at its final size; decoration must never add or remove document state.
        if (s.elements.length !== 74) throw new Error('Preview changed the document')
      }
      if (!done) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    const start = performance.now()
    await t.tool('canvas_edit', { revision: t.revision(), operations })
    const elapsed = performance.now() - start
    // The reveal continues after the tool returns; let it finish before judging.
    await new Promise(resolve => setTimeout(resolve, 600))
    done = true; observer.disconnect()
    return { elapsed, maxFrame: Math.max(...frames), tasks, previewFrames, saves, count: s.elements.length, savedCount: w.lastSaved.document.elements.length }
  }, operations)
  await info.attach('performance', { body: JSON.stringify(result), contentType: 'application/json' })
  expect(result).toMatchObject({ saves: 1, count: 74, savedCount: 74 })
  expect(result.previewFrames).toBeGreaterThan(0)
  // Generous regression guard for shared runners, not a frame-rate promise.
  expect(result.maxFrame).toBeLessThan(250)
  await expect(page.locator('.canvas-presentation [data-preview]')).toHaveCount(0)
  await page.locator('.excalidraw').focus()
  await page.keyboard.press('Meta+z')
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements.map((el: any) => el.id))).toEqual(base.map(el => el.id))
  await page.keyboard.press('Meta+Shift+z')
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements.length)).toBe(74)
})

test('late invalid operation and Stop during planning leave the original intact', { tag: '@serial' }, async ({ page }) => {
  const result = await page.evaluate(async operations => {
    const w = window as any, t = w.engineTest, s = w.scene, original = JSON.stringify(s.snapshot().document), failures: string[] = []
    try { await t.tool('canvas_edit', { revision: t.revision(), operations: [...operations, { type: 'move', elementId: 'missing', x: 0, y: 0 }] }) } catch (error) { failures.push(String(error)) }
    const invalidPreserved = original === JSON.stringify(s.snapshot().document)
    const controller = new AbortController(), requested = performance.now()
    setTimeout(() => controller.abort(new Error('Stopped')), 0)
    try { await t.tool('canvas_edit', { revision: t.revision(), operations }, { signal: controller.signal }) } catch (error) { failures.push(String(error)) }
    return { invalidPreserved, stoppedPreserved: original === JSON.stringify(s.snapshot().document), stopMs: performance.now() - requested, saved: !!w.saved, failures }
  }, operations)
  expect(result).toMatchObject({ invalidPreserved: true, stoppedPreserved: true, saved: false })
  expect(result.failures[0]).toContain('no longer exists')
  expect(result.failures[1]).toContain('Stopped')
  expect(result.stopMs).toBeLessThan(200)
  await expect(page.locator('.canvas-presentation [data-preview]')).toHaveCount(0)
})

for (const action of ['stop', 'storage', 'edit', 'restore', 'close'] as const) {
  test(`${action} during a write commits nothing and stages nothing`, async ({ page }) => {
    const result = await page.evaluate(async ({ operations, action }) => {
      const w = window as any, t = w.engineTest, s = w.scene, controller = new AbortController()
      const original = JSON.stringify(s.snapshot().document)
      let release!: () => void
      w.saveGate = new Promise<void>(resolve => { release = resolve })
      let failure = ''
      await new Promise(resolve => requestAnimationFrame(resolve))
      const pending = t.tool('canvas_edit', { revision: t.revision(), operations }, { signal: controller.signal }).catch(error => { failure = String(error) })
      // Hold the save open while the interruption is applied, then let it settle.
      await new Promise(resolve => setTimeout(resolve, 0))
      if (action === 'stop') controller.abort(new Error('Stopped'))
      if (action === 'storage') w.failSave = true
      if (action === 'edit') t.apply([{ type: 'create_text', id: 'user', text: 'Keep my edit', x: 30, y: 30 }])
      if (action === 'restore') s.restore(s.snapshot())
      if (action === 'close') { s.disposed = true; s.clearPresentation() }
      release(); await pending
      return { failure, staged: document.querySelectorAll('.canvas-presentation [data-preview]').length }
    }, { operations, action })
    // Decoration is post-commit only, so a write that never commits stages nothing.
    expect(result.staged).toBe(0)
    expect(result.failure).toContain({ stop: 'Stopped', storage: 'Storage unavailable', edit: 'canvas changed', restore: 'canvas changed', close: 'closed' }[action])
    await expect(page.locator('.canvas-presentation [data-preview]')).toHaveCount(0)
  })
}

test('a committed batch is revealed progressively while the camera stays aligned', { tag: '@serial' }, async ({ page }) => {
  const samples = await page.evaluate(async operations => {
    const w: any = window, t = w.engineTest, s = w.scene
    const root = document.querySelector('.canvas-presentation')!, frames: { count: number; transform: string | null }[] = []
    let moving = false
    const sample = () => {
      frames.push({ count: root.querySelectorAll('[data-preview]').length, transform: root.querySelector('g')?.getAttribute('transform') ?? null })
      if (moving) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    moving = true
    await t.tool('canvas_edit', { revision: t.revision(), operations })
    // Change the camera mid-reveal: the group transform must follow it.
    s.api.updateScene({ appState: { scrollX: 120, scrollY: 80, zoom: { value: .5 } } })
    await new Promise(resolve => setTimeout(resolve, 600))
    moving = false
    return frames
  }, operations)
  const counts = [...new Set(samples.map(frame => frame.count))]
  // Several distinct sizes prove the batch was staged across frames, not in one paint.
  expect(counts.length).toBeGreaterThan(1)
  expect(Math.max(...counts)).toBeGreaterThan(1)
  expect(samples.some(frame => frame.transform === 'scale(0.5) translate(120 80)')).toBe(true)
  expect(samples.at(-1)!.count).toBe(0)
  await expect(page.locator('.canvas-presentation [data-preview]')).toHaveCount(0)
})

test('reduced motion skips the reveal without dropping artwork', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const result = await page.evaluate(async operations => {
    const w: any = window, t = w.engineTest, s = w.scene
    const root = document.querySelector('.canvas-presentation')!
    let staged = 0
    const pending = t.tool('canvas_edit', { revision: t.revision(), operations }).then(() => {
      for (let i = 0; i < 10; i++) staged = Math.max(staged, root.querySelectorAll('[data-preview]').length)
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    await pending
    return { staged, count: s.elements.length }
  }, operations)
  // The underline decoration is skipped, but the artwork still commits.
  expect(result.staged).toBe(0)
  // This workload replaces the 46 fixture rectangles with 74 strokes.
  expect(result.count).toBe(74)
})

test('the reveal composites real pixels over the committed canvas', async ({ page }) => {
  await page.evaluate(operations => {
    const w: any = window
    w.pending = w.engineTest.tool('canvas_edit', { revision: w.engineTest.revision(), operations })
  }, operations)
  // Wait for the ink to be staged over the committed strokes.
  await expect(page.locator('.canvas-presentation [data-preview]').first()).toBeAttached()
  expect(await page.locator('.canvas-presentation').boundingBox()).toEqual(await page.locator('.excalidraw').boundingBox())
  const clip = { x: 140, y: 190, width: 400, height: 100 }
  const ink = async () => page.evaluate(async png => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob())
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close()
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    let dark = 0; for (let i = 0; i < data.length; i += 4) if (data[i]! < 150) dark++
    return dark
  }, (await page.screenshot({ clip })).toString('base64'))
  // The reveal draws over the committed paint, so the region is never darker
  // than the finished canvas: decoration only adds coverage.
  const during = await ink()
  await page.screenshot({ path: test.info().outputPath('preview.png') })
  await page.evaluate(async () => { const w: any = window; await w.pending })
  await expect(page.locator('.canvas-presentation [data-preview]')).toHaveCount(0)
  const after = await ink()
  expect(during).toBeGreaterThan(0)
  // Once decoration hands the region back, the committed artwork stands alone.
  expect(after).toBeGreaterThan(0)
  expect(await page.evaluate(() => (window as any).scene.elements.length)).toBe(74)
})

test('every created element type is staged after commit and the batch stays one undo step', async ({ page }) => {
  const result = await page.evaluate(async operations => {
    const w: any = window, t = w.engineTest, s = w.scene
    const before = s.elements.length, kinds = new Set<string>()
    let moving = false, framesWithPreview = 0, premature = false, saves = 0
    Object.defineProperty(w, 'saved', { configurable: true, set(value) { saves++; w.lastSaved = value } })
    const sample = () => {
      const staged = document.querySelectorAll('.canvas-presentation [data-preview]')
      // Staging before the document holds the batch would mean decoration leaked
      // into the transaction. The reveal must only follow a committed document.
      if (staged.length && s.elements.length === before) premature = true
      if (staged.length) { framesWithPreview++; for (const node of staged) kinds.add(node.getAttribute('data-preview')!) }
      if (moving) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    moving = true
    await t.tool('canvas_edit', { revision: t.revision(), operations })
    await new Promise(resolve => setTimeout(resolve, 600))
    moving = false
    const afterCreate = s.elements.length
    const edited = await t.tool('canvas_edit', { revision: t.revision(), operations: [{ type: 'move', elementId: 'card-0', x: 900, y: 900, scope: 'group' }] })
    const receipt = JSON.parse(edited.content.find((part: any) => part.type === 'text').text)
    return { kinds: [...kinds], framesWithPreview, premature, saves, afterCreate, moved: receipt.elements.length }
  }, mixedOperations)
  await expect(page.locator('.canvas-presentation [data-preview]')).toHaveCount(0)
  expect(result.premature).toBe(false)
  // 46 fixture rectangles plus this batch's 48 elements.
  expect(result.afterCreate).toBe(94)
  expect(result.saves).toBe(2)
  // Rectangles, ellipses, diamonds and text each take their own reveal branch.
  expect(result.kinds).toEqual(expect.arrayContaining(['rectangle', 'ellipse', 'diamond', 'text']))
  expect(result.framesWithPreview).toBeGreaterThan(1)
  // A grouped move carries the whole deliverable, which is what the agent is asked to produce.
  expect(result.moved).toBe(48)
})

test('frames are staged even though native elements adopt their frameId', async ({ page }) => {
  const result = await page.evaluate(async operations => {
    const w: any = window, t = w.engineTest, s = w.scene
    let stagedFrame = false, done = false
    const tick = () => {
      if (document.querySelector('.canvas-presentation [data-preview="frame"]')) stagedFrame = true
      if (!done) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    await t.tool('canvas_edit', { revision: t.revision(), operations })
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    done = true
    return { stagedFrame, frames: s.elements.filter((el: any) => el.type === 'frame').length }
  }, frameOperations)
  await expect(page.locator('.canvas-presentation [data-preview]')).toHaveCount(0)
  expect(result.stagedFrame).toBe(true)
  expect(result.frames).toBe(1)
})
