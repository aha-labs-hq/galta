import { seedWorkspace } from '../helpers/stored-workspace'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { test, expect } from '@playwright/test'
import { restoreHistory, historyWorkspace, openHistory } from './history-helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
})

test('native pointer strokes, undo and redo remain native after preparation and restore', async ({ page }) => {
  await page.evaluate(() => (window as any).scene.api.setActiveTool({ type: 'freedraw' }))
  await page.mouse.move(450, 400); await page.mouse.down()
  await page.mouse.move(300, 250, { steps: 20 }); await page.mouse.move(530, 310, { steps: 20 }); await page.mouse.up()
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements.length)).toBe(1)
  const original = await page.evaluate(() => {
    const s = (window as any).scene
    return structuredClone(s.elements[0])
  })
  expect(original.points[0]).toEqual([0, 0])
  await page.keyboard.press('Meta+z')
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements.length)).toBe(0)
  await page.keyboard.press('Meta+Shift+z')
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements.length)).toBe(1)
  const result = await page.evaluate(() => {
    const { scene: s, engineTest: t } = window as any
    const native = structuredClone(s.elements[0])
    t.apply([{ type: 'create_element', elementType: 'rectangle', x: 800, y: 200 }])
    const prepared = structuredClone(s.elements[0]), saved = s.snapshot()
    s.restore(saved)
    return { native, prepared, restored: s.elements[0] }
  })
  // Native restore clears its pointer-session field and repairs null reverse
  // bindings. All artwork/geometry fields remain unchanged.
  expect(result.prepared).toEqual({ ...result.native, lastCommittedPoint: null, boundElements: [] })
  expect(result.restored).toEqual(result.prepared)
})

test('production history previews, continuation and reopening preserve old snapshots and show whole strokes', async ({ page }) => {
  const old = await page.evaluate(() => {
    const { scene: s, engineTest: t } = window as any
    t.apply([{ type: 'create_element', id: 'old-brush', elementType: 'freedraw', x: 200, y: 120,
      props: { points: [[0, 0], [160, 0], [160, 160], [0, 160], [0, 0]], strokeColor: '#000000', strokeWidth: 3 } }])
    const snapshot = s.snapshot()
    const points = [
      ...Array.from({ length: 40 }, (_, i) => [40 + i * 4, 100]),
      ...Array.from({ length: 40 }, (_, i) => [200, 100 + i * 4]),
      ...Array.from({ length: 40 }, (_, i) => [200 - i * 4, 260]),
      ...Array.from({ length: 41 }, (_, i) => [40, 260 - i * 4])
    ]
    Object.assign(snapshot.document.elements[0], { width: 200, height: 140, points })
    return snapshot
  })
  const url = `${acceptanceOrigin}/sidepanel/index.html`
  await page.goto(url)
  await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  const workspace = await historyWorkspace(page), head = workspace.project.headCommitId
  workspace.snapshots[head] = old
  workspace.canvasView = { commitId: head, scrollX: 0, scrollY: 0, zoom: 1 }
  await page.goto(`${acceptanceOrigin}/manifest.json`)
  await seedWorkspace(page, workspace)
  await page.goto(url)
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  const wholeStroke = () => page.locator('canvas.excalidraw__canvas.static').evaluate((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d')!
    return [[320, 220], [400, 300], [320, 380], [240, 300]].map(([x, y]) => {
      const pixels = ctx.getImageData((x! - 4) * devicePixelRatio, (y! - 4) * devicePixelRatio, 8 * devicePixelRatio, 8 * devicePixelRatio).data
      return pixels.some((v, i) => i % 4 === 0 && v < 100)
    })
  })
  await expect.poll(wholeStroke).toEqual([true, true, true, true])
  await openHistory(page)
  await expect(page.locator('.history-canvas')).toHaveAttribute('data-state', 'ready')
  expect((await historyWorkspace(page)).snapshots).toEqual(workspace.snapshots)
  await page.getByRole('button', { name: 'Close Time Machine', exact: true }).click()
  await page.reload()
  await expect.poll(wholeStroke).toEqual([true, true, true, true])
  expect((await historyWorkspace(page)).project).toEqual(workspace.project)
  expect((await historyWorkspace(page)).snapshots).toEqual(workspace.snapshots)
  // A real edit persists the applied representation as a new version, not an
  // in-place rewrite of its ancestor. Native undo restores the original view.
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+a'); await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await historyWorkspace(page)).project.headCommitId).not.toBe(head)
  const edited = await historyWorkspace(page)
  expect(edited.snapshots[head]).toEqual(old)
  expect(edited.snapshots[edited.project.headCommitId].document.elements[0].points[0]).toEqual([0, 0])
  await page.keyboard.press('Meta+z')
  await expect.poll(wholeStroke).toEqual([true, true, true, true])
  await restoreHistory(page, head)
  await expect.poll(wholeStroke).toEqual([true, true, true, true])
  await page.reload()
  await expect.poll(wholeStroke).toEqual([true, true, true, true])
  expect((await historyWorkspace(page)).snapshots[head]).toEqual(old)
})

