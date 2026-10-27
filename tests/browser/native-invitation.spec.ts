import { expect, test, type Page } from '@playwright/test'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { historyWorkspace } from './history-helpers'

test('native invitation shares the neutral interface and one action with the attached dock', async ({ page }, info) => {
  await page.setViewportSize({ width: 1505, height: 1045 })
  await page.goto(`${acceptanceOrigin}/canvas/index.html?project=default-project`)
  const invitation = page.getByRole('group', { name: 'Meet your canvas agent' })
  await expect(invitation).toBeVisible()
  const target = invitation.getByRole('button', { name: 'Connect through the Galta illustration', exact: true })
  await expect(invitation.getByRole('button')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Connect an agent', exact: true })).toHaveCount(1)
  const bounds = (await target.boundingBox())!
  expect(bounds.x).toBeCloseTo(486.5, 0)
  expect(bounds.y).toBeCloseTo(271.5, 0)
  expect(bounds.width).toBeCloseTo(532, 0)
  const dock = page.locator('.conversation-dock')
  const surface = await page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--graphite-base').trim())
  expect(await dock.evaluate(el => getComputedStyle(el).getPropertyValue('--graphite-base').trim())).toBe(surface)
  await page.screenshot({ path: info.outputPath('reference-desktop.png') })
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await expect(page.locator('.galta-canvas')).toHaveAttribute('data-guide-action', '')
  await page.mouse.click(bounds.x + 8, bounds.y + 24)
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.setViewportSize({ width: 320, height: 500 })
  await expect.poll(async () => { const box = (await invitation.getByRole('button', { name: 'Connect through the Galta illustration', exact: true }).boundingBox())!; return box.y + box.height < 444 }).toBe(true)
  await page.mouse.move(10, 10)
  await page.screenshot({ path: info.outputPath('reference-narrow.png') })
})

async function nativeGuide(page: Page) {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).scene && (window as any).engineTest))
  return page.evaluate(() => {
    const host = window as any, scene = host.scene
    const guide = host.engineTest.createAgentInvitation(scene.api.getAppState())
    host.guide = guide
    scene.showGuide(guide.elements)
    scene.api.history.clear()
    const paper = getComputedStyle(document.documentElement).getPropertyValue('--background').trim()
    const first = guide.elements.filter((el: any) => el.type === 'freedraw' && el.strokeColor !== paper).sort((a: any, b: any) => b.points.length - a.points.length)[0], state = scene.api.getAppState(), [px, py] = first.points[14]
    return { id: first.id, total: guide.elements.length, x: (first.x + px + state.scrollX) * state.zoom.value, y: (first.y + py + state.scrollY) * state.zoom.value }
  })
}

test('the native Codex mark preserves the source outline and transparent counters at normal and enlarged sizes', async ({ page }) => {
  await nativeGuide(page)
  const comparisons = await page.evaluate(async () => {
    const { guide, engineTest: t } = window as any
    const mark = guide.elements.find((el: any) => el.type === 'line' && !el.groupIds.length)
    const source = new DOMParser().parseFromString(await (await fetch('/agent-marks/openai.svg')).text(), 'image/svg+xml')
    const path = new Path2D(source.querySelector('path')!.getAttribute('d')!)
    const [left, , right] = t.getCommonBounds([mark])
    const results = []
    for (const scale of [1, 4]) {
      const actual = await t.exportToCanvas({
        elements: [mark], files: {}, exportPadding: 2,
        appState: { exportBackground: false, exportWithDarkMode: false },
        getDimensions: (width: number, height: number) => ({ width: Math.ceil(width * scale), height: Math.ceil(height * scale), scale })
      })
      const expected = document.createElement('canvas')
      expected.width = actual.width; expected.height = actual.height
      const ctx = expected.getContext('2d')!
      ctx.translate(2 * scale, 2 * scale)
      ctx.scale((right - left) / 24 * scale, (right - left) / 24 * scale)
      ctx.fill(path, 'evenodd')
      const a = actual.getContext('2d')!.getImageData(0, 0, actual.width, actual.height).data
      const b = ctx.getImageData(0, 0, expected.width, expected.height).data
      let difference = 0, ink = 0
      for (let i = 3; i < a.length; i += 4) {
        difference += Math.abs(a[i]! - b[i]!)
        ink += b[i]!
      }
      results.push({ scale, ink, relativeError: difference / ink })
    }
    return results
  })
  for (const result of comparisons) {
    expect(result.ink).toBeGreaterThan(0)
    expect(result.relativeError, `outline error at ${result.scale}x`).toBeLessThan(.03)
  }
})

