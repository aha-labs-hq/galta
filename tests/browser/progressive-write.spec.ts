import { test, expect } from '@playwright/test'

import { brushBase as base, brushStrokes as strokes, brushOperations as operations } from '../helpers/brush-workload'
import { mixedOperations } from '../helpers/reveal-workload'

// A large edit is prepared progressively and committed as one transaction; how
// its work then lands on screen is the ink pen's (ink-pen.spec.ts).

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.GALTA_SEMANTICS_URL ?? '/dev/scene-test.html')
  await page.waitForFunction(() => !!(window as any).engineTest)
  await page.evaluate(base => { (window as any).engineTest.apply(base) }, base)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
})

/** The strongest alpha around a world point on the static canvas. */
const inkAt = ([x, y]: readonly [number, number]) => {
  const w = window as any, s = w.scene.api.getAppState(), canvas = document.querySelector('.excalidraw__canvas.static') as HTMLCanvasElement
  const k = canvas.width / s.width * s.zoom.value
  const data = canvas.getContext('2d')!.getImageData(Math.round((x + s.scrollX) * k) - 1, Math.round((y + s.scrollY) * k) - 1, 3, 3).data
  let alpha = 0
  for (let i = 3; i < data.length; i += 4) alpha = Math.max(alpha, data[i]!)
  return alpha
}
// The middle of the first stroke, at (186, 220.5).
const firstStroke = [186, 220.5] as const

test('120 operations prepare progressively, save once, and undo/redo as one edit', { tag: '@serial' }, async ({ page }, info) => {
  const result = await page.evaluate(async operations => {
    const w = window as any, t = w.engineTest, s = w.scene
    const frames: number[] = [], tasks: number[] = []
    let previous = performance.now(), done = false, saves = 0
    const observer = new PerformanceObserver(list => { tasks.push(...list.getEntries().map(entry => entry.duration)) })
    observer.observe({ entryTypes: ['longtask'] })
    Object.defineProperty(w, 'saved', { configurable: true, set(value) { saves++; w.lastSaved = value } })
    const tick = () => {
      const now = performance.now(); frames.push(now - previous); previous = now
      if (!done) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    const start = performance.now()
    await t.tool('canvas_edit', { revision: t.revision(), operations })
    const elapsed = performance.now() - start
    // The document holds the whole edit when the tool returns; only pixels follow.
    const committed = s.elements.length
    await new Promise(resolve => setTimeout(resolve, 600))
    done = true; observer.disconnect()
    return { elapsed, maxFrame: Math.max(...frames), tasks, saves, committed, count: s.elements.length, savedCount: w.lastSaved.document.elements.length }
  }, operations)
  await info.attach('performance', { body: JSON.stringify(result), contentType: 'application/json' })
  expect(result).toMatchObject({ saves: 1, committed: 74, count: 74, savedCount: 74 })
  // Generous regression guard for shared runners, not a frame-rate promise.
  expect(result.maxFrame).toBeLessThan(250)
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
})

for (const action of ['stop', 'storage', 'edit', 'restore', 'close'] as const) {
  test(`${action} during a write commits nothing and shows nothing`, async ({ page }) => {
    const result = await page.evaluate(async ({ operations, action }) => {
      const w = window as any, t = w.engineTest, s = w.scene, controller = new AbortController()
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
      for (let i = 0; i < 30; i++) await new Promise(resolve => requestAnimationFrame(resolve))
      return { failure, created: s.elements.some((el: any) => el.id === 'ink-0') }
    }, { operations, action })
    expect(result.failure).toContain({ stop: 'Stopped', storage: 'Storage unavailable', edit: 'canvas changed', restore: 'canvas changed', close: 'closed' }[action])
    expect(result.created).toBe(false)
    expect(await page.evaluate(inkAt, firstStroke)).toBe(0)
  })
}

test('a mixed edit lands whole, stays one undo step, and moves as one group', async ({ page }) => {
  const result = await page.evaluate(async operations => {
    const w: any = window, t = w.engineTest, s = w.scene
    let saves = 0
    Object.defineProperty(w, 'saved', { configurable: true, set(value) { saves++; w.lastSaved = value } })
    await t.tool('canvas_edit', { revision: t.revision(), operations })
    await new Promise(resolve => setTimeout(resolve, 600))
    const afterCreate = s.elements.length
    const edited = await t.tool('canvas_edit', { revision: t.revision(), operations: [{ type: 'move', elementId: 'card-0', x: 900, y: 900, scope: 'group' }] })
    const receipt = JSON.parse(edited.content.find((part: any) => part.type === 'text').text)
    return { saves, afterCreate, moved: receipt.elements.length }
  }, mixedOperations)
  // 46 fixture rectangles plus this batch's 48 elements.
  expect(result.afterCreate).toBe(94)
  expect(result.saves).toBe(2)
  // A grouped move carries the whole deliverable, which is what the agent is asked to produce.
  expect(result.moved).toBe(48)
})

test('strokes are present in the document the moment an edit returns', async ({ page }) => {
  const count = await page.evaluate(async strokes => {
    const t = (window as any).engineTest
    await t.tool('canvas_edit', { revision: t.revision(), operations: strokes })
    return (window as any).scene.elements.filter((el: any) => el.type === 'freedraw').length
  }, strokes)
  expect(count).toBe(74)
})
