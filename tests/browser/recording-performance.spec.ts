import { test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { controlledCodex } from '../helpers/controlled-codex'
import { connectCodex } from '../helpers/canvas-port'

test.use({ deviceScaleFactor: Number(process.env.GALTA_PERF_DPR ?? 1) })

// Same real recorder and renderer, deterministic mouse path and microphone.
// This measures browser work, not physical input latency or ASR accuracy.
test('recording pointer and compositor frame budget @serial', async ({ page }, testInfo) => {
  await controlledCodex(page)
  await page.addInitScript(measureGPU => {
    const w = window as any, captured = new WeakSet<HTMLCanvasElement>()
    w.profile = { active: false, outputFrames: 0, clips: 0, trailUpdates: 0, layouts: 0, uploads: 0, gpuFrames: 0, uploadBytes: 0, uploadMs: 0, meshBytes: 0, vertices: 0, copyMs: 0, gpuMs: 0, gpuSamples: 0, gpuDisjoint: false, callbacks: [] as number[] }
    const stats = w.profile, capture = HTMLCanvasElement.prototype.captureStream
    HTMLCanvasElement.prototype.captureStream = function(rate) { captured.add(this); return capture.call(this, rate) }
    const fill = CanvasRenderingContext2D.prototype.fillRect
    CanvasRenderingContext2D.prototype.fillRect = function(...args) { if (stats.active && captured.has(this.canvas)) stats.outputFrames++; return fill.apply(this, args) }
    const clip = CanvasRenderingContext2D.prototype.clip
    CanvasRenderingContext2D.prototype.clip = function(...args: any[]) { if (stats.active && this.canvas.classList.contains('recording-refraction')) stats.clips++; return clip.apply(this, args as any) }
    const draw = WebGLRenderingContext.prototype.drawArrays, upload = WebGLRenderingContext.prototype.texSubImage2D
    const timers = new WeakMap<WebGLRenderingContext, { ext: any; pending: any[] }>()
    WebGLRenderingContext.prototype.drawArrays = function(...args) {
      if (stats.active && (this.canvas as HTMLCanvasElement).classList.contains('recording-field')) {
        if (args[0] === this.TRIANGLE_STRIP) { stats.trailUpdates++; stats.vertices += args[2] }
        if (args[0] === this.TRIANGLES) stats.gpuFrames++
      }
      if (!measureGPU || !stats.active || !(this.canvas as HTMLCanvasElement).classList.contains('recording-field')) return draw.apply(this, args)
      let timer = timers.get(this)
      if (!timer) { timer = { ext: this.getExtension('EXT_disjoint_timer_query'), pending: [] }; timers.set(this, timer) }
      const { ext, pending } = timer
      if (!ext) return draw.apply(this, args)
      if (this.getParameter(ext.GPU_DISJOINT_EXT)) stats.gpuDisjoint = true
      while (pending.length && ext.getQueryObjectEXT(pending[0], ext.QUERY_RESULT_AVAILABLE_EXT)) {
        const query = pending.shift()
        stats.gpuMs += ext.getQueryObjectEXT(query, ext.QUERY_RESULT_EXT) / 1e6; stats.gpuSamples++
        ext.deleteQueryEXT(query)
      }
      // Never wait for the GPU. A stalled device leaves bounded outstanding
      // queries and an explicit partial sample, not a synchronous readback.
      if (pending.length >= 16) return draw.apply(this, args)
      const query = ext.createQueryEXT(); ext.beginQueryEXT(ext.TIME_ELAPSED_EXT, query)
      draw.apply(this, args); ext.endQueryEXT(ext.TIME_ELAPSED_EXT); pending.push(query)
    }
    WebGLRenderingContext.prototype.texSubImage2D = function(...args: any[]) {
      const start = performance.now(), result = upload.apply(this, args as any)
      if (stats.active && (this.canvas as HTMLCanvasElement).classList.contains('recording-field')) { stats.uploads++; stats.uploadBytes += args[6].width * args[6].height * 4; stats.uploadMs += performance.now() - start }
      return result
    }
    for (const name of ['bufferData', 'bufferSubData'] as const) {
      const original = WebGLRenderingContext.prototype[name] as Function
      ;(WebGLRenderingContext.prototype[name] as Function) = function(this: WebGLRenderingContext, ...args: any[]) {
        if (stats.active && (this.canvas as HTMLCanvasElement).classList.contains('recording-field')) stats.meshBytes += args[1]?.byteLength ?? args[2]?.byteLength ?? 0
        return original.apply(this, args)
      }
    }
    const copy = CanvasRenderingContext2D.prototype.drawImage
    CanvasRenderingContext2D.prototype.drawImage = function(...args: any[]) {
      const start = performance.now(), result = copy.apply(this, args as any)
      if (stats.active) stats.copyMs += performance.now() - start
      return result
    }
    const attribute = Element.prototype.setAttribute
    Element.prototype.setAttribute = function(name, value) { if (stats.active && name === 'd' && this.classList.contains('recording-trail')) stats.trailUpdates++; return attribute.call(this, name, value) }
    const bounds = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function() { if (stats.active) stats.layouts++; return bounds.call(this) }
    const raf = requestAnimationFrame
    window.requestAnimationFrame = fn => raf(now => { const start = performance.now(); fn(now); if (stats.active && fn.name !== 'drive') stats.callbacks.push(performance.now() - start) })
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), output = context.createMediaStreamDestination()
      gain.gain.value = .15; oscillator.connect(gain).connect(output); oscillator.start(); await context.resume()
      w.meterFixture = { context, gain }
      output.stream.addEventListener('inactive', () => { void context.close() })
      return output.stream
    }
  }, !!process.env.GALTA_GPU_PROFILE)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.getByRole('button', { name: 'Record a request', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible()
  await expect(page.locator('.recording-rec-dot')).toHaveAttribute('data-active', 'true')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const metric = (result: any, name: string) => result.metrics.find((m: any) => m.name === name)?.value ?? 0
  await page.evaluate(async () => {
    const canvas = [...document.querySelectorAll('.excalidraw__canvas')].at(-1)!
    // Warm the encoder and shader before measuring steady-state work.
    await new Promise<void>(resolve => {
      const until = performance.now() + 1000
      const warm = () => { canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 600, clientY: 400, pointerType: 'mouse' })); if (performance.now() < until) requestAnimationFrame(warm); else resolve() }; warm()
    })
  })
  if (process.env.GALTA_CPU_PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start') }
  const before = await cdp.send('Performance.getMetrics')
  const result = await page.evaluate(async () => {
    const w = window as any, stats = w.profile, canvas = [...document.querySelectorAll('.excalidraw__canvas')].at(-1)!
    const frames: number[] = [], start = performance.now(); let previous = start
    stats.active = true
    await new Promise<void>(resolve => {
      function drive(now: number) {
        frames.push(now - previous); previous = now
        const points = Array.from({ length: 4 }, (_, i) => {
          const t = now - (3 - i) * 4, angle = (t - start) / 160
          const event = new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: 700 + Math.cos(angle) * 280, clientY: 400 + Math.sin(angle * 1.3) * 180 })
          Object.defineProperty(event, 'timeStamp', { value: t }); return event
        })
        const event = points.at(-1)!
        Object.defineProperty(event, 'getCoalescedEvents', { value: () => points })
        canvas.dispatchEvent(event)
        if (now - start < 2500) requestAnimationFrame(drive); else resolve()
      }
      requestAnimationFrame(drive)
    })
    stats.active = false
    const elapsed = performance.now() - start, p95 = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length * .95)] ?? 0
    const gl = document.querySelector<HTMLCanvasElement>('.recording-field')!.getContext('webgl')!
    const active = { density: devicePixelRatio, gpuMsPerDraw: stats.gpuSamples ? stats.gpuMs / stats.gpuSamples : null, gpuSamples: stats.gpuSamples, gpuDisjoint: stats.gpuDisjoint, gpuTimerAvailable: !!gl.getExtension('EXT_disjoint_timer_query'), elapsed, frames: frames.length, frameP95: p95(frames), callbackP95: p95(stats.callbacks), callbackMsPerSecond: stats.callbacks.reduce((a: number, b: number) => a + b, 0) / elapsed * 1000, outputFPS: stats.outputFrames / elapsed * 1000, trailFPS: stats.trailUpdates / elapsed * 1000, clipsPerSecond: stats.clips / elapsed * 1000, layoutsPerSecond: stats.layouts / elapsed * 1000, uploadsPerSecond: stats.uploads / elapsed * 1000, uploadBytesPerSecond: stats.uploadBytes / elapsed * 1000, uploadMsPerSecond: stats.uploadMs / elapsed * 1000, meshBytesPerSecond: stats.meshBytes / elapsed * 1000, verticesPerFrame: stats.vertices / stats.trailUpdates, copyMsPerSecond: stats.copyMs / elapsed * 1000 }
    return active
  })
  const after = await cdp.send('Performance.getMetrics')
  if (process.env.GALTA_CPU_PROFILE) { const { profile } = await cdp.send('Profiler.stop'); await mkdir('output/recording-verification', { recursive: true }); await writeFile('output/recording-verification/pointer.cpuprofile', JSON.stringify(profile)) }
  const seconds = metric(after, 'Timestamp') - metric(before, 'Timestamp')
  const browserWork = Object.fromEntries(['TaskDuration', 'ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration'].map(name => [name + 'MsPerSecond', (metric(after, name) - metric(before, name)) / seconds * 1000]))
  Object.assign(result, browserWork)
  await page.getByRole('button', { name: 'Cancel recording', exact: true }).click()
  await expect(page.locator('.recording-pointer')).toHaveCount(0)
  const stopped = await page.evaluate(async () => {
    const stats = (window as any).profile
    stats.outputFrames = 0; stats.trailUpdates = 0; stats.active = true
    await new Promise(resolve => setTimeout(resolve, 300))
    stats.active = false
    return { outputFrames: stats.outputFrames, trailUpdates: stats.trailUpdates }
  })
  expect(stopped).toEqual({ outputFrames: 0, trailUpdates: 0 })
  await mkdir('output/recording-verification', { recursive: true })
  await writeFile(`output/recording-verification/performance-${process.env.GALTA_PERF_LABEL ?? 'current'}-${testInfo.repeatEachIndex}.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  if (process.env.GALTA_PERF_LABEL !== 'before') {
    expect(result.outputFPS).toBeGreaterThan(13)
    expect(result.outputFPS).toBeLessThan(17)
    expect(result.layoutsPerSecond).toBeLessThan(30)
    expect(result.trailFPS).toBeGreaterThan(result.frames / result.elapsed * 1000 * .85)
    expect(result.clipsPerSecond).toBe(0)
    if (!process.env.GALTA_PERF_BASELINE) {
      expect(result.meshBytesPerSecond).toBeLessThan(350_000)
      expect(result.verticesPerFrame).toBeLessThan(180)
    }
  }
})
