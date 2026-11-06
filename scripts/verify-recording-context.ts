/** Opt-in private recording replay through the production browser recognizer.
 * Usage: bun scripts/verify-recording-context.ts <case directory> <output directory>
 *        --live | --replay=<saved speech-exchange.json>
 * Live makes exactly one inference call; verify the account's free budget first.
 * Replay requires identical WAV bytes. Neither mode opens an agent or edits a canvas.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium } from '@playwright/test'
import { validateRecordingEvidence, RECORDING_EVIDENCE_LABEL } from '../packages/capture/src/recordingEvidence'

const [casePath, outputPath, mode] = process.argv.slice(2)
if (!casePath || !outputPath || !(mode === '--live' || mode?.startsWith('--replay=')))
  throw new Error('Supply case directory, a new output directory, and --live or --replay=<speech-exchange.json>')
const directory = resolve(casePath), output = resolve(outputPath), live = mode === '--live'
// A failed trial remains evidence; never replace it with a successful retry.
await mkdir(output)
const json = (name: string, value: unknown) => Bun.write(join(output, name), JSON.stringify(value, null, 2) + '\n')
const fixture = await Bun.file(join(directory, 'regression.json')).json()
const packet = await Bun.file(join(directory, fixture.packet)).json()
for (const frame of packet.frames) frame.dataUrl = `data:image/jpeg;base64,${Buffer.from(await Bun.file(join(directory, fixture.images[frame.id] ?? fixture.images.default)).arrayBuffer()).toString('base64')}`
const replay = live ? undefined : await Bun.file(resolve(mode.slice('--replay='.length))).json()
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const browser = await chromium.launch({ executablePath: process.env.GALTA_CHROME_PATH ?? chromium.executablePath() })
let exchange: any, requests = 0
try {
  const page = await browser.newPage()
  await page.route('https://speech.galta.art/v1/transcribe', async route => {
    requests++
    assert.equal(requests, 1, 'A trial must never retry inference')
    const request = route.request(), body = request.postDataBuffer()!
    exchange = { requestSha256: sha(body), uploadedBytes: body.length, uploadedSeconds: (body.length - 44) / 32000 }
    if (live) await route.continue()
    else {
      if (exchange.requestSha256 !== replay.requestSha256) {
        exchange.error = 'Replay WAV differs from the saved request'
        await route.abort(); return
      }
      // The identity is request metadata, not recognition evidence. Timing and
      // transcript remain byte-for-byte from the saved, audio-matched response.
      await route.fulfill({ status: replay.status, json: { ...replay.response, id: request.headers()['x-galta-recording'] } })
    }
  })
  const responseBody = new Promise<void>(resolve => page.on('response', async response => {
    if (response.url() !== 'https://speech.galta.art/v1/transcribe') return
    try {
      Object.assign(exchange, { status: response.status(), serverTiming: response.headers()['server-timing'] ?? null, response: await response.json() })
    } catch (error) { Object.assign(exchange, { error: String(error) }) }
    resolve()
  }))
  const origin = process.env.GALTA_RECORDING_ORIGIN ?? 'http://127.0.0.1:4471'
  assert.equal((await page.goto(`${origin}/dev/recording-test.html`))?.status(), 200, 'Serve the source recording test document')
  const media = Buffer.from(await Bun.file(join(directory, fixture.media)).arrayBuffer()).toString('base64')
  const result = await page.evaluate(async ({ packet, media, mime, root }) => {
    const speechPath = '/recording/speech.ts', rendererPath = '/recording/evidence.ts'
    const { transcribeRecording } = await import(speechPath)
    const { prepareRecordingEvidence } = await import(`${root}/packages/capture/src/recordingEvidence.ts`)
    const { renderRecordingEvidence } = await import(rendererPath)
    const blob = new Blob([Uint8Array.from(atob(media), c => c.charCodeAt(0))], { type: mime })
    const fetchOriginal = window.fetch.bind(window)
    let requestStart = 0, headersAt = 0
    Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== 'https://speech.galta.art/v1/transcribe') return fetchOriginal(input, init)
      requestStart = performance.now()
      const response = await fetchOriginal(input, init); headersAt = performance.now(); return response
    } })
    const longTasks: { start: number; duration: number }[] = []
    const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration }))))
    observer.observe({ type: 'longtask' })
    const started = performance.now()
    try {
      packet.transcript = await transcribeRecording(packet, blob, new AbortController().signal)
      const recognizedAt = performance.now()
      const evidence = await prepareRecordingEvidence(packet, renderRecordingEvidence)
      const readyAt = performance.now()
      await new Promise(resolve => setTimeout(resolve, 0))
      return { packet, evidence, timing: { preparationMs: requestStart - started, requestMs: headersAt - requestStart,
        responseMs: recognizedAt - headersAt, evidenceMs: readyAt - recognizedAt, contextReadyMs: readyAt - started },
        longTasks: longTasks.filter(t => t.start >= started && t.start < readyAt) }
    } finally { Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: fetchOriginal }); observer.disconnect() }
  }, { packet, media, mime: fixture.mime, root: `/@fs${resolve(import.meta.dir, '..')}` })
  await responseBody
  await json('speech-exchange.json', exchange)
  await json('result.json', result)
  await validateRecordingEvidence(result.evidence, packet.projectId)
  const { pointers: _, ...compact } = result.evidence
  const message = `${RECORDING_EVIDENCE_LABEL}\n${JSON.stringify({ ...compact, frames: compact.frames.map(({ dataUrl: _, ...frame }: any) => frame) })}`
  await Bun.write(join(output, 'agent-input.txt'), message)
  for (const [i, frame] of result.evidence.frames.entries()) await Bun.write(join(output, `frame-${i + 1}.jpg`), Buffer.from(frame.dataUrl.split(',')[1]!, 'base64'))
  // Expectations are evaluator-only. They never enter ASR, rendered images or
  // agent-input, and overlapping moments must carry the same matching words.
  const checks = (fixture.utterances ?? []).map((expected: any) => {
    const moments = result.evidence.moments.filter((m: any) => m.start < expected.end && m.end > expected.start)
    const words = result.evidence.transcript.words
    const wordIds = new Set(words.flatMap((word: any, i: number) => (word.spans ?? [word]).some((s: any) => s.start < expected.end && s.end > expected.start) ? [i] : []))
    const text = [...wordIds].map(i => words[i as number].text).join('')
    const associated = moments.filter((m: any) => m.words.some((i: number) => wordIds.has(i)))
    const bounds = expected.bounds
    return { window: [expected.start, expected.end], text, speech: text.includes(expected.text),
      pointer: !bounds || associated.some((m: any) => m.pointer.some((p: any) => p.worldX >= bounds[0] && p.worldX <= bounds[0] + bounds[2] && p.worldY >= bounds[1] && p.worldY <= bounds[1] + bounds[3])) }
  })
  const passed = checks.length ? checks.every((check: any) => check.speech && check.pointer) : null
  const report = { passed, mode: live ? 'live' : 'replay', requests, ...result.timing, longTasks: result.longTasks,
    uploadedSeconds: exchange.uploadedSeconds, serverTiming: exchange.serverTiming, checks, frames: result.evidence.frames.length,
    moments: result.evidence.moments.length, agentTextBytes: Buffer.byteLength(message), agentExecutionMeasured: false,
    referenceProvenance: fixture.referenceProvenance ?? 'Not provided; no accuracy claim.' }
  await json('report.json', report)
  console.log(JSON.stringify(report))
  assert(passed !== false, 'Recording regression failed; inspect the retained report')
} catch (error) {
  await json('failure.json', { error: String(error), requests, exchange })
  throw error
} finally { await browser.close() }
