import { test, expect, chromium } from '@playwright/test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptanceBuild, acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'

test.beforeEach(async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const source = (await readFile('tests/fixtures/canvas-video.webm')).toString('base64')
  await page.evaluate(source => {
    (window as any).testArtifacts.readVideo = async () => (await fetch(`data:video/webm;base64,${source}`)).blob()
  }, source)
})

test('native video plays without an iframe; canvas views use its poster and playback never edits the document', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest
    const placed = JSON.parse((await t.tool('canvas_place', { revision: t.revision(), path: '/tmp/galta-test/movie.webm', x: 200, y: 150, width: 480 })).content[0].text)
    const view = await t.tool('canvas_capture', { scope: 'canvas' })
    return { placed, view: JSON.parse(view.content[1].text), binary: Object.values(w.scene.snapshot().document.files).every((f: any) => f.blob instanceof Blob && !f.dataURL) }
  })
  expect(result.placed.element).toMatchObject({ kind: 'video', width: 480, height: 270, video: { width: 320, height: 180, duration: 2 } })
  expect(result.binary).toBe(true)
  expect(result.view).toMatchObject({ complete: true, unrenderedElementIds: [], videoPosterIds: [result.placed.elementId] })
  await expect(page.locator('.canvas-video img')).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(0)
  await page.locator('.canvas-video').screenshot({ path: test.info().outputPath('video-poster-graphite.png') })
  const before = await page.evaluate(() => (window as any).engineTest.revision())
  await page.mouse.click(440, 285)
  await expect(page.locator('.canvas-video video')).toBeVisible()
  await expect(page.locator('.excalidraw-hyperlinkContainer')).toBeHidden()
  await expect.poll(() => page.locator('.canvas-video video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0)
  expect(await page.evaluate(() => (window as any).engineTest.revision())).toBe(before)
  await page.screenshot({ path: test.info().outputPath('native-video.png') })
  // A real decoder error must keep the recovery action readable and operable.
  await page.locator('.canvas-video video').evaluate((video: HTMLVideoElement) => { video.src = 'data:video/webm;base64,AA==' })
  const retry = page.getByRole('button', { name: 'Retry', exact: true })
  await expect(retry).toBeVisible()
  const restingMaterial = await retry.evaluate(el => getComputedStyle(el).boxShadow)
  await retry.press('Tab'); await page.keyboard.press('Shift+Tab')
  await expect(retry).toBeFocused()
  await expect(retry).toHaveCSS('outline-style', 'none')
  await expect(retry).toHaveCSS('box-shadow', restingMaterial)
  const contrast = await retry.evaluate(el => {
    const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum,c,i) => sum + c * [.2126,.7152,.0722][i]!, 0)
    const style = getComputedStyle(el)
    return (luminance(style.color) + .05) / (luminance(style.backgroundColor) + .05)
  })
  expect(contrast).toBeGreaterThanOrEqual(4.5)
  await page.locator('.canvas-video').screenshot({ path: test.info().outputPath('video-recovery-graphite.png'), animations: 'disabled' })
  await page.emulateMedia({ forcedColors: 'active' })
  await expect(retry).toHaveCSS('outline-style', 'solid')
  await expect(retry).toHaveCSS('box-shadow', 'none')
  await page.locator('.canvas-video').screenshot({ path: test.info().outputPath('video-recovery-forced-colors.png'), animations: 'disabled' })
  await page.emulateMedia({ forcedColors: 'none' })
  await retry.press('Enter')
  await expect(page.locator('.canvas-video video')).toBeVisible()
  await expect.poll(() => page.locator('.canvas-video video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0)
  expect(await page.evaluate(() => (window as any).engineTest.revision())).toBe(before)
  await page.mouse.click(1000, 100)
  await expect(page.locator('.canvas-video video')).toHaveCount(0)
  await expect(page.locator('.canvas-video img')).toBeVisible()
  expect(errors).toEqual([])
})

test('canvas_extract materializes native video bytes as a reusable source file', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w = window as any, writes: any[] = []
    w.testArtifacts.writeArtifact = async (path: string, dataBase64: string, mimeType: string) => writes.push({ path, dataBase64, mimeType })
    const placedResult = await w.engineTest.tool('canvas_place', { revision: w.engineTest.revision(), path: '/tmp/galta-test/movie.webm' })
    const placed = JSON.parse(placedResult.content[0].text)
    const extractedResult = await w.engineTest.tool('canvas_extract', { element: placed.elementId, source: 'current' })
    const extracted = JSON.parse(extractedResult.content[0].text)
    const bytes = Uint8Array.from(atob(writes[0].dataBase64), c => c.charCodeAt(0))
    return { extracted, write: { path: writes[0].path, mimeType: writes[0].mimeType, size: bytes.length } }
  })
  expect(result.extracted).toMatchObject({ kind: 'video', mimeType: 'video/webm', source: 'element' })
  expect(result.write).toMatchObject({ mimeType: 'video/webm' })
  expect(result.write.size).toBeGreaterThan(0)
  expect(result.write.path).toMatch(/\/sources\/[0-9a-f]{64}\.webm$/)
})

