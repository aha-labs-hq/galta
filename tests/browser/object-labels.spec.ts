import { test, expect, type Page } from '@playwright/test'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'
import { closeHistory, openHistory } from './history-helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/dev/scene-test.html', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean((window as any).engineTest) || Boolean(document.querySelector('.canvas-notice')))
  await expect(page.locator('.canvas-notice')).toHaveCount(0)
})

const GARDEN = `<!doctype html><html><head><meta charset="utf-8"><title>The Garden House</title><style>
body{margin:0;background:#f1eee6;color:#27352f;font:15px/1.5 system-ui,sans-serif}nav{display:flex;justify-content:space-between;padding:22px 7vw;border-bottom:1px solid #d9d4c7;font-size:12px;letter-spacing:.12em}
main{display:grid;grid-template-columns:1fr 1fr;gap:5vw;padding:7vh 7vw}h1{margin:0;font-size:min(7vw,72px);line-height:1.02;font-weight:600}p{max-width:30ch;color:#5d6660}.photo{min-height:46vh;background:linear-gradient(160deg,#c8d3c0,#6c8478 60%,#273d39)}
@media(max-width:600px){main{grid-template-columns:1fr}h1{font-size:44px}}</style></head>
<body><nav><b>THE GARDEN HOUSE</b><span>LIVING · SPACES · MATERIALS</span></nav><main><div><h1>Keep the weekend at home.</h1><p>A cup of morning coffee, a door to the garden, a slower everyday.</p></div><div class="photo"></div></main></body></html>`

/** What the engine draws beside a page: the darkest pixel just outside its
 * left edge, where it drew a rough outline, and the blue pixels past its
 * top-right corner, where it drew a link badge. */
const engineMarks = (page: Page, scope: string) => page.evaluate(scope => {
  const frame = document.querySelector(`${scope} iframe[title="HTML preview"]`)!.getBoundingClientRect()
  const canvas = document.querySelector(`${scope} canvas.excalidraw__canvas.static`) as HTMLCanvasElement, box = canvas.getBoundingClientRect(), scale = canvas.width / box.width
  const ink = canvas.getContext('2d')!
  const read = (x: number, y: number, width: number, height: number) => ink.getImageData(Math.round((x - box.left) * scale), Math.round((y - box.top) * scale), Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))).data
  let darkest = 255, badge = 0
  for (let y = frame.top + 40; y < frame.bottom - 40; y += 9) {
    const edge = read(frame.left - 6, y, 6, 1)
    for (let i = 0; i < edge.length; i += 4) darkest = Math.min(darkest, edge[i]!)
  }
  const corner = read(frame.right - 4, frame.top - 36, 44, 40)
  for (let i = 0; i < corner.length; i += 4) if (corner[i + 2]! - corner[i]! > 60) badge++
  return { darkest, badge }
}, scope)

const PAGE = '<!doctype html><html><head><title>Garden House</title></head><body style="margin:0;font:16px system-ui;background:#f0efe8"><h1 style="margin:48px">Keep the weekend at home.</h1></body></html>'

