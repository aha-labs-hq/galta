import { chromium } from '@playwright/test'
import { brushBase, brushOperations } from '../tests/helpers/brush-workload'

// The optional replay is an external {base, operations} JSON file. Receipts
// contain timings/counts only, never personal artwork or conversation content.
const replay = process.argv[2] ? await Bun.file(process.argv[2]).json() : { base: brushBase, operations: brushOperations }
const url = process.env.GALTA_SEMANTICS_URL ?? 'http://127.0.0.1:5193/dev/scene-test.html'
const browser = await chromium.launch({ executablePath: process.env.GALTA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const runs = []
try {
  for (let i = 0; i < 3; i++) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
    await page.goto(url)
    await page.waitForFunction(() => !!(window as any).engineTest)
    const metrics = await page.evaluate(async ({ base, operations }) => {
      const w = window as any, t = w.engineTest, s = w.scene
      t.apply(base); s.fit(); w.replayBase = s.snapshot()
      await new Promise(resolve => setTimeout(resolve, 300))
      const gaps: number[] = [], tasks: number[] = [], stages: Record<string, number[]> = {}
      for (const name of ['prepare', 'present', 'prepareRender', 'snapshot', 'applyPrepared']) {
        const original = s[name].bind(s)
        s[name] = (...args: any[]) => {
          const start = performance.now(), result = original(...args)
          const record = () => { (stages[name] ??= []).push(performance.now() - start) }
          if (result instanceof Promise) return result.finally(record)
          record(); return result
        }
      }
      let done = false, previous = performance.now(), previewFrames = 0, maxPaths = 0
      const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => entry.duration)))
      observer.observe({ entryTypes: ['longtask'] })
      const frame = () => {
        const now = performance.now(); gaps.push(now - previous); previous = now
        const paths = document.querySelectorAll('.canvas-presentation [data-preview]').length
        if (paths) previewFrames++
        maxPaths = Math.max(maxPaths, paths)
        if (!done) requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
      const start = performance.now()
      await t.tool('canvas_edit', { revision: t.revision(), operations })
      const elapsed = performance.now() - start
      await new Promise(resolve => setTimeout(resolve, 100))
      done = true; observer.disconnect()
      return { elapsed, maxFrame: Math.max(...gaps), longTasks: tasks, previewFrames, maxPaths, stages, elements: s.elements.length }
    }, replay)
    const cancellation = await page.evaluate(async operations => {
      const w = window as any, t = w.engineTest, s = w.scene
      s.restore(w.replayBase)
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const before = t.revision(), controller = new AbortController()
      let requested = 0, delivered = 0, failure = ''
      const observer = new MutationObserver(() => {
        if (requested || !document.querySelector('.canvas-presentation [data-preview]')) return
        requested = performance.now()
        setTimeout(() => { delivered = performance.now(); controller.abort(new Error('Stopped')) }, 0)
      })
      observer.observe(document.querySelector('.canvas-presentation')!, { subtree: true, childList: true })
      try { await t.tool('canvas_edit', { revision: before, operations }, { signal: controller.signal }) }
      catch (error) { failure = String(error) }
      observer.disconnect()
      if (!requested || !failure.includes('Stopped') || before !== t.revision() || document.querySelector('.canvas-presentation [data-preview]')) throw new Error('Cancellation did not preserve the original document')
      return { inputDelay: delivered - requested, settledAfterInput: performance.now() - delivered, preserved: true }
    }, replay.operations)
    runs.push({ ...metrics, cancellation })
    await page.close()
  }
  console.log(JSON.stringify({ date: new Date().toISOString(), browser: browser.version(), url, viewport: [1440, 1000], dpr: 1,
    operations: replay.operations.length, points: replay.operations.reduce((n: number, op: any) => n + (op.props?.points?.length ?? 0), 0), runs,
    boundary: 'Real editor and native renderer with in-memory save callback; production IndexedDB is covered separately by agent-durability.spec.ts.' }, null, 2))
} finally { await browser.close() }
