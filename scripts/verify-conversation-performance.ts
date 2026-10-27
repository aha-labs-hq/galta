/** Production component pressure test; no model, browser profile or workspace data. */
import { chromium } from '@playwright/test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const extensionRequire = createRequire(new URL('../apps/extension/package.json', import.meta.url))
const { build } = await import(extensionRequire.resolve('vite'))
const { default: react } = await import(extensionRequire.resolve('@vitejs/plugin-react'))
const { default: tailwindcss } = await import(extensionRequire.resolve('@tailwindcss/vite'))
const root = realpathSync(mkdtempSync(join(tmpdir(), 'galta-conversation-performance-')))
const source = resolve('apps/extension/src'), dependencies = resolve('apps/extension/node_modules')
await Bun.write(join(root, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/entry.ts"></script></body></html>')
await Bun.write(join(root, 'entry.ts'), `import ${JSON.stringify(join(source, 'dev/conversation-performance.tsx'))}`)
await build({ root, configFile: false, publicDir: false, plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': source, 'react-dom': join(dependencies, 'react-dom'), react: join(dependencies, 'react') } },
  build: { outDir: join(root, 'build'), minify: false } })
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname
  const file = resolve(root, 'build', '.' + (path === '/' ? '/index.html' : path))
  if (!file.startsWith(join(root, 'build') + '/')) return new Response('Not found', { status: 404 })
  const asset = Bun.file(file)
  return await asset.exists() ? new Response(asset) : new Response('Not found', { status: 404 })
} })
const browser = await chromium.launch({ executablePath: process.env.GALTA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const scenarios = [
  { name: 'tools', turns: 8, tools: 40, liveRepeats: 2 },
  { name: 'history', turns: 24, tools: 8, liveRepeats: 2 },
  { name: 'long-reply', turns: 8, tools: 40, liveRepeats: 100 }
]
const results: unknown[] = []
try {
  for (const scenario of scenarios) {
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      let measuring = false, previous = 0, started = 0
      let frames: number[] = [], keys: number[] = [], tasks: number[] = [], events: number[] = []
      new PerformanceObserver(list => { if (measuring) tasks.push(...list.getEntries().filter(e => e.startTime >= started).map(e => e.duration)) }).observe({ type: 'longtask' })
      new PerformanceObserver(list => { if (measuring) events.push(...list.getEntries().filter(e => e.startTime >= started && (e as any).interactionId).map(e => e.duration)) }).observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit)
      document.addEventListener('keydown', event => { if (measuring) requestAnimationFrame(() => keys.push(performance.now() - event.timeStamp)) }, true)
      const frame = (now: number) => { if (measuring && previous) frames.push(now - previous); previous = now; requestAnimationFrame(frame) }
      requestAnimationFrame(frame)
      const stats = (values: number[]) => {
        values.sort((a, b) => a - b)
        return { count: values.length, p50: values[Math.floor(values.length * .5)] ?? 0, p95: values[Math.floor(values.length * .95)] ?? 0, max: values.at(-1) ?? 0 }
      }
      ;(window as any).__measureConversation = {
        start() { measuring = true; started = performance.now(); previous = 0; frames = []; keys = []; tasks = []; events = [] },
        end() { measuring = false; return { elapsed: performance.now() - started, frames: stats(frames), keyToRaf: stats(keys), eventDuration: stats(events), longTasks: stats(tasks) } }
      }
    })
    await page.goto(`http://127.0.0.1:${server.port}/?` + new URLSearchParams(Object.entries(scenario).map(([key, value]) => [key, String(value)])))
    await page.waitForFunction(() => Boolean((window as any).__galtaPerformance))
    await page.waitForTimeout(400)
    await page.getByRole('textbox', { name: 'Ask Galta' }).focus()
    await page.evaluate(() => { (window as any).__measureConversation.start(); (window as any).__galtaPerformance.start() })
    const start = performance.now(), text = 'Please refine the spacing and keep the contrast.'
    await Promise.all([
      page.keyboard.type(text, { delay: 35 }),
      (async () => {
        const box = (await page.locator('.conversation-scroll').boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, i < 4 ? -180 : 100); await page.waitForTimeout(140) }
      })()
    ])
    await page.waitForTimeout(Math.max(400, 5000 - (performance.now() - start)))
    const metrics = await page.evaluate(() => {
      const fixture = (window as any).__galtaPerformance
      return { ...(window as any).__measureConversation.end(), ticks: fixture.stop(), activeCharacters: fixture.activeCharacters, historyCharacters: fixture.historyCharacters }
    })
    if (await page.getByRole('textbox', { name: 'Ask Galta' }).inputValue() !== text) throw new Error('Streaming lost input text')
    if (errors.length) throw new Error(errors.join('\n'))
    results.push({ ...scenario, ...metrics })
    await page.close()
  }
  const report = { browser: browser.version(), method: 'Production React, unminified; 420×900, 4× CPU slowdown, 50ms text stream, concurrent typing/scrolling; steady state after initial mount. Single runs. rAF intervals are not painted frames; key-to-rAF is not presentation latency; Event Timing samples have a 16ms threshold. Excludes the canvas, storage, model and network.', scenarios: results }
  const output = process.env.GALTA_PERF_OUTPUT ?? join(root, 'metrics.json')
  await Bun.write(output, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ output, ...report }, null, 2))
} finally { await browser.close(); server.stop() }