test('every page sits in a browser bar, and a page or image is named and captioned on the object', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const result = await page.evaluate(async html => {
    const w = window as any, t = w.engineTest
    const picture = document.createElement('canvas'); picture.width = 300; picture.height = 360
    picture.getContext('2d')!.fillRect(0, 0, 300, 360)
    w.testArtifacts.readImage = async () => ({ dataUrl: picture.toDataURL() })
    w.testArtifacts.readHtml = async () => ({ html })
    const agent = t.agentTool(), errors: string[] = []
    const edit = async (operations: unknown[]) => { try { return (await agent.execute('canvas_edit', { revision: t.revision(), operations })).structuredContent } catch (error) { errors.push(String(error)); return undefined } }
    await edit([
      { type: 'create_element', id: 'page', elementType: 'html', x: 120, y: 160, props: { htmlPath: '/tmp/galta-test/outputs/garden-house.html', width: 720, height: 450, title: 'The Garden House — website', caption: 'The same story, in another form.' } },
      { type: 'create_element', id: 'still', elementType: 'image', x: 920, y: 160, props: { mediaPath: '/tmp/galta-test/outputs/form.png', width: 300, title: 'Form', caption: 'Keep the feeling; let the form change.' } },
      { type: 'create_element', id: 'plain', elementType: 'html', x: 920, y: 640, props: { htmlPath: '/tmp/galta-test/outputs/plain.html', width: 400, height: 240 } },
      { type: 'create_element', id: 'card', elementType: 'rectangle', x: 120, y: 760, props: { width: 200, height: 80 } }
    ])
    await edit([{ type: 'create_element', elementType: 'rectangle', x: 0, y: 0, props: { title: 'Card' } }])
    await edit([{ type: 'update_element', elementId: 'card', props: { caption: 'Card' } }])
    const inspect = (await agent.execute('canvas_inspect', { query: 'another form' })).structuredContent
    return { errors, found: inspect.elements.map((el: any) => ({ id: el.id, title: el.title, caption: el.caption })) }
  }, PAGE)
  expect(result.errors).toHaveLength(2)
  expect(result.errors[0]).toContain('title')
  expect(result.errors[1]).toContain('A title or caption belongs to a page, image or video')
  expect(result.found).toEqual([{ id: 'page', title: 'The Garden House — website', caption: 'The same story, in another form.' }])

  const label = page.locator('.object-label[data-kind=page]').filter({ hasText: 'The Garden House — website' })
  const plain = page.locator('.object-label[data-kind=page]').filter({ hasText: 'plain.html' })
  await expect(plain.locator('.object-label-bar')).toHaveCount(1)
  await expect(plain.locator('.object-label-title')).toHaveCount(0)
  await expect(plain.locator('.object-label-caption')).toHaveCount(0)
  await expect(label.locator('.object-label-name')).toHaveText('The Garden House — website')
  await expect(label.locator('.object-label-spec')).toHaveText('720 px')
  await expect(label.locator('.object-label-file')).toHaveText('garden-house.html')
  await expect(label.locator('.object-label-caption')).toHaveText('The same story, in another form.')
  for (const frame of await page.locator('iframe[title="HTML preview"]').all()) await expect(frame).toHaveAttribute('data-framed', 'true')
  const marks = await engineMarks(page, '')
  expect(marks.darkest, 'a page carries no engine outline beside its frame').toBeGreaterThan(200)
  expect(marks.badge, 'a page carries no engine link badge').toBe(0)
  await expect(page.locator('.object-label[data-kind=image] .object-label-name')).toHaveText('Form')
  await expect(page.locator('.object-label[data-kind=image] .object-label-bar')).toHaveCount(0)

  const geometry = () => page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
    const frame = box('iframe[title="HTML preview"]'), bar = box('.object-label[data-kind=page] .object-label-bar')
    const title = box('.object-label[data-kind=page] .object-label-title'), caption = box('.object-label[data-kind=page] .object-label-caption')
    const layer = document.querySelector('.object-labels')!, interactive = document.querySelector('canvas.excalidraw__canvas.interactive')!
    return {
      frame: { left: frame.left, top: frame.top, right: frame.right, bottom: frame.bottom }, bar: { left: bar.left, right: bar.right, bottom: bar.bottom, top: bar.top },
      titleBottom: title.bottom, captionTop: caption.top, titleSize: getComputedStyle(document.querySelector('.object-label-name')!).fontSize,
      sameStack: layer.parentElement === interactive.parentElement, layerZ: getComputedStyle(layer).zIndex, canvasZ: getComputedStyle(interactive).zIndex,
      pointer: getComputedStyle(layer).pointerEvents
    }
  })
  for (const zoom of [1, 0.5]) {
    await page.evaluate(value => (window as any).scene.api.updateScene({ appState: { zoom: { value } } }), zoom)
    await expect.poll(async () => Math.abs((await geometry()).bar.bottom - (await geometry()).frame.top), `the browser bar sits on the page at ${zoom * 100}%`).toBeLessThanOrEqual(1)
    const g = await geometry()
    expect(Math.abs(g.bar.left - g.frame.left)).toBeLessThanOrEqual(1)
    expect(Math.abs(g.bar.right - g.frame.right)).toBeLessThanOrEqual(1)
    expect(g.bar.bottom - g.bar.top, 'the bar is part of the page and scales with it').toBeCloseTo(40 * zoom, 0)
    expect(g.titleBottom).toBeLessThan(g.bar.top)
    expect(g.captionTop).toBeGreaterThan(g.frame.bottom)
    expect(g.titleSize, 'words keep reading size at every zoom').toBe('12px')
    expect(g.sameStack).toBe(true)
    expect(Number(g.layerZ)).toBeLessThan(Number(g.canvasZ))
    expect(g.pointer).toBe('none')
    await page.screenshot({ path: test.info().outputPath(`object-labels-${zoom * 100}.png`) })
  }
  await page.evaluate(() => (window as any).scene.api.updateScene({ appState: { zoom: { value: 0.1 } } }))
  await expect(page.locator('.object-label-title, .object-label-caption'), 'words are too small to read beside').toHaveCount(0)
  await expect(page.locator('.object-label[data-kind=page] .object-label-bar'), 'every page keeps its bar').toHaveCount(2)

  // An empty title clears it; the caption and the page's bar stay.
  await page.evaluate(async () => {
    const w = window as any, t = w.engineTest
    await t.agentTool().execute('canvas_edit', { revision: t.revision(), operations: [{ type: 'update_element', elementId: 'page', props: { title: '' } }] })
    w.scene.api.updateScene({ appState: { zoom: { value: 1 } } })
  })
  const cleared = page.locator('.object-label[data-kind=page]').filter({ hasText: 'The same story, in another form.' })
  await expect(cleared.locator('.object-label-title')).toHaveCount(0)
  await expect(cleared.locator('.object-label-bar .object-label-file')).toHaveText('garden-house.html')
  expect(await page.evaluate(() => (window as any).scene.elements.find((el: any) => el.id === 'page').customData.title)).toBeUndefined()
})

