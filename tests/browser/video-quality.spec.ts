import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'
import { storedWorkspace } from '../helpers/stored-workspace'
import { previewHistory } from './history-helpers'

async function sceneVideo(page: import('@playwright/test').Page) {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const source = (await readFile('tests/fixtures/canvas-video.webm')).toString('base64')
  await page.evaluate(async source => {
    const w = window as any
    w.testArtifacts.readVideo = async () => (await fetch(`data:video/webm;base64,${source}`)).blob()
    await w.engineTest.tool('canvas_place', { revision: w.engineTest.revision(), path: '/tmp/galta-test/movie.webm', x: 200, y: 150, width: 480 })
  }, source)
}

test('video keyboard controls cannot move, delete or redraw artwork; Escape returns focus to the canvas', async ({ page }) => {
  await sceneVideo(page)
  const before = await page.evaluate(() => (window as any).engineTest.revision())
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Enter')
  const player = page.locator('.canvas-video video')
  await expect(player).toBeVisible(); await expect(player).toBeFocused()
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0)
  await page.keyboard.press('Space'); await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 't', 'Delete']) await page.keyboard.press(key)
  expect(await page.evaluate(() => (window as any).engineTest.revision())).toBe(before)
  expect(await page.evaluate(() => (window as any).scene.api.getAppState().activeTool.type)).toBe('selection')
  await page.keyboard.press('Escape')
  await expect(player).toHaveCount(0); await expect(page.locator('.excalidraw')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  expect(await page.evaluate(() => (window as any).engineTest.revision())).not.toBe(before)
})

test('offscreen and hidden players release their decoder and resume position, volume and paused state', async ({ page }) => {
  await sceneVideo(page)
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Enter')
  const player = page.locator('.canvas-video video')
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2)
  await player.evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = .8; v.volume = .25; v.muted = true })
  await page.evaluate(() => (window as any).scene.api.updateScene({ appState: { scrollX: -10000 } }))
  await expect(player).toHaveCount(0); await expect(page.locator('.canvas-video img')).toHaveCount(0)
  await page.evaluate(() => (window as any).scene.api.updateScene({ appState: { scrollX: 0 } }))
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2)
  expect(await player.evaluate((v: HTMLVideoElement) => ({ time: v.currentTime, volume: v.volume, muted: v.muted, paused: v.paused }))).toEqual({ time: .8, volume: .25, muted: true, paused: true })
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
  await expect(player).toHaveCount(0)
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')) })
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2)
  expect(await player.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(.8)
  expect(await player.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
})

test('200-video board keeps one decoder, stable URLs during gestures, and no offscreen media DOM', { tag: '@serial' }, async ({ page }) => {
  await sceneVideo(page)
  await page.evaluate(async () => {
    const w = window as any, s = w.scene, original = s.elements[0], files = s.assets, elements = []
    const originalVideo = original.customData.video
    for (let i = 0; i < 200; i++) {
      const fileId = `video-${i}`, posterId = `poster-${i}`
      files[fileId] = { ...files[originalVideo.fileId], id: fileId }; files[posterId] = { ...files[originalVideo.posterId], id: posterId }
      elements.push({ ...original, id: `element-${i}`, x: 70 + i % 10 * 125, y: 80 + Math.floor(i / 10) * 44, width: 108, height: 36, customData: { video: { ...originalVideo, fileId, posterId } } })
    }
    s.replace(elements, files)
    await new Promise(requestAnimationFrame)
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL
    w.videoURLs = new Set(); w.createdURLs = 0
    URL.createObjectURL = function(blob) { const url = create.call(URL, blob); w.createdURLs++; if (blob instanceof Blob && blob.type.startsWith('video/')) w.videoURLs.add(url); return url }
    URL.revokeObjectURL = function(url) { w.videoURLs.delete(url); revoke.call(URL, url) }
  })
  await expect(page.locator('.canvas-video')).toHaveCount(200)
  await expect(page.locator('video')).toHaveCount(0)
  await expect.poll(() => page.locator('.canvas-video img').evaluateAll(images => images.every(img => (img as HTMLImageElement).naturalWidth > 0))).toBe(true)
  await page.evaluate(() => { const s = (window as any).scene; s.select(['element-0']) })
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Enter')
  await expect(page.locator('video')).toHaveCount(1)
  await page.locator('video').evaluate((video: HTMLVideoElement) => { video.loop = true })
  const before = await page.evaluate(() => (window as any).createdURLs)
  const measurements = await page.evaluate(async () => {
    const s = (window as any).scene, frames: number[] = []
    // Separate steady interaction from initial poster uploads and JIT work.
    for (let i = 0; i < 20; i++) await new Promise(requestAnimationFrame)
    let previous = performance.now()
    for (let i = 0; i < 90; i++) {
      s.api.updateScene({ appState: { scrollX: i % 2 } })
      await new Promise(requestAnimationFrame)
      const now = performance.now(); frames.push(now - previous); previous = now
    }
    frames.sort((a, b) => a - b)
    return { median: frames[45], p95: frames[85], sourceURLs: (window as any).videoURLs.size }
  })
  console.log('200-video gesture frames (ms):', measurements)
  expect(measurements.sourceURLs).toBe(1)
  expect(measurements.p95).toBeLessThan(60)
  expect(await page.evaluate(() => (window as any).createdURLs)).toBe(before)
  await page.evaluate(() => (window as any).scene.api.updateScene({ appState: { scrollX: -10000 } }))
  await expect(page.locator('video, .canvas-video img')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).videoURLs.size)).toBe(0)
})