for (const deviceScaleFactor of [1, 2]) test.describe(`invitation zoom at DPR ${deviceScaleFactor}`, () => {
  test.use({ deviceScaleFactor })
  test('rebuilding at restored zoom preserves illustration, Claude and arrow pixels', async ({ page }, info) => {
    await nativeGuide(page)
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 320, height: 500 }]) {
      await page.setViewportSize(viewport)
      await page.waitForFunction(width => (window as any).scene.api.getAppState().width === width, viewport.width)
      const comparisons = await page.evaluate(async () => {
        const { scene, engineTest: t } = window as any
        const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const references: { name: string; box: number[]; pixels: Uint8ClampedArray }[] = [], results = []
        for (const zoom of [1, .1, 3.88, 5]) {
          scene.api.updateScene({ appState: { zoom: { value: zoom }, scrollX: 0, scrollY: 0 } })
          await frame()
          const guide = t.createAgentInvitation(scene.api.getAppState())
          scene.showGuide(guide.elements)
          await frame()
          const canvas = document.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.static')!, ctx = canvas.getContext('2d')!
          if (zoom === 1) {
            const soft = getComputedStyle(document.documentElement).getPropertyValue('--muted-foreground').trim()
            const illustration = guide.elements.filter((el: any) => el.groupIds.length && el.type !== 'text')
            const loose = guide.elements.filter((el: any) => el.type === 'freedraw' && !el.groupIds.length)
            const groups = [{ name: 'illustration', elements: illustration }, { name: 'Claude', elements: loose.filter((el: any) => el.strokeColor !== soft) }, { name: 'thread', elements: loose.filter((el: any) => el.strokeColor === soft) }]
            for (const { name, elements } of groups) {
              if (!elements.length) continue
              const [x1, y1, x2, y2] = t.getCommonBounds(elements), dpr = devicePixelRatio
              const left = Math.max(0, Math.floor((x1 - 4) * dpr)), top = Math.max(0, Math.floor((y1 - 4) * dpr))
              const right = Math.min(canvas.width, Math.ceil((x2 + 4) * dpr)), bottom = Math.min(canvas.height, Math.ceil((y2 + 4) * dpr))
              references.push({ name, box: [left, top, right - left, bottom - top], pixels: ctx.getImageData(left, top, right - left, bottom - top).data })
            }
          } else for (const { name, box: [x, y, width, height], pixels } of references) {
            const actual = ctx.getImageData(x!, y!, width!, height!).data, background = ctx.getImageData(0, 0, 1, 1).data
            let difference = 0, ink = 0
            for (let i = 0; i < actual.length; i++) if (i % 4 !== 3) {
              difference += Math.abs(actual[i]! - pixels[i]!)
              ink += Math.abs(pixels[i]! - background[i % 4]!)
            }
            results.push({ name, zoom, ink, relativeError: difference / ink })
          }
        }
        return results
      })
      await info.attach(`zoom-${viewport.width}`, { body: JSON.stringify(comparisons), contentType: 'application/json' })
      expect([...new Set(comparisons.map(result => result.name))]).toEqual(viewport.width > 600 ? ['illustration', 'Claude', 'thread'] : ['illustration', 'Claude'])
      for (const result of comparisons) {
        expect(result.ink).toBeGreaterThan(0)
        expect(result.relativeError, `${result.name} at ${result.zoom}x in ${viewport.width}px`).toBeLessThan(.06)
      }
      await page.screenshot({ path: info.outputPath(`restored-zoom-${viewport.width}.png`) })
    }
  })
})

test('guide is native pressure ink, erasable and undoable without entering the document', async ({ page }) => {
  const first = await nativeGuide(page)
  const original = await page.evaluate(async () => {
    const { scene } = window as any
    scene.observe(scene.api.getSceneElementsIncludingDeleted(), scene.files)
    return { types: [...new Set(scene.api.getSceneElements().map((el: any) => el.type))], labels: scene.api.getSceneElements().filter((el: any) => el.type === 'text').map((el: any) => el.text), document: scene.snapshot().document, preview: await scene.preview(), pressure: scene.api.getSceneElements().filter((el: any) => el.type === 'freedraw').every((el: any) => !el.simulatePressure && el.pressures.length === el.points.length && el.points[0][0] === 0 && el.points[0][1] === 0) }
  })
  expect(original.types.sort()).toEqual(['freedraw', 'line', 'text'])
  expect(original.labels).not.toContain('Connect an agent')
  expect(original.document.elements).toEqual([])
  expect(original.document.files).toEqual({})
  expect(original.preview).toBeUndefined()
  expect(original.pressure).toBe(true)
  await page.evaluate(() => (window as any).scene.api.setActiveTool({ type: 'eraser' }))
  await page.mouse.move(first.x, first.y - 8); await page.mouse.down(); await page.mouse.move(first.x, first.y + 8, { steps: 6 }); await page.mouse.up()
  const present = () => page.evaluate(id => (window as any).scene.api.getSceneElements().some((el: any) => el.id === id), first.id)
  await expect.poll(present).toBe(false)
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+z')
  await expect.poll(present).toBe(true)
  await page.keyboard.press('Meta+Shift+z')
  await expect.poll(present).toBe(false)
  expect(await page.evaluate(() => {
    const scene = (window as any).scene
    return { changed: scene.observe(scene.api.getSceneElementsIncludingDeleted(), scene.files), document: scene.snapshot().document.elements }
  })).toEqual({ changed: false, document: [] })
})

