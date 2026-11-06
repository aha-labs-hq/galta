import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

test.beforeEach(async ({ page }) => {
  await page.goto('/dev/recording-test.html')
  // Exercise response validation after the account authorization boundary.
  // This isolated page has no extension background or signed-in web host.
  await page.evaluate(async () => {
    const runtimePath = '/shared/hostRuntime.ts'
    const { installWebRuntime } = await import(runtimePath)
    installWebRuntime({ sendMessage: async (message: any) => {
      if (message.type !== 'speech-authorize' || !message.request.id || !/^[a-f0-9]{64}$/.test(message.request.digest))
        throw new Error('Unexpected speech authorization request')
      return { ok: true, token: 'f'.repeat(64), expiresAt: Date.now() + 120_000 }
    } })
  })
})

test('timed pointer overlays change only the agent derivative, with one image for unchanged artwork', async ({ page }) => {
  const result = await page.evaluate(async root => {
    const { prepareRecordingEvidence, validateRecordingEvidence } = await import(`${root}/packages/capture/src/recordingEvidence.ts`)
    const rendererPath = '/recording/evidence.ts'
    const { renderRecordingEvidence } = await import(rendererPath)
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 240
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 480, 240)
    const original = canvas.toDataURL(), view = { x: -100, y: -200, width: 480, height: 240, zoom: 1 }
    const packet = { id: crypto.randomUUID(), projectId: 'fixture', duration: 6, microphone: true, limitations: [],
      frames: [0, 1, 2, 3, 4, 5].map(t => ({ id: `f${t}`, t, view, dataUrl: original, objectIds: [], unrenderedIds: [] })),
      pointers: [{ t: .8, x: 90, y: 100, worldX: -10, worldY: -100, kind: 'move', buttons: 0, view }, { t: 3.8, x: 390, y: 100, worldX: 290, worldY: -100, kind: 'move', buttons: 0, view }],
      transcript: { status: 'available', text: 'here there', words: [{ text: 'here', start: 1, end: 1.5 }, { text: 'there', start: 4, end: 4.5 }], audio: { activity: [{ start: 1, end: 1.5 }, { start: 4, end: 4.5 }], removedSilence: 0 } } }
    const evidence = await prepareRecordingEvidence(packet, renderRecordingEvidence)
    await validateRecordingEvidence(evidence, 'fixture')
    const image = await createImageBitmap(await (await fetch(evidence.frames[0].dataUrl)).blob())
    ctx.drawImage(image, 0, 0); image.close()
    return { frames: evidence.frames.length, annotation: evidence.frames[0].pointerOverlay, untouched: packet.frames.every(f => f.dataUrl === original),
      distinctHashes: evidence.frames[0].sha256 !== evidence.frames[0].sourceSha256,
      marked: [90, 390].map(x => [...ctx.getImageData(x, 100, 1, 1).data].slice(0, 3).some(v => v < 200)),
      locations: evidence.moments.filter((m: any) => m.kind === 'audio').map((m: any) => m.pointer[0].worldX) }
  }, `/@fs${resolve('.')}`)
  expect(result).toEqual({ frames: 1, annotation: true, untouched: true, distinctHashes: true, marked: [true, true], locations: [-10, 290] })
})

test('Cloudflare responses require matching recording identity and timing without a native helper', async ({ page }) => {
  await page.route('https://speech.galta.art/v1/transcribe', async route => {
    expect(route.request().headers().authorization).toBe(`Bearer ${'f'.repeat(64)}`)
    const body = route.request().postDataBuffer()!
    await route.fulfill({ json: { ok: true, id: crypto.randomUUID(), provider: 'cloudflare', duration: (body.length - 44) / 32000,
      text: 'unrelated recording', words: [{ text: 'unrelated recording', start: .2, end: 1 }], locale: 'en' } })
  })
  const result = await page.evaluate(async root => {
    const speechPath = '/recording/speech.ts'
    const { transcribeRecording } = await import(speechPath)
    const { prepareSpeechAudio } = await import(`${root}/packages/capture/src/speechAudio.ts`)
    const bytes = prepareSpeechAudio(new Float32Array(32000)).wav
    try { await transcribeRecording({ id: crypto.randomUUID(), duration: 2 }, new Blob([bytes], { type: 'audio/wav' }), new AbortController().signal); return '' }
    catch (error) { return String((error as Error).message) }
  }, `/@fs${resolve('.')}`)
  expect(result).toContain('Speech timing does not match')
})

for (const reason of ['cancel', 'timeout'] as const) test(`a stalled speech response releases its reader on ${reason}`, async ({ page }) => {
  const result = await page.evaluate(async ({ root, reason }) => {
    const speechPath = '/recording/speech.ts'
    const { transcribeRecording } = await import(speechPath)
    const { prepareSpeechAudio } = await import(`${root}/packages/capture/src/speechAudio.ts`)
    const bytes = prepareSpeechAudio(new Float32Array(32000)).wav
    const cancel = new AbortController()
    let readerCancelled = false
    const originalTimeout = AbortSignal.timeout
    // Accelerate only the production deadline; no inference or real wait.
    AbortSignal.timeout = ms => originalTimeout.call(AbortSignal, ms === 55_000 ? 80 : ms)
    window.fetch = async () => {
      if (reason === 'cancel') setTimeout(() => cancel.abort(), 20)
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":')); },
        cancel() { readerCancelled = true }
      }))
    }
    const request = transcribeRecording({ id: crypto.randomUUID(), duration: 2 }, new Blob([bytes], { type: 'audio/wav' }), cancel.signal)
      .then(() => ({ name: 'unexpected success', message: '' }), error => ({ name: error.name, message: error.message }))
    const result = await Promise.race([request, new Promise<{ name: string; message: string }>(resolve => setTimeout(() => resolve({ name: 'stalled', message: '' }), 1000))])
    return { ...result, readerCancelled }
  }, { root: `/@fs${resolve('.')}`, reason })
  expect(result.readerCancelled).toBe(true)
  if (reason === 'cancel') expect(result.name).toBe('AbortError')
  else expect(result.message).toContain('timed out')
})