test('mixed-media deletion and image recovery from history preserve the remaining video', async ({ page }) => {
  await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/canvas-video.webm')
  await expect(page.locator('.canvas-video img')).toBeVisible()
  await page.locator('nav input[type=file]').setInputFiles({ name: 'image.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#c89466"/></svg>') })
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  await expect(page.locator('.pending-image')).toHaveCount(0)
  const original = await storedWorkspace(page)
  await page.getByRole('button', { name: 'More selection actions', exact: true }).click()
  await page.getByRole('button', { name: 'Delete selection', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await previewHistory(page, original.project.headCommitId)
  await page.getByRole('button', { name: 'Bring back 1 object', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  await page.reload(); await expect(page.locator('.canvas-video img')).toBeVisible()
  const box = (await page.locator('.canvas-video').boundingBox())!
  await page.mouse.click(box.x + 16, box.y + 16)
  await page.getByRole('button', { name: 'Play video', exact: true }).click()
  await expect(page.locator('video')).toBeVisible()
})

for (const width of [1440, 360]) test(`video controls, replacement and source download stay coherent at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 }); await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/canvas-video.webm')
  await expect(page.getByRole('button', { name: 'Play video', exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath(`poster-${width}.png`) })
  await page.getByRole('button', { name: 'Export selection', exact: true }).click()
  await expect(page.getByRole('button', { name: /^PNG image/ })).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: /^Original file/ }).click()
  const savedVideo = await download
  expect(savedVideo.suggestedFilename()).toBe('canvas-video.webm')
  const videoPath = test.info().outputPath('original.webm')
  await savedVideo.saveAs(videoPath)
  expect(await readFile(videoPath)).toEqual(await readFile('tests/fixtures/canvas-video.webm'))
  await page.getByRole('button', { name: 'Back to selection actions', exact: true }).click()
  await page.getByRole('button', { name: 'More selection actions', exact: true }).click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Replace video', exact: true }).click()
  await (await chooser).setFiles('tests/fixtures/canvas-video.mp4')
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await expect(page.locator('.canvas-video')).toHaveAttribute('aria-label', 'Video: canvas-video.mp4')
  await page.getByRole('button', { name: 'Play video', exact: true }).click()
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: 'Play video', exact: true })).toBeDisabled()
  await page.screenshot({ path: test.info().outputPath(`playing-${width}.png`) })
  expect(await page.locator('.galta-shell').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
})

test('large portable media export runs off the UI thread and yields a readable source', { tag: '@serial' }, async ({ page }) => {
  await page.goto('/dev/scene-test.html'); await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const { portableMedia } = await import('/canvas/portableMedia.ts' as string)
    const bytes = new Uint8Array(32_000_000); bytes[0] = 7; bytes[bytes.length - 1] = 9
    const file = { id: 'large', mimeType: 'video/webm', created: 1, blob: new Blob([bytes], { type: 'video/webm' }) }
    let frames = 0, running = true
    const tick = () => { if (running) { frames++; requestAnimationFrame(tick) } }; requestAnimationFrame(tick)
    const start = performance.now()
    const output = await portableMedia({ kind: 'clipboard', document: { elements: [], files: { large: file } } })
    running = false
    const elapsed = performance.now() - start
    const saved = JSON.parse(await output.text()).files.large
    const decoded = new Uint8Array(await (await fetch(saved.dataURL)).arrayBuffer())
    return { frames, elapsed, length: decoded.length, first: decoded[0], last: decoded.at(-1) }
  })
  console.log('32 MB portable export:', result)
  expect(result.frames).toBeGreaterThan(2)
  expect(result).toMatchObject({ length: 32_000_000, first: 7, last: 9 })
})

test('production 200-video board stays responsive during actual pan gestures', { tag: '@serial' }, async ({ page }) => {
  await sceneVideo(page)
  const portable = await page.evaluate(async () => {
    const w = window as any, s = w.scene, original = s.elements[0], files = s.assets, elements = [], video = original.customData.video
    for (let i = 0; i < 200; i++) {
      const fileId = `video-${i}`, posterId = `poster-${i}`
      files[fileId] = { ...files[video.fileId], id: fileId }; files[posterId] = { ...files[video.posterId], id: posterId }
      elements.push({ ...original, id: `element-${i}`, x: 70 + i % 10 * 125, y: 90 + Math.floor(i / 10) * 42, width: 108, height: 34, customData: { video: { ...video, fileId, posterId } } })
    }
    s.replace(elements, files)
    const { createInitialWorkspace, initializeWorkspaceSnapshot } = await import('/canvas/workspace.ts' as string)
    const initial = createInitialWorkspace()
    return w.engineTest.exportWorkspace(initializeWorkspaceSnapshot(initial, initial.project.headCommitId, s.snapshot()))
  })
  await installReturningAccount(page); await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect(page.getByRole('button', { name: 'Import media', exact: true })).toBeVisible()
  await page.getByLabel('Import canvas file', { exact: true }).setInputFiles({ name: 'stress.galta', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(portable)) })
  await expect(page.locator('.canvas-video')).toHaveCount(200)
  await expect.poll(() => page.locator('.canvas-video img').evaluateAll(images => images.every(img => (img as HTMLImageElement).naturalWidth > 0))).toBe(true)
  const before = (await page.locator('.canvas-video').first().boundingBox())!.x
  const frames = await page.evaluate(async () => {
    const target = document.querySelector('.excalidraw__canvas.interactive')!, times: number[] = []
    for (let i = 0; i < 20; i++) await new Promise(requestAnimationFrame)
    let previous = performance.now()
    for (let i = 0; i < 120; i++) {
      target.dispatchEvent(new WheelEvent('wheel', { deltaX: i % 2 ? 3 : -2, deltaY: 0, clientX: 600, clientY: 500, bubbles: true, cancelable: true }))
      await new Promise(requestAnimationFrame)
      const now = performance.now(); times.push(now - previous); previous = now
    }
    times.sort((a, b) => a - b)
    return { median: times[60]!, p95: times[114]! }
  })
  expect((await page.locator('.canvas-video').first().boundingBox())!.x).not.toBe(before)
  console.log('Production 200-video pan frames (ms):', frames)
  expect(frames.median).toBeLessThan(25)
  expect(frames.p95).toBeLessThan(50)
  await expect(page.locator('video')).toHaveCount(0)
})

test('legacy media markers render efficiently without rewriting saved artwork on restore', async ({ page }) => {
  await sceneVideo(page)
  const restored = await page.evaluate(() => {
    const s = (window as any).scene, saved = structuredClone(s.snapshot())
    saved.document.elements[0].link = '/galta-video'
    s.restore(saved)
    return { saved: s.snapshot().document.elements[0].link, applied: s.elements[0].link }
  })
  expect(restored).toEqual({ saved: '/galta-video', applied: 'galta:video' })
  await expect(page.locator('.canvas-video img')).toBeVisible()
})