test('brush creation and point updates use native geometry, including within one batch', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { scene: s, engineTest: t } = window as any
    t.apply([{ type: 'create_element', id: 'stroke', elementType: 'freedraw', x: 50, y: 655, rotation: .7,
      props: { points: [[31, 106], [14, 219], [90, 150]], pressures: [.2, .6, .4], simulatePressure: false, strokeColor: '#39332e', groupIds: ['dog'] } }])
    const created = structuredClone(s.elements[0])
    t.apply([
      { type: 'update_element', elementId: 'stroke', x: 100, y: 200, props: { points: [[-30, 40], [20, 10], [0, 100]] } },
      { type: 'move', elementId: 'stroke', x: 300, y: 400 }
    ])
    const updated = structuredClone(s.elements[0]), failures: string[] = []
    for (const op of [
      { type: 'create_element', elementType: 'freedraw', x: 0, y: 0 },
      { type: 'update_element', elementId: 'stroke', props: { points: [[0, 0], [100, 0]] } },
      { type: 'update_element', elementId: 'stroke', props: { pressures: [] } }
    ]) {
      const before = JSON.stringify(s.snapshot())
      try { await t.tool('canvas_edit', { revision: t.revision(), operations: [{ type: 'move', elementId: 'stroke', x: 900, y: 900 }, op] }) }
      catch (error) { failures.push(String(error)) }
      if (before !== JSON.stringify(s.snapshot())) throw new Error('Invalid batch changed artwork')
    }
    t.apply([{ type: 'create_element', id: 'horizontal', elementType: 'freedraw', x: 10, y: 20, props: { points: [[20, 50], [120, 50]] } }])
    return { created, updated, failures, horizontal: s.elements.find((e: any) => e.id === 'horizontal') }
  })
  expect(result.created).toMatchObject({ x: 81, y: 761, width: 76, height: 113, angle: .7, points: [[0, 0], [-17, 113], [59, 44]], pressures: [.2, .6, .4], groupIds: ['dog'] })
  expect(result.updated).toMatchObject({ x: 300, y: 400, width: 50, height: 90, angle: .7, points: [[0, 0], [50, -30], [30, 60]], pressures: [.2, .6, .4] })
  expect(result.horizontal).toMatchObject({ x: 30, y: 70, width: 100, height: 0, points: [[0, 0], [100, 0]], pressures: [], simulatePressure: true })
  expect(result.failures).toHaveLength(3)
})

