import { chromium } from '@playwright/test'
import { brushStrokes } from '../tests/helpers/brush-workload'

// Optional private scene fixture. Receipts contain counts/timings, never art.
const fixture = process.argv[2] ? await Bun.file(process.argv[2]).json() : null
const snapshots = Number(process.env.GALTA_BENCH_SNAPSHOTS ?? 45)
const browser = await chromium.launch({ executablePath: process.env.GALTA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
try {
  const page = await browser.newPage({ viewport: { width: 1908, height: 914 }, deviceScaleFactor: 2 })
  await page.goto(process.env.GALTA_SEMANTICS_URL ?? 'http://127.0.0.1:5173/dev/scene-test.html')
  await page.waitForFunction(() => !!(window as any).engineTest)
  await page.evaluate(({ fixture, brushStrokes }) => {
    const w = window as any, s = w.scene
    if (fixture) { s.restore({ engine: 'excalidraw', version: 1, document: { elements: fixture.elements, files: fixture.files }, view: fixture.view }); s.select(fixture.selection) }
    else { w.engineTest.apply(brushStrokes); s.fit(); s.select(s.elements.slice(0, 40).map((el: any) => el.id)) }
  }, { fixture, brushStrokes })
  await page.waitForTimeout(500)
  const interaction = await page.evaluate(async () => {
    const w = window as any, s = w.scene, element = document.querySelector('.excalidraw') as any
    let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))!]
    while (!fiber.stateNode?.scene) fiber = fiber.return
    const app = fiber.stateNode, durations: number[] = [], hits: string[][] = []
    // Cover empty space, portrait interiors and overlapping selected strokes.
    for (let y = 100; y < 850; y += 75) for (let x = 100; x < 1850; x += 175) {
      await new Promise(requestAnimationFrame)
      const p = s.point({ x, y }), start = performance.now()
      hits.push(app.getElementsAtPosition(p.x, p.y).map((el: any) => el.id))
      durations.push(performance.now() - start)
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(hits)))
    durations.sort((a, b) => a - b)
    return { elements: s.elements.length, points: s.elements.reduce((n: number, e: any) => n + (e.points?.length ?? 0), 0), selected: s.selectedIds.length,
      calls: durations.length, totalMs: durations.reduce((a, b) => a + b), p95Ms: durations[Math.floor(durations.length * .95)], maxMs: durations.at(-1),
      hitDigest: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('') }
  })
  const storage = await page.evaluate(async snapshots => {
    const w = window as any, s = w.scene, repo = w.engineTest.repository
    const snapshot = s.snapshot(), id = 'interaction-benchmark'
    let bundle: any = { project: { id, title: 'Benchmark', headCommitId: 'head', commits: {}, branches: {}, createdAt: 1, updatedAt: 1 }, captures: [], snapshots: {}, revision: 1 }
    // With the incident fixture, 45 copies reproduce roughly 9 million stored
    // points. The default synthetic scene is smaller; receipts count both.
    for (let i = 0; i < snapshots; i++) { bundle.snapshots[i === snapshots - 1 ? 'head' : String(i)] = structuredClone(snapshot); await new Promise(resolve => setTimeout(resolve, 0)) }
    const longTasks: number[] = []
    const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)))
    observer.observe({ entryTypes: ['longtask'] })
    let start = performance.now(); await repo.save(bundle); const saveMs = performance.now() - start
    bundle = null
    start = performance.now(); const loaded = await repo.load(id); const loadMs = performance.now() - start
    w.benchmarkWorkspace = loaded
    const arrays = Object.values(loaded.snapshots).flatMap((s: any) => s.document.elements.flatMap((e: any) => e.points ? [e.points] : [])) as any[][]
    start = performance.now(); await repo.update(id, (current: any) => ({ ...current, canvasView: { commitId: 'head', ...snapshot.view, scrollX: snapshot.view.scrollX + 1 } })); const updateMs = performance.now() - start
    const unique = [...new Set(arrays)]
    await new Promise(resolve => setTimeout(resolve, 100)); observer.disconnect()
    const viewTasks: number[] = [], viewObserver = new PerformanceObserver(list => viewTasks.push(...list.getEntries().map(e => e.duration)))
    viewObserver.observe({ entryTypes: ['longtask'] })
    start = performance.now()
    const viewSaved = await repo.saveView(id, { commitId: 'head', ...snapshot.view, scrollX: snapshot.view.scrollX + 2 })
    const viewMs = performance.now() - start
    await new Promise(resolve => setTimeout(resolve, 100)); viewObserver.disconnect()
    return { snapshots, storedPoints: arrays.reduce((n, a) => n + a.length, 0), uniquePoints: unique.reduce((n, a) => n + a.length, 0), saveMs, loadMs, updateMs, longTasks, viewSaved, viewMs, viewTasks }
  }, snapshots).catch(error => ({ snapshots, error: String(error) }))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.collectGarbage') // Isolated benchmark only.
  const heap = await cdp.send('Runtime.getHeapUsage')
  console.log(JSON.stringify({ date: new Date().toISOString(), browser: browser.version(), viewport: [1908, 914], dpr: 2, interaction, storage, heap }, null, 2))
} finally { await browser.close() }