test('titled pages keep their words in the extension and in Time Machine', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const envelope = await page.evaluate(async html => {
    const w = window as any, t = w.engineTest
    w.testArtifacts.readHtml = async () => ({ html })
    await t.agentTool().execute('canvas_edit', { revision: t.revision(), operations: [
      { type: 'create_element', elementType: 'html', x: 360, y: 80, props: { htmlPath: '/tmp/galta-test/outputs/garden-house.html', width: 1200, height: 760, title: 'The Garden House — website', caption: 'A slower weekend, kept at home.' } },
      { type: 'create_element', elementType: 'html', x: 1640, y: 80, props: { htmlPath: '/tmp/galta-test/outputs/garden-house.html', width: 390, height: 760, title: 'Same page — mobile', caption: 'Changes follow the element.' } }
    ] })
    const { createInitialWorkspace, initializeWorkspaceSnapshot } = await import('/canvas/workspace.ts' as string)
    const bundle = createInitialWorkspace()
    return { format: 'galta-workspace', schemaVersion: 1, exportedAt: Date.now(), workspace: initializeWorkspaceSnapshot(bundle, bundle.project.headCommitId, w.scene.snapshot()) }
  }, GARDEN)
  const live = await page.context().newPage()
  await installReturningAccount(live)
  for (const width of [1440, 480]) {
    await live.setViewportSize({ width, height: 900 })
    if (width === 1440) {
      await live.goto(`${acceptanceOrigin}/sidepanel/index.html`)
      await expect(live.getByRole('button', { name: 'Canvas menu', exact: true })).toBeVisible()
      await live.locator('input[aria-label="Import canvas file"]').setInputFiles({ name: 'garden.galta', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(envelope)) })
      await expect(live.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
    }
    await live.getByRole('button', { name: 'Canvas zoom', exact: true }).click()
    await live.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await live.keyboard.press('Escape')
    const names = ['The Garden House — website', 'Same page — mobile']
    if (width === 1440) await expect(live.locator('.galta-canvas .object-label-name')).toHaveText(names)
    // An imported page keeps no file path; its bar names the page by its own title.
    if (width === 1440) await expect(live.locator('.galta-canvas .object-label-file')).toHaveText(['The Garden House', 'The Garden House'])
    if (width === 1440) {
      const marks = await engineMarks(live, '.galta-canvas')
      expect(marks.darkest, 'the production engine draws no page outline').toBeGreaterThan(200)
      expect(marks.badge, 'the production engine draws no link badge').toBe(0)
      // Without a badge, using a page is still a click on the page.
      const bounds = (await live.locator('.galta-canvas iframe[title="HTML preview"]').first().boundingBox())!
      await live.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await expect(live.locator('.galta-canvas .excalidraw__embeddable-container__inner').first()).toHaveCSS('pointer-events', 'all')
      await live.keyboard.press('Escape')
    }
    await live.waitForTimeout(600)
    await live.screenshot({ path: test.info().outputPath(`object-labels-extension-${width}.png`) })
    if (width !== 1440) continue
    await openHistory(live)
    await expect(live.locator('.history-canvas .object-label-name')).toHaveText(names)
    await expect(live.locator('.history-canvas .object-label-caption')).toHaveText(['A slower weekend, kept at home.', 'Changes follow the element.'])
    await live.waitForTimeout(600)
    await live.screenshot({ path: test.info().outputPath('object-labels-time-machine.png') })
    await closeHistory(live)
  }
})