test('native copies become artwork, while guide metadata cannot hide imported elements', async ({ page }) => {
  const first = await nativeGuide(page)
  await page.evaluate(id => {
    const scene = (window as any).scene
    scene.api.updateScene({ appState: { selectedElementIds: { [id]: true } } })
  }, first.id)
  await expect.poll(() => page.evaluate(id => Boolean((window as any).scene.api.getAppState().selectedElementIds[id]), first.id)).toBe(true)
  await page.evaluate(() => (window as any).scene.api.executeAction('duplicateSelection'))
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements.length)).toBe(1)
  const copy = await page.evaluate(() => (window as any).scene.snapshot().document.elements[0])
  expect(copy.id).not.toBe(first.id)
  expect(copy.customData.galtaGuide).toBe('agent-invitation')
  await page.evaluate(() => (window as any).scene.dismissGuide())
  expect(await page.evaluate(() => (window as any).scene.api.getSceneElements().length)).toBe(1)
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+z')
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements.length)).toBe(0)
  await page.keyboard.press('Meta+Shift+z')
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements.length)).toBe(1)
})

test('the reference title is native serif text and a copied title keeps its font through editing and restore', async ({ page }) => {
  await nativeGuide(page)
  const title = await page.evaluate(() => {
    const { guide, scene } = window as any
    const title = guide.elements.find((el: any) => el.type === 'text' && el.text.startsWith('Bring your agent'))
    scene.api.updateScene({ appState: { selectedElementIds: { [title.id]: true } } })
    return { id: title.id, fontFamily: title.fontFamily, width: title.width, text: title.text }
  })
  expect(title.fontFamily).toBe(10001)
  expect(title.width).toBeGreaterThan(400)
  await expect.poll(() => page.evaluate(id => Boolean((window as any).scene.api.getAppState().selectedElementIds[id]), title.id)).toBe(true)
  await page.evaluate(() => (window as any).scene.api.executeAction('duplicateSelection'))
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements.length)).toBe(1)
  await page.evaluate(() => {
    const { scene } = window as any
    scene.dismissGuide()
    const text = scene.elements[0]
    scene.api.updateScene({ appState: { selectedElementIds: { [text.id]: true } } })
  })
  await page.evaluate(() => (window as any).scene.api.executeAction('changeFontFamily', { currentItemFontFamily: 2 }))
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements[0].fontFamily)).toBe(2)
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+z')
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements[0].fontFamily)).toBe(10001)
  const restored = await page.evaluate(() => {
    const { scene } = window as any, snapshot = scene.snapshot()
    scene.restore(snapshot)
    return scene.elements[0]
  })
  expect(restored.fontFamily).toBe(10001)
  expect(restored.text).toBe(title.text)
  expect(restored.width).toBeCloseTo(title.width, 1)
})

test('production ink activates setup after moving and zooming; keyboard access shares the action', async ({ page }, info) => {
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  const invitation = page.getByRole('group', { name: 'Meet your canvas agent' })
  await expect(invitation).toBeVisible()
  expect(await invitation.locator('img, svg, canvas').count()).toBe(0)
  const target = invitation.getByRole('button', { name: 'Connect through the Galta illustration', exact: true })
  await page.setViewportSize({ width: 320, height: 500 })
  await expect.poll(async () => { const b = (await target.boundingBox())!; return b.x >= 64 && b.x + b.width <= 312 }).toBe(true)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect.poll(async () => (await target.boundingBox())!.x).toBeGreaterThan(400)
  const before = (await target.boundingBox())!
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down(); await page.mouse.move(before.x + before.width / 2 + 70, before.y + before.height / 2 - 35, { steps: 12 }); await page.mouse.up()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const moved = (await target.boundingBox())!
  expect(moved.x - before.x).toBeCloseTo(70, 0)
  await page.getByRole('button', { name: 'Canvas zoom', exact: true }).click()
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.keyboard.press('Escape')
  const zoomed = (await target.boundingBox())!
  expect(zoomed.width / moved.width).toBeCloseTo(1.25, 1)
  await page.mouse.click(zoomed.x + zoomed.width / 2, zoomed.y + zoomed.height / 2)
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await page.getByRole('button', { name: 'Close settings' }).click()
  await target.focus(); await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await page.getByRole('button', { name: 'Close settings' }).click()
  const workspace = await historyWorkspace(page)
  expect(workspace.snapshots[workspace.project.headCommitId].document.elements).toEqual([])
  await page.screenshot({ path: info.outputPath('native-invitation-moved.png') })
})

test('a first text edit retires the guide and undo cannot restore it', async ({ page }) => {
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect(page.getByRole('group', { name: 'Meet your canvas agent' })).toBeVisible()
  await page.getByRole('button', { name: 'Text — T' }).click()
  await page.mouse.click(250, 180)
  await page.locator('.excalidraw-wysiwyg').fill('My first mark')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Meet your canvas agent' })).toHaveCount(0)
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+z')
  await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  await page.keyboard.press('Meta+Shift+z')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect.poll(async () => {
    const workspace = await historyWorkspace(page)
    return workspace.snapshots[workspace.project.headCommitId].document.elements.filter((el: any) => !el.isDeleted).map((el: any) => el.text)
  }).toEqual(['My first mark'])
  await page.reload()
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Meet your canvas agent' })).toHaveCount(0)
})
