import { test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { createProject, asProjectId, asBranchId, asCommitId } from '../../packages/domain/src'
import { acceptanceOrigin, devOrigin } from '../../scripts/lib/acceptance'
import { controlledCodex } from '../helpers/controlled-codex'
import { connectCodex } from '../helpers/canvas-port'
import { seedWorkspace } from '../helpers/stored-workspace'
import { brushStrokes } from '../helpers/brush-workload'

test.use({ deviceScaleFactor: 2 })
// Opt-in diagnosis: real app, artwork, trusted browser input and full capture.
// Measures event-to-render submission; it does not claim physical scanout latency.
test('recording responsiveness with real artwork @serial', async ({ page }, info) => {
  test.skip(!process.env.GALTA_RECORDING_DIAG, 'Set GALTA_RECORDING_DIAG=1 to run the comparative workload')
  test.setTimeout(120_000)
  const workload = process.env.GALTA_DIAG_ART ?? 'brush', mode = process.env.GALTA_DIAG_MODE ?? 'record'
  const origin = process.env.GALTA_DIAG_DEV ? devOrigin : acceptanceOrigin
  await controlledCodex(page)
  await page.addInitScript(() => {
    const w = window as any
    w.diag = { active: false, frames: [] as number[], callbacks: [] as number[], inputs: [] as number[], queue: [] as number[], latency: [] as number[], longTasks: [] as number[], copies: 0, readbacks: 0, paints: 0, lastInput: 0, submitted: 0, previous: 0 }
    const s = w.diag
    new PerformanceObserver(list => { if (s.active) s.longTasks.push(...list.getEntries().map(e => e.duration)) }).observe({ type: 'longtask' })
    window.addEventListener('pointermove', e => { if (s.active) { s.lastInput = e.timeStamp; s.inputs.push(e.timeStamp); s.queue.push(performance.now() - e.timeStamp) } }, true)
    const raf = window.requestAnimationFrame
    window.requestAnimationFrame = fn => raf(t => { const start = performance.now(); fn(t); if (s.active) s.callbacks.push(performance.now() - start) })
    const draw = WebGLRenderingContext.prototype.drawArrays
    WebGLRenderingContext.prototype.drawArrays = function(...args) {
      const result = draw.apply(this, args)
      if (s.active && (this.canvas as HTMLCanvasElement).classList.contains('recording-field') && args[0] === this.TRIANGLE_STRIP && s.lastInput !== s.submitted) {
        s.latency.push(performance.now() - s.lastInput); s.submitted = s.lastInput
      }
      return result
    }
    const copy = CanvasRenderingContext2D.prototype.drawImage
    CanvasRenderingContext2D.prototype.drawImage = function(...args: any[]) { if (s.active) s.copies++; return copy.apply(this, args as any) }
    const blob = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function(...args: any[]) { if (s.active) s.readbacks++; return blob.apply(this, args as any) }
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(), tone = context.createOscillator(), gain = context.createGain(), output = context.createMediaStreamDestination()
      gain.gain.value = .15; tone.connect(gain).connect(output); tone.start(); await context.resume()
      output.stream.addEventListener('inactive', () => { void context.close() })
      return output.stream
    }
  })
  if (workload !== 'blank') {
    await page.goto(`${devOrigin}/dev/scene-test.html`)
    await page.waitForFunction(() => !!(window as any).engineTest)
    const operations = workload === 'dense' ? Array.from({ length: 3000 }, (_, i) => ({ type: 'create_element', id: `ink-${i}`, elementType: 'freedraw', x: 100 + (i * 37) % 1000, y: 100 + (i * 53) % 700,
      props: { points: Array.from({ length: 24 }, (_, p) => [p * 3, Math.sin((p + i) / 3) * 12]), strokeColor: '#2f2a26', strokeWidth: 2, simulatePressure: true, pressures: [] } })) : brushStrokes
    const snapshot = await page.evaluate(operations => {
      const { engineTest, scene } = window as any
      engineTest.apply(operations); scene.api.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } } })
      return scene.snapshot()
    }, operations)
    // Seed this origin before any workspace owner mounts (including Vite,
    // whose unmatched routes otherwise become a browser error document).
    await page.route(`${origin}/diagnosis-seed`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Recording fixture</title>' }))
    await page.goto(`${origin}/diagnosis-seed`)
    const project = createProject({ projectId: asProjectId('default-project'), branchId: asBranchId('fixture'), commitId: asCommitId('head') }, 0)
    await seedWorkspace(page, { project, snapshots: { head: snapshot }, captures: [], runtimeDefaults: { sessionId: 'moodboard', sessionLabel: 'New conversation', modelId: 'gpt-test', effort: 'High', providerId: 'codex-app-server' } })
  }
  if (mode === 'reduced') await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${origin}/sidepanel/index.html`); await expect(page.locator('.conversation-dock')).toBeVisible(); await connectCodex(page)
  await expect(page.getByRole('button', { name: 'Record a request', exact: true })).toBeEnabled()
  if (mode !== 'idle') await page.getByRole('button', { name: 'Record a request', exact: true }).click()
  await page.mouse.move(600, 400)
  await page.waitForTimeout(1500)
  const cdp = await page.context().newCDPSession(page)
  if (process.env.GALTA_DIAG_THROTTLE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.GALTA_DIAG_THROTTLE) })
  await cdp.send('Performance.enable')
  if (process.env.GALTA_DIAG_TRACE) {
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler', transferMode: 'ReturnAsStream' })
  }
  // Profiler startup itself may block for hundreds of milliseconds. Keep it
  // outside the workload's CPU interval; compare non-traced runs for timings.
  const before = await cdp.send('Performance.getMetrics')
  await page.evaluate(() => {
    const s = (window as any).diag; s.active = true; s.start = performance.now(); s.previous = 0
    const tick = (t: number) => { if (!s.active) return; if (s.previous) s.frames.push(t - s.previous); s.previous = t; requestAnimationFrame(tick) }; requestAnimationFrame(tick)
  })
  const start = Date.now(), duration = Number(process.env.GALTA_DIAG_MS ?? 6000)
  // Trusted input from outside rAF avoids manufacturing a one-frame delay by
  // dispatching synthetic events after the renderer's own frame callback.
  while (Date.now() - start < duration) {
    const t = (Date.now() - start) / 1000
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700 + Math.cos(t * 4) * 260, y: 400 + Math.sin(t * 5.2) * 160 })
    await new Promise(resolve => setTimeout(resolve, 4))
  }
  const result = await page.evaluate(() => {
    const s = (window as any).diag; s.active = false
    const percentile = (a: number[], q: number) => [...a].sort((a, b) => a - b)[Math.floor(a.length * q)] ?? 0
    return { elapsed: performance.now() - s.start, inputCount: s.inputs.length, frames: s.frames.length, frameP95: percentile(s.frames, .95), frameP99: percentile(s.frames, .99), frameMax: Math.max(0, ...s.frames), missedFrames: s.frames.filter((t: number) => t > 25).length,
      callbackP95: percentile(s.callbacks, .95), callbackP99: percentile(s.callbacks, .99), callbackMax: Math.max(0, ...s.callbacks), latencyP95: percentile(s.latency, .95), latencyP99: percentile(s.latency, .99), inputQueueP95: percentile(s.queue, .95), longTasks: s.longTasks, copies: s.copies, readbacks: s.readbacks }
  })
  const after = await cdp.send('Performance.getMetrics')
  const metric = (r: any, name: string) => r.metrics.find((m: any) => m.name === name)?.value ?? 0
  const seconds = metric(after, 'Timestamp') - metric(before, 'Timestamp')
  const work = Object.fromEntries(['TaskDuration', 'ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration'].map(n => [n + 'MsPerSecond', (metric(after, n) - metric(before, n)) / seconds * 1000]))
  const label = `${process.env.GALTA_DIAG_LABEL ?? 'current'}-${workload}-${mode}-${process.env.GALTA_DIAG_DEV ? 'dev' : 'release'}-${info.repeatEachIndex}`
  await mkdir('output/recording-diagnosis', { recursive: true })
  await writeFile(`output/recording-diagnosis/${label}.json`, JSON.stringify({ ...result, ...work }, null, 2))
  console.log(label, JSON.stringify({ ...result, ...work }))
  if (process.env.GALTA_DIAG_TRACE) {
    const complete = new Promise<any>(resolve => cdp.once('Tracing.tracingComplete', resolve))
    await cdp.send('Tracing.end'); const { stream } = await complete
    let trace = ''
    while (true) { const chunk = await cdp.send('IO.read', { handle: stream }); trace += chunk.data; if (chunk.eof) break }
    await cdp.send('IO.close', { handle: stream }); await writeFile(`output/recording-diagnosis/${label}.trace.json`, trace)
  }
  if (mode !== 'idle') await page.getByRole('button', { name: 'Cancel recording', exact: true }).click()
  expect(result.frames).toBeGreaterThan(0)
  expect(result.inputCount).toBeGreaterThan(0)
})
