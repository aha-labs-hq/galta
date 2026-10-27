import { test as base, expect, chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'
import type { MediaWorkload } from '../helpers/media-capacity'

// Opt-in capacity characterization, not timing assertions on shared CI hosts.
// GALTA_MEDIA_CAPACITY=1 bunx playwright test tests/browser/media-capacity.spec.ts
const enabled = process.env.GALTA_MEDIA_CAPACITY === '1'
// Incognito IndexedDB can hit a much smaller quota and keep source bytes in
// browser memory. Use a disposable on-disk profile like the real extension.
const test = base.extend({
  context: async ({ launchOptions, viewport }, use) => {
    const profile = await mkdtemp(join(tmpdir(), 'galta-media-capacity-'))
    const context = await chromium.launchPersistentContext(profile, { ...launchOptions, headless: true, viewport })
    try { for (const page of context.pages()) await page.close(); await use(context) }
    finally { await context.close(); await rm(profile, { recursive: true, force: true }) }
  },
})
test.skip(!enabled, 'Run explicitly with GALTA_MEDIA_CAPACITY=1')
const fixture = enabled ? execFileSync('bun', ['build', resolve('tests/helpers/media-capacity.ts'), '--target=browser', '--format=iife'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) : ''
const workloads: MediaWorkload[] = [
  { name: '100-videos-overview', images: 0, videos: 100, imageWidth: 1280, videoBytes: 1_000_000, layout: 'overview' },
  { name: '300-videos-overview', images: 0, videos: 300, imageWidth: 1280, videoBytes: 1_000_000, layout: 'overview' },
  { name: '1000-videos-overview', images: 0, videos: 1000, imageWidth: 1280, videoBytes: 1_000_000, layout: 'overview' },
  { name: '1000-videos-spread', images: 0, videos: 1000, imageWidth: 1280, videoBytes: 1_000_000, layout: 'spread' },
  { name: '100-images-overview', images: 100, videos: 0, imageWidth: 1280, layout: 'overview' },
  { name: '300-images-overview', images: 300, videos: 0, imageWidth: 1280, layout: 'overview' },
  { name: '1000-images-spread', images: 1000, videos: 0, imageWidth: 1280, layout: 'spread' },
  { name: '100-images-4k-spread', images: 100, videos: 0, imageWidth: 3840, layout: 'spread' },
  { name: '300-mixed-spread', images: 150, videos: 150, imageWidth: 1280, videoBytes: 1_000_000, layout: 'spread' },
  { name: '100-videos-10MB-history20', images: 0, videos: 100, imageWidth: 1280, videoBytes: 10_000_000, layout: 'spread', history: 20 },
]

for (const workload of workloads) test(`media capacity: ${workload.name}`, { tag: '@serial' }, async ({ page, context }, info) => {
  test.setTimeout(240_000)
  const browser = context.browser()!
  await installReturningAccount(context)
  // Seed through the real repository on a blank same-origin page; fixtures and
  // their generation are never resident in the measured page's JavaScript heap.
  await page.goto(`${acceptanceOrigin}/capacity-fixture`)
  const quota = await page.evaluate(() => navigator.storage.estimate())
  await page.addScriptTag({ content: fixture })
  const source = (await readFile('tests/fixtures/canvas-video.webm')).toString('base64')
  const seeded = await page.evaluate(async ({ workload, source }) => (window as any).__seedMediaCapacity(workload, source), { workload, source })
  await page.close()
  await context.addInitScript(() => {
    const w = window as any
    const state = w.__mediaCapacity = { urls: new Map<string, { type: string; size: number }>(),
      loads: new Map<string, { width: number; height: number }>(), requestedImages: new Set<string>(),
      imageErrors: 0, assetReads: 0, assetBytes: 0, readsDone: 0, assetsReadyMs: 0, longTasks: [] as { start: number; duration: number }[] }
    const create = URL.createObjectURL
    URL.createObjectURL = function(blob) {
      const url = create.call(URL, blob)
      if (blob instanceof Blob) state.urls.set(url, { type: blob.type, size: blob.size })
      return url
    }
    const image = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!
    Object.defineProperty(HTMLImageElement.prototype, 'src', { ...image, set(value: string) {
      if (value.startsWith('blob:')) {
        state.requestedImages.add(value)
        this.addEventListener('load', () => state.loads.set(value, { width: this.naturalWidth, height: this.naturalHeight }), { once: true })
        this.addEventListener('error', () => state.imageErrors++, { once: true })
      }
      image.set!.call(this, value)
    } })
    document.addEventListener('load', event => {
      const img = event.target
      if (img instanceof HTMLImageElement && img.src.startsWith('blob:')) {
        state.requestedImages.add(img.src)
        state.loads.set(img.src, { width: img.naturalWidth, height: img.naturalHeight })
      }
    }, true)
    const get = IDBObjectStore.prototype.get
    IDBObjectStore.prototype.get = function(key) {
      const request = get.call(this, key)
      if (this.name === 'canvas-assets') {
        state.assetReads++
        request.addEventListener('success', () => {
          state.readsDone++; state.assetBytes += request.result?.blob?.size ?? 0
          state.assetsReadyMs = performance.now()
        })
      }
      return request
    }
    new PerformanceObserver(list => state.longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration }))))
      .observe({ type: 'longtask', buffered: true })
  })
  const measured = await context.newPage()
  const cdp = await context.newCDPSession(measured)
  await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.send('Performance.enable')
  if (process.env.GALTA_MEDIA_PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start') }
  const errors: string[] = []
  measured.on('pageerror', error => errors.push(error.message))
  await measured.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect(measured.getByRole('region', { name: `Galta canvas, ${workload.images + workload.videos} objects`, exact: true })).toBeVisible({ timeout: 60_000 })
  const mountedMs = await measured.evaluate(() => performance.now())
  await measured.waitForFunction(() => {
    const s = (window as any).__mediaCapacity
    return s.readsDone === s.assetReads && s.requestedImages.size > 0 && s.loads.size === s.requestedImages.size
      && [...document.querySelectorAll<HTMLImageElement>('.canvas-video img')].every(img => img.complete && img.naturalWidth > 0)
  }, undefined, { timeout: 60_000 })
  const ready = await measured.evaluate(async () => {
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame)
    const s = (window as any).__mediaCapacity
    const domPosters = [...document.querySelectorAll<HTMLImageElement>('.canvas-video img')]
    return { readyMs: performance.now(), assetReads: s.assetReads, assetBytes: s.assetBytes, assetsReadyMs: s.assetsReadyMs,
      imageURLs: [...s.urls.values()].filter((v: any) => v.type.startsWith('image/')).length,
      loadedImageURLs: s.loads.size, loadedIntrinsicPixels: [...s.loads.values()].reduce((sum: number, img: any) => sum + img.width * img.height, 0),
      visiblePosters: domPosters.length, videoURLs: [...s.urls.values()].filter((v: any) => v.type.startsWith('video/')).length,
      decoders: document.querySelectorAll('video').length, imageErrors: s.imageErrors,
      startupLongTasks: s.longTasks.length, startupLongestTaskMs: Math.max(0, ...s.longTasks.map((t: any) => t.duration)) }
  })
  // Include background history/catalog preview work in the observation. A fast
  // first paint must not conceal a long task immediately after opening.
  await measured.waitForTimeout(2000)
  const background = await measured.evaluate(() => {
    const s = (window as any).__mediaCapacity
    return { atMs: performance.now(), loadedImageURLs: s.loads.size,
      loadedIntrinsicPixels: [...s.loads.values()].reduce((sum: number, img: any) => sum + img.width * img.height, 0),
      longTasks: s.longTasks.length, longestTaskMs: Math.max(0, ...s.longTasks.map((t: any) => t.duration)) }
  })
  if (process.env.GALTA_MEDIA_PROFILE) {
    const { profile } = await cdp.send('Profiler.stop')
    const path = info.outputPath('startup.cpuprofile')
    await writeFile(path, JSON.stringify(profile))
    await info.attach('startup.cpuprofile', { path, contentType: 'application/json' })
  }
  const browserCDP = await browser.newBrowserCDPSession()
  const processes = (await browserCDP.send('SystemInfo.getProcessInfo')).processInfo
  const memory = processes.map(process => {
    try { return { type: process.type, rssKiB: Number(execFileSync('ps', ['-o', 'rss=', '-p', String(process.id)], { encoding: 'utf8' }).trim()) } }
    catch { return { type: process.type, rssKiB: 0 } }
  })
  await browserCDP.detach()
  const frames = await measured.evaluate(async () => {
    const target = document.querySelector('.excalidraw__canvas.interactive')!, s = (window as any).__mediaCapacity
    const sample = async (sweep: boolean) => {
      const times: number[] = []
      for (let i = 0; i < 20; i++) await new Promise(requestAnimationFrame)
      const start = performance.now(); let previous = start
      for (let i = 0; i < 180; i++) {
        target.dispatchEvent(new WheelEvent('wheel', { deltaX: sweep ? 0 : i % 2 ? 2 : -2,
          deltaY: sweep ? 24 : 0, clientX: 700, clientY: 500, bubbles: true, cancelable: true }))
        await new Promise(requestAnimationFrame)
        const now = performance.now(); times.push(now - previous); previous = now
      }
      times.sort((a, b) => a - b)
      const tasks = s.longTasks.filter((t: any) => t.start >= start)
      return { medianMs: times[90], p95Ms: times[171], maxMs: times.at(-1),
        over33ms: times.filter(t => t > 33.4).length, longTasks: tasks.length,
        longestTaskMs: Math.max(0, ...tasks.map((t: any) => t.duration)) }
    }
    return { steady: await sample(false), sweep: await sample(true) }
  })
  const metrics = await cdp.send('Performance.getMetrics')
  const heapBytes = metrics.metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value
  const result = { workload, seeded, quota, browser: browser.version(), viewport: measured.viewportSize(), mountedMs, ...ready, background, memory, frames, heapBytes, errors }
  console.log('MEDIA_CAPACITY', JSON.stringify(result))
  const path = info.outputPath('capacity.json')
  await writeFile(path, JSON.stringify(result, null, 2))
  await info.attach('capacity.json', { path, contentType: 'application/json' })
  expect(errors).toEqual([])
  expect(ready.imageErrors).toBe(0)
  expect(ready.decoders).toBe(0)
  expect(ready.videoURLs).toBe(0)
  expect(ready.assetReads).toBe(seeded.assets)
})