test('video replacement and native captions share a transaction without losing geometry or media kind', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, s = w.scene
    const call = async (operations: any[]) => JSON.parse((await t.tool('canvas_edit', { revision: t.revision(), operations })).content[0].text)
    await call([
      { type: 'create_element', elementType: 'video', id: 'movie', x: 200, y: 150, rotation: .1, props: { mediaPath: '/tmp/movie.webm', width: 400, groupIds: ['card'] } },
      { type: 'create_text', id: 'caption', x: 200, y: 410, text: 'Original', props: { groupIds: ['card'] } }
    ])
    const before = structuredClone(s.elements[0])
    const receipt = await call([
      { type: 'update_element', elementId: 'movie', props: { mediaPath: '/tmp/revised.webm' } },
      { type: 'update_element', elementId: 'caption', props: { text: 'Revised video' } }
    ])
    const after = structuredClone(s.elements[0]), document = JSON.stringify(s.snapshot().document)
    let error = ''
    try { await call([{ type: 'update_element', elementId: 'caption', props: { mediaPath: '/tmp/revised.webm' } }]) } catch (e) { error = String(e) }
    return { before, after, receipt, error, preserved: document === JSON.stringify(s.snapshot().document) }
  })
  for (const key of ['id', 'x', 'y', 'width', 'height', 'angle', 'groupIds', 'link']) expect(result.after[key]).toEqual(result.before[key])
  expect(result.after.customData.video.fileId).not.toBe(result.before.customData.video.fileId)
  expect(result.receipt.elements.map((element: any) => element.change)).toEqual(['updated', 'updated'])
  expect(result.error).toContain('same kind')
  expect(result.preserved).toBe(true)
})

test('video assets are stored once as Blobs across history, portable export and a cold reload', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w = window as any, s = w.scene, t = w.engineTest
    const { createInitialWorkspace, initializeWorkspaceSnapshot, commitWorkspaceSnapshot } = await import('/canvas/workspace.ts' as string)
    const { exportWorkspace, importWorkspace } = t
    await t.tool('canvas_place', { revision: t.revision(), path: '/tmp/galta-test/movie.webm', x: 200, y: 150 })
    let bundle = createInitialWorkspace()
    bundle = initializeWorkspaceSnapshot(bundle, bundle.project.headCommitId, s.snapshot())
    await t.repository.save(bundle)
    const id = s.elements[0].id
    for (const x of [230, 260]) {
      t.apply([{ type: 'move', elementId: id, x, y: 150 }])
      bundle = await t.repository.update(bundle.project.id, (current: any) => commitWorkspaceSnapshot(current, current.project.headCommitId, s.snapshot(), 'user'))
    }
    const stored = await new Promise<any[]>(resolve => {
      const request = indexedDB.open('galta-migration-test')
      request.onsuccess = () => { const db = request.result, r = db.transaction('canvas-assets').objectStore('canvas-assets').getAll(); r.onsuccess = () => { db.close(); resolve(r.result) } }
    })
    const json = JSON.stringify(await exportWorkspace(bundle)), portable = importWorkspace(JSON.parse(json))
    s.restore(portable.snapshots[portable.project.headCommitId])
    sessionStorage.setItem('video-project', bundle.project.id)
    return { records: stored.length, binary: stored.every(f => f.blob instanceof Blob && !f.dataURL), snapshots: Object.keys(bundle.snapshots).length, portable: json.split('data:video/webm;base64,').length === 2, noRuntimeURL: !json.includes('blob:http') }
  })
  expect(result).toEqual({ records: 2, binary: true, snapshots: 3, portable: true, noRuntimeURL: true })
  await page.reload(); await page.waitForFunction(() => Boolean((window as any).engineTest))
  await page.evaluate(async () => {
    const w = window as any, bundle = await w.engineTest.repository.load(sessionStorage.getItem('video-project'))
    w.scene.restore(bundle.snapshots[bundle.project.headCommitId])
  })
  await expect(page.locator('.canvas-video img')).toBeVisible()
  await page.mouse.click(420, 240)
  await expect(page.locator('.canvas-video video')).toBeVisible()
  await expect(page.locator('.excalidraw-hyperlinkContainer')).toBeHidden()
  await expect.poll(() => page.locator('.canvas-video video').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2)
})

