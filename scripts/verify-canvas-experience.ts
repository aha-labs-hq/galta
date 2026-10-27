import { chromium } from '@playwright/test'

// A private compact workspace may be supplied; output contains only metrics.
// points/pressures in snapshots are indices into fixture.arrays, preserving
// structural sharing when seeded in the isolated browser. Never check art in.
const fixture = await Bun.file(process.argv[2]!).json()
const browser = await chromium.launch({ executablePath: process.env.GALTA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const result: any = { browser: browser.version(), viewport: [1908, 954, 2], stages: {} }
const selectedPreviewReady = () => {
  const preview = document.querySelector<HTMLElement>('.history-stage [data-side=selected] .history-preview')
  return !!preview && ['ready', 'empty'].includes(preview.dataset.renderState ?? '')
    && preview.dataset.previewIdentity === preview.querySelector<HTMLElement>('.history-preview-bitmap')?.dataset.renderedIdentity
}
try {
  const page = await browser.newPage({ viewport: { width: 1908, height: 954 }, deviceScaleFactor: 2 })
  page.setDefaultTimeout(30_000)
  const base = process.env.GALTA_EXPERIENCE_ORIGIN ?? 'http://127.0.0.1:5195'
  await page.goto(base + '/sidepanel/index.html'); await page.waitForSelector('.excalidraw')
  await page.goto(base + '/manifest.json')
  const storageBuild = await Bun.build({ entrypoints: ['tests/helpers/storage-entry.ts'], target: 'browser', format: 'iife' })
  if (!storageBuild.success) throw new Error('Unable to bundle the storage test adapter')
  await page.evaluate(await storageBuild.outputs[0]!.text())
  await page.evaluate(async fixture => {
    const bundle = fixture.bundle
    for (const commit of Object.values(bundle.project.commits) as any[]) commit.projectId = bundle.project.id
    for (const branch of Object.values(bundle.project.branches) as any[]) branch.projectId = bundle.project.id
    for (const snapshot of Object.values(bundle.snapshots) as any[]) for (const e of snapshot.document.elements) {
      for (const key of ['points', 'pressures']) if (typeof e[key] === 'number') e[key] = fixture.arrays[e[key]]
    }
    const Repository = (window as any).__galtaTestRepository
    delete (window as any).__galtaTestRepository
    const repository = new Repository()
    for (const item of await repository.list()) { await repository.setArchived(item.id, true); await repository.remove(item.id) }
    await repository.save(bundle)
  }, fixture)
  await page.addInitScript(() => {
    const w = window as any
    let tasks: number[] = [], gaps: number[] = [], active = true, begin = performance.now(), previous = performance.now(), writes = 0, reads = 0
    const get = IDBObjectStore.prototype.get, put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.get = function (...args) { if (active && this.name === 'workspaces') reads++; return get.apply(this, args) }
    IDBObjectStore.prototype.put = function (...args) { if (active && this.name === 'workspaces') writes++; return put.apply(this, args) }
    const observer = new PerformanceObserver(list => { if (active) tasks.push(...list.getEntries().filter(e => e.startTime >= begin).map(e => e.duration)) }); observer.observe({ entryTypes: ['longtask'] })
    const frame = () => { const now = performance.now(); if (active) gaps.push(now - previous); previous = now; requestAnimationFrame(frame) }; requestAnimationFrame(frame)
    w.audit = {
      start() { observer.takeRecords(); tasks = []; gaps = []; writes = reads = 0; active = true; begin = previous = performance.now() },
      end() { active = false; gaps.sort((a, b) => a - b); return { durationMs: performance.now() - begin, longTasks: tasks, maxFrameMs: gaps.at(-1), p95FrameMs: gaps[Math.floor(gaps.length * .95)], frames: gaps.length, reads, writes } },
      scene() {
        const el = document.querySelector('.excalidraw') as any
        let f = el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))!]
        while (f) { let h = f.memoizedState; while (h) { const v = h.memoizedState?.current; if (v?.api && typeof v.snapshot === 'function') return v; h = h.next }; f = f.return }
        throw Error('Scene missing')
      }
    }
  })
  const cdp = await page.context().newCDPSession(page)
  if (process.env.GALTA_EXPERIENCE_PROFILE === 'open') { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start') }
  await page.goto(base + '/sidepanel/index.html?project=performance-audit')
  await page.waitForSelector('.excalidraw')
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => { const input = document.querySelector('textarea'); return !!input && !input.disabled })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  result.stages.open = await page.evaluate(() => (window as any).audit.end())
  if (process.env.GALTA_EXPERIENCE_PROFILE === 'open') {
    const { profile } = await cdp.send('Profiler.stop'), nodes = new Map(profile.nodes.map(n => [n.id, n])), times = new Map<number, number>()
    profile.samples?.forEach((id, i) => times.set(id, (times.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 0)))
    result.profile = [...times].sort((a, b) => b[1] - a[1]).slice(0, 35).map(([id, us]) => ({ ...nodes.get(id)!.callFrame, selfMs: us / 1000 }))
    await cdp.send('Profiler.disable')
  }
  await page.waitForTimeout(1000)
  await cdp.send('HeapProfiler.collectGarbage'); result.retainedHeapBefore = (await cdp.send('Runtime.getHeapUsage')).usedSize
  const profileStage = process.env.GALTA_EXPERIENCE_PROFILE
  const start = async (name?: string) => {
    if (name && name === profileStage) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start') }
    await page.evaluate(name => {
      (window as any).audit.start()
      if (!name?.startsWith('historyContinuous')) return
      const state = { requested: new Set<string>(), painted: new Set<string>(), blankFrames: 0, samples: 0, active: true, current: '', inputAt: 0, requestedAt: 0, matched: false, visibleLatencies: [] as number[], staleFrames: 0, close() {} }
      ;(window as any).seekAudit = state
      const input = (event: Event) => { if ((event.target as Element).matches('input[aria-label="History position"]')) state.inputAt = performance.now() }
      const request = () => {
        const identity = (document.querySelector('.history-stage [data-side=selected] .history-preview') as HTMLElement | null)?.dataset.previewIdentity
        if (identity && identity !== state.current) { state.requested.add(identity); state.current = identity; state.requestedAt = state.inputAt || performance.now(); state.matched = false }
      }
      const observer = new MutationObserver(request)
      observer.observe(document.body, { attributes: true, attributeFilter: ['data-preview-identity'], subtree: true })
      document.addEventListener('input', input, true)
      state.close = () => { state.active = false; observer.disconnect(); document.removeEventListener('input', input, true) }
      request()
      const sample = () => {
        if (!state.active) return
        const preview = document.querySelector('.history-stage [data-side=selected] .history-preview') as HTMLElement | null
        if (preview) {
          state.samples++
          const identity = preview.dataset.previewIdentity
          request()
          const host = preview.querySelector('.history-preview-bitmap') as HTMLElement
          if (host.dataset.renderedIdentity) state.painted.add(host.dataset.renderedIdentity)
          if (identity !== host.dataset.renderedIdentity) state.staleFrames++
          else if (!state.matched) { state.matched = true; state.visibleLatencies.push(performance.now() - state.requestedAt) }
          if (!host.querySelector('canvas') && preview.dataset.renderState !== 'empty') state.blankFrames++
        }
        requestAnimationFrame(sample)
      }; requestAnimationFrame(sample)
    }, name)
  }
  const finish = async (name: string) => {
    await page.waitForTimeout(150); result.stages[name] = await page.evaluate(() => (window as any).audit.end())
    if (name.startsWith('historyContinuous')) result.stages[name].previewFrames = await page.evaluate(() => {
      const state = (window as any).seekAudit; state.close()
      const latencies = state.visibleLatencies.sort((a: number, b: number) => a - b)
      return { requested: state.requested.size, painted: state.painted.size, blankFrames: state.blankFrames, sampledFrames: state.samples,
        staleFrames: state.staleFrames, matchedRequests: latencies.length, sampledLatencyP95Ms: latencies[Math.floor(latencies.length * .95)] ?? null }
    })
    if (name === profileStage) {
      const { profile } = await cdp.send('Profiler.stop'), nodes = new Map(profile.nodes.map(n => [n.id, n])), times = new Map<number, number>()
      profile.samples?.forEach((id, i) => times.set(id, (times.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 0)))
      result.profile = [...times].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([id, us]) => ({ ...nodes.get(id)!.callFrame, selfMs: us / 1000 }))
      await cdp.send('Profiler.disable')
    }
  }
  await start(); await page.mouse.move(1100, 400); await page.mouse.move(1350, 460, { steps: 60 }); await finish('pointer')
  await start(); await page.mouse.move(1100, 400); await page.keyboard.down('Space'); await page.mouse.down(); await page.mouse.move(1260, 450, { steps: 30 }); await page.mouse.up(); await page.keyboard.up('Space'); await page.waitForTimeout(800); await finish('panAndAutosave')
  await start('zoomAndAutosave'); await page.getByRole('button', { name: 'Canvas zoom', exact: true }).click()
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Zoom out', exact: true }).click()
  await page.keyboard.press('Escape'); await page.waitForTimeout(800); await finish('zoomAndAutosave')
  const target = await page.evaluate(() => {
    const s = (window as any).audit.scene(), state = s.api.getAppState(), strokes = s.elements.filter((e: any) => e.type === 'freedraw').sort((a: any, b: any) => b.points.length - a.points.length).slice(0, 173)
    s.api.setActiveTool({ type: 'selection' }); s.select(strokes.map((e: any) => e.id))
    for (const e of strokes) { if (e.angle) continue; for (const p of e.points) { const x = (e.x + p[0] + state.scrollX) * state.zoom.value + state.offsetLeft, y = (e.y + p[1] + state.scrollY) * state.zoom.value + state.offsetTop; if (x > 400 && x < 1500 && y > 150 && y < 650) return { x, y, id: e.id, oldX: e.x, selected: strokes.length } } }
    throw Error('No visible point')
  })
  await page.waitForTimeout(100)
  await start('drag173AndAutosave'); await page.mouse.move(target.x, target.y); await page.mouse.down(); await page.mouse.move(target.x + 80, target.y + 30, { steps: 30 }); await page.mouse.up(); await page.waitForTimeout(1000); await finish('drag173AndAutosave')
  result.drag = await page.evaluate(target => { const s = (window as any).audit.scene(); return { selected: s.selectedIds.length, deltaX: s.elements.find((e: any) => e.id === target.id).x - target.oldX } }, target)
  for (let cycle = 0; cycle < 3; cycle++) {
    await start('historyOpen' + cycle); await page.getByRole('button', { name: 'Open history', exact: true }).click(); await page.getByRole('dialog', { name: 'History', exact: true }).waitFor()
    await page.waitForFunction(selectedPreviewReady)
    result.stages['historySelectedReady' + cycle] = await page.evaluate(() => (window as any).audit.end())
    await start('historyRemainingThumbnails' + cycle)
    await page.waitForFunction(() => document.querySelectorAll('.history-preview[data-render-state=loading]').length === 0); await finish('historyRemainingThumbnails' + cycle)
    if (cycle === 0) {
      await start()
      for (let i = 0; i < 5; i++) { await page.getByRole('button', { name: 'Previous version', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.history-preview[data-render-state=loading]').length === 0) }
      await finish('historyFiveSteps')
      await start('historyContinuousCold')
      const slider = page.getByRole('slider', { name: 'History position', exact: true }), box = (await slider.boundingBox())!
      await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2); await page.mouse.down()
      await page.mouse.move(box.x + 8, box.y + box.height / 2, { steps: 85 })
      await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 85 }); await page.mouse.up()
      const released = performance.now()
      await page.waitForFunction(selectedPreviewReady)
      result.coldSeekSettleMs = performance.now() - released
      await finish('historyContinuousCold')
      result.coldSelectedFrameMatches = await page.evaluate(() => {
        const preview = document.querySelector('.history-stage [data-side=selected] .history-preview') as HTMLElement
        return preview.dataset.previewIdentity === (preview.querySelector('.history-preview-bitmap') as HTMLElement).dataset.renderedIdentity
      })
    }
    await start(); await page.getByRole('button', { name: 'Close history', exact: true }).click(); await finish('historyClose' + cycle)
  }
  // Wait for idle preparation to persist the complete frame index, then test
  // a cold page load: decoding persisted PNGs must not reconstruct geometry.
  await page.waitForFunction(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('galta-v1'); r.onsuccess = () => resolve(r.result) })
    const tx = db.transaction(['workspaces', 'canvas-previews'])
    const complete = await new Promise<boolean>(resolve => {
      const r = tx.objectStore('workspaces').get('performance-audit'); r.onsuccess = () => {
        const count = tx.objectStore('canvas-previews').count(IDBKeyRange.bound(['performance-audit'], ['performance-audit', []]))
        count.onsuccess = () => resolve(count.result >= Object.keys(r.result.snapshots).length)
      }
    }); db.close(); return complete
  }, undefined, { timeout: 120_000, polling: 250 })
  await page.reload(); await page.waitForFunction(() => { const input = document.querySelector('textarea'); return !!input && !input.disabled })
  await page.getByRole('button', { name: 'Open history', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.history-preview[data-render-state=loading]').length === 0)
  await start('historyContinuousPersisted')
  const slider = page.getByRole('slider', { name: 'History position', exact: true }), box = (await slider.boundingBox())!
  await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2); await page.mouse.down()
  await page.mouse.move(box.x + 8, box.y + box.height / 2, { steps: 85 })
  await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 85 }); await page.mouse.up()
  const released = performance.now()
  await page.waitForFunction(selectedPreviewReady)
  result.persistedSeekSettleMs = performance.now() - released
  await finish('historyContinuousPersisted')
  result.persistedSelectedFrameMatches = await page.evaluate(() => {
    const preview = document.querySelector('.history-stage [data-side=selected] .history-preview') as HTMLElement
    return preview.dataset.previewIdentity === (preview.querySelector('.history-preview-bitmap') as HTMLElement).dataset.renderedIdentity
  })
  await page.getByRole('button', { name: 'Close history', exact: true }).click()
  await page.waitForTimeout(500); result.heapBeforeGC = (await cdp.send('Runtime.getHeapUsage')).usedSize
  await cdp.send('HeapProfiler.collectGarbage'); result.retainedHeapAfter = (await cdp.send('Runtime.getHeapUsage')).usedSize
  result.counts = await page.evaluate(() => { const s = (window as any).audit.scene(); return { elements: s.elements.length, points: s.elements.reduce((n: number, e: any) => n + (e.points?.length || 0), 0) } })
  console.log(JSON.stringify(result, null, 2))
} catch (error) { console.log(JSON.stringify({ ...result, error: String(error) }, null, 2)); throw error } finally { await browser.close() }