test('old strokes restore without rewriting history; rotated world geometry and export stay unchanged', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { scene: s, engineTest: t } = window as any
    t.apply([{ type: 'create_element', id: 'stroke', elementType: 'freedraw', x: 50, y: 655,
      props: { points: [[0, 0], [80, 0], [80, 100], [0, 100]], simulatePressure: true, pressures: [] } }])
    const old = s.snapshot(), el = old.document.elements[0]
    Object.assign(el, { width: 200, height: 140, angle: .7, points: [[31, 106], [14, 219], [90, 150]], pressures: [.2], customData: { note: 'Preserve me' } })
    const original = JSON.stringify(old)
    const { exportToCanvas, getCommonBounds } = t
    const render = async (elements: any[]) => {
      const canvas = await exportToCanvas({ elements, files: {}, appState: { exportBackground: true, viewBackgroundColor: '#ffffff' } })
      return { width: canvas.width, height: canvas.height, pixels: [...canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data] }
    }
    const before = await render(old.document.elements)
    s.restore(old)
    const live = structuredClone(s.elements[0]), restoredSnapshot = s.snapshot()
    const after = await render(s.elements)
    const diff = before.pixels.reduce((n: number, v: number, i: number) => n + Math.abs(v - after.pixels[i]), 0) / before.pixels.length
    const boundsBefore = getCommonBounds(old.document.elements), boundsAfter = getCommonBounds(s.elements)
    const once = JSON.stringify(s.elements)
    s.restore(old)
    return { live, restoredSnapshot, originalSnapshot: JSON.parse(original), inputPreserved: original === JSON.stringify(old), idempotent: once === JSON.stringify(s.elements), boundsBefore, boundsAfter, diff, sizes: [[before.width, before.height], [after.width, after.height]] }
  })
  expect(result.live).toMatchObject({ x: 81, y: 761, width: 76, height: 113, points: [[0, 0], [-17, 113], [59, 44]], pressures: [.2], customData: { note: 'Preserve me' } })
  expect(result.restoredSnapshot).toEqual(result.originalSnapshot)
  expect(result.inputPreserved).toBe(true)
  expect(result.idempotent).toBe(true)
  result.boundsBefore.forEach((n: number, i: number) => expect(result.boundsAfter[i]).toBeCloseTo(n, 10))
  expect(result.sizes[1]).toEqual(result.sizes[0])
  expect(result.diff).toBeLessThan(.1)
})

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`live/export parity at DPR ${deviceScaleFactor}`, () => {
    test.use({ deviceScaleFactor })
    test('offset, negative, rotated and axis-aligned strokes match the agent view', async ({ page }, info) => {
      await page.evaluate(() => {
        const { scene: s, engineTest: t } = window as any
        t.apply([0, 1, 2, 3].map(i => ({ type: 'create_element', id: `stroke-${i}`, elementType: 'freedraw', x: 200 + i * 200, y: 220, rotation: i === 2 ? .8 : 0,
          props: { points: i === 3 ? [[20, 50], [120, 50]] : [[31, 106], [14, 219], [90, 150], [31, 106]], simulatePressure: true, pressures: [], strokeWidth: 3, strokeColor: '#000000' } })))
        s.api.updateScene({ appState: { scrollX: 0, scrollY: 0, selectedElementIds: {} } })
      })
      for (const zoom of [1, .94386]) {
        const parity = await page.evaluate(async zoom => {
          const s = (window as any).scene
          s.api.updateScene({ appState: { zoom: { value: zoom } } })
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          const blob = await s.preview([], 'low', { x: 0, y: 0, width: 1000, height: 650 })
          const bitmap = await createImageBitmap(blob), c = document.createElement('canvas')
          // Compare at the same world-space sampling grid, independent of the
          // observation's pixel budget or the display's device scale factor.
          c.width = 1000; c.height = 650
          c.getContext('2d')!.drawImage(bitmap, 0, 0, c.width, c.height); bitmap.close()
          const exported = c.getContext('2d')!.getImageData(0, 0, c.width, c.height)
          const canvas = document.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.static')!
          const live = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
          const dark = (pixels: ImageData, x: number, y: number) => pixels.data[(y * pixels.width + x) * 4] < 100
          let exportedInk = 0, liveInk = 0, missing = 0, extra = 0
          for (let y = 200; y < 550; y++) for (let x = 150; x < 980; x++) {
            const lx = Math.round(x * zoom * devicePixelRatio), ly = Math.round(y * zoom * devicePixelRatio)
            if (dark(exported, x, y)) {
              exportedInk++
              let found = false
              for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dark(live, lx + dx, ly + dy)) found = true
              if (!found) missing++
            }
            if (dark(live, lx, ly)) {
              liveInk++
              let found = false
              for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dark(exported, x + dx, y + dy)) found = true
              if (!found) extra++
            }
          }
          return { exportedInk, liveInk, missing: missing / exportedInk, extra: extra / liveInk }
        }, zoom)
        await info.attach(`parity-${zoom}`, { body: JSON.stringify(parity), contentType: 'application/json' })
        expect(parity.exportedInk).toBeGreaterThan(2000)
        expect(parity.missing).toBeLessThan(.01)
        expect(parity.extra).toBeLessThan(.01)
      }
      await page.screenshot({ path: info.outputPath('live-strokes.png') })
    })
  })
}