test('failed, cancelled and stale video imports leave artwork intact; native undo and redo retain sources', async ({ page }) => {
  const failures = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, read = w.testArtifacts.readVideo, failures: string[] = []
    t.apply([{ type: 'create_text', text: 'Keep me', x: 20, y: 20 }])
    const run = (scope?: any) => t.tool('canvas_place', { revision: t.revision(), path: '/tmp/galta-test/movie.webm' }, scope)
    w.testArtifacts.readVideo = async () => new Blob(['invalid'], { type: 'video/webm' })
    try { await run() } catch (e) { failures.push(String(e)) }
    w.testArtifacts.readVideo = read; w.failSave = true
    try { await run() } catch (e) { failures.push(String(e)) }
    w.failSave = false
    w.testArtifacts.readVideo = async () => { t.apply([{ type: 'move', elementId: w.scene.elements[0].id, x: 40, y: 40 }]); return read() }
    try { await run() } catch (e) { failures.push(String(e)) }
    const controller = new AbortController()
    w.testArtifacts.readVideo = async () => { controller.abort(Error('Stopped')); return read() }
    try { await run({ signal: controller.signal }) } catch (e) { failures.push(String(e)) }
    if (w.scene.elements.length !== 1) throw Error('Failed import changed artwork')
    w.testArtifacts.readVideo = read
    await run()
    return failures
  })
  expect(failures.join('\n')).toContain('could not be decoded')
  expect(failures.join('\n')).toContain('Storage unavailable')
  expect(failures.join('\n')).toContain('canvas changed')
  expect(failures.join('\n')).toContain('Stopped')
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+z')
  await expect(page.locator('.canvas-video')).toHaveCount(0)
  await page.keyboard.press('Meta+Shift+z')
  await expect(page.locator('.canvas-video img')).toBeVisible()
})

test('production media picker saves video sources as binary and restores the playable object', async ({ page }) => {
  await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/canvas-video.webm')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await expect(page.locator('.canvas-video img')).toBeVisible()
  await page.reload()
  await expect(page.locator('.canvas-video img')).toBeVisible()
  const bounds = (await page.locator('.canvas-video').boundingBox())!
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await expect(page.locator('.canvas-video video')).toBeVisible()
  await expect(page.locator('.excalidraw-hyperlinkContainer')).toBeHidden()
  await expect.poll(() => page.locator('.canvas-video video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0)
  await page.screenshot({ path: test.info().outputPath('production-video.png') })
})

test('copying media stays portable after the source canvas closes', { tag: '@serial' }, async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(async () => {
    const t = (window as any).engineTest
    await t.tool('canvas_place', { revision: t.revision(), path: '/tmp/galta-test/movie.webm', x: 200, y: 150 })
  })
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+c')
  await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).includes('data:video/webm;base64,'))).toBe(true)
  await page.reload(); await page.waitForFunction(() => Boolean((window as any).engineTest))
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+v')
  await expect(page.locator('.canvas-video img')).toBeVisible()
  expect(await page.evaluate(() => Object.values((window as any).scene.snapshot().document.files).every((f: any) => f.blob instanceof Blob && !f.dataURL))).toBe(true)
})


test('packaged MV3 canvas plays H.264 video using Blob URLs and survives a reload', async () => {
  const executablePath = process.env.GALTA_EXTENSION_CHROME_PATH
  test.skip(!executablePath, 'Requires an extension-capable Chromium')
  const profile = await mkdtemp(join(tmpdir(), 'galta-video-extension-')), extension = acceptanceBuild
  const browser = await chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: { width: 1440, height: 1000 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  try {
    const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker'), page = await browser.newPage()
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
    page.on('console', m => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errors.push(m.text()) })
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/canvas/index.html`)
    await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/canvas-video.mp4')
    await expect(page.locator('.pending-image')).toHaveCount(0)
    await expect(page.locator('.canvas-video img')).toBeVisible()
    await page.reload(); await expect(page.locator('.canvas-video img')).toBeVisible()
    const box = (await page.locator('.canvas-video').boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect.poll(() => page.locator('.canvas-video video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0)
    expect(await page.locator('video').getAttribute('src')).toMatch(/^blob:chrome-extension:/)
    await expect(page.locator('iframe')).toHaveCount(0)
    await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
    await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export canvas', exact: true }).click()
    const exported = await download, exportPath = test.info().outputPath('video.galta')
    await exported.saveAs(exportPath)
    const portable = JSON.parse(await readFile(exportPath, 'utf8'))
    expect(Object.values(portable.assets).some((file: any) => file.dataURL?.startsWith('data:video/mp4;base64,'))).toBe(true)
    expect(errors).toEqual([])
    await page.screenshot({ path: test.info().outputPath('video-mv3.png') })
  } finally { await browser.close(); await rm(profile, { recursive: true, force: true }) }
})
