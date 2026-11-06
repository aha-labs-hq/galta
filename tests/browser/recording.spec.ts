import { test, expect, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { controlledCodex } from '../helpers/controlled-codex'
import { connectCodex } from '../helpers/canvas-port'
import { RECORDING_EVIDENCE_LABEL } from '../../packages/capture/src/recordingEvidence'

async function open(page: Page, connectAgent = true) {
  await page.route('https://speech.galta.art/**', route => route.abort())
  await controlledCodex(page)
  await page.addInitScript(() => {
    const RealAudioContext = AudioContext
    ;(window as any).meterContexts = []
    window.AudioContext = class extends RealAudioContext {
      constructor(...args: ConstructorParameters<typeof AudioContext>) { super(...args); (window as any).meterContexts.push(this) }
    }
  })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  if (connectAgent) await connectCodex(page)
  await mockSpeech(page)
  await expect(page.getByRole('button', { name: 'Record a request', exact: true })).toBeEnabled()
}
async function mockSpeech(page: Page) {
  await page.evaluate(() => {
    const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime)
    chrome.runtime.sendMessage = (async (message: any) => {
      if (message.type === 'account' && message.request.action === 'status') return { ok: true, state: { user: (window as any).speechSignedOut ? null : { id: 'recording-test', name: 'Recording test', email: 'test@example.test', image: null }, ended: false, google: null } }
      if (message.type !== 'speech-authorize') return originalSend(message)
      ;(window as any).speechAuthorization = message.request
      if ((window as any).holdSpeechAuthorization) await new Promise(resolve => { (window as any).releaseSpeechAuthorization = resolve })
      if ((window as any).speechSignedOut) {
        window.dispatchEvent(new Event('focus'))
        return { ok: false, code: 'sign_in', error: 'Sign in with Aha Labs to transcribe. Your recording is saved.' }
      }
      return { ok: true, token: 'f'.repeat(64), expiresAt: Date.now() + 120000 }
    }) as typeof chrome.runtime.sendMessage
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      if (String(input) !== 'https://speech.galta.art/v1/transcribe') return originalFetch(input, init)
      const bytes = new Uint8Array(await new Response(init!.body).arrayBuffer()), duration = (bytes.length - 44) / 32000
      const id = new Headers(init!.headers).get('X-Galta-Recording')
      ;(window as any).recordingSpeechRequest = { id, header: String.fromCharCode(...bytes.slice(0, 4)), duration, authorization: new Headers(init!.headers).get('Authorization') }
      if ((window as any).holdSpeech) await new Promise((resolve, reject) => {
        const abort = () => reject(init!.signal!.reason)
        ;(window as any).releaseSpeech = () => { init!.signal?.removeEventListener('abort', abort); resolve(undefined) }
        init!.signal?.addEventListener('abort', abort, { once: true })
      })
      if ((window as any).speechFailure) return Response.json({ ok: false, code: 'unavailable', error: 'Speech test failure' }, { status: 503 })
      return Response.json({ ok: true, id, locale: 'zh', duration, text: 'Hidden speech fixture', words: [{ text: 'Hidden speech fixture', start: .1, end: .5 }], provider: 'cloudflare' })
    }
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination()
      oscillator.connect(gain).connect(destination); oscillator.start(); await context.resume()
      destination.stream.addEventListener('inactive', () => { void context.close() })
      ;(window as any).capturedStream = destination.stream
      ;(window as any).captureGain = gain
      return destination.stream
    }
    window.dispatchEvent(new Event('focus'))
  })
}
async function start(page: Page) {
  await page.getByRole('button', { name: 'Record a request', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeFocused()
  await expect(page.locator('.recording-rec-dot')).toHaveAttribute('data-active', 'true')
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Speech language' })).toHaveCount(0)
  const width = page.viewportSize()!.width
  await page.mouse.move(width * .4, 230); await page.mouse.move(width * .6, 360, { steps: 12 })
  await expect(page.locator('.recording-pointer')).toBeVisible()
  await expect.poll(() => page.locator('.excalidraw__canvas').last().evaluate(el => getComputedStyle(el).cursor)).toContain('data:image/svg+xml')
  await expect(page.locator('.recording-status time')).toContainText('0:01')
}
async function stop(page: Page) { await page.getByRole('button', { name: 'Stop recording', exact: true }).click() }
async function saved(page: Page, store = 'recordings') {
  return page.evaluate(async store => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('galta-message-drafts'); r.onsuccess = () => resolve(r.result) })
    const rows = await new Promise<any[]>(resolve => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => resolve(r.result) })
    db.close()
    return rows.map(row => ({ id: row.recording.packet.id, bytes: row.recording.media.size, duration: row.recording.packet.duration, points: row.recording.packet.pointers.length }))
  }, store)
}

test('stop retains an editable draft; explicit send delivers evidence and the original plays after reload', async ({ page }) => {
  await open(page)
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Keep this context.')
  await start(page); await stop(page)
  await expect.poll(() => saved(page)).toHaveLength(1)
  expect(await page.evaluate(() => Boolean((window as any).durability.active))).toBe(false)
  expect(await page.evaluate(() => (window as any).recordingSpeechRequest)).toBeUndefined()
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('Keep this context.')
  await page.reload(); await mockSpeech(page)
  await expect(page.getByRole('button', { name: 'Review recording', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Use the recording and this edit.')
  await page.getByRole('button', { name: 'Send recording', exact: true }).click()
  await page.waitForFunction(() => (window as any).durability.active)
  await expect(page.getByText('Hidden speech fixture', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('')
  await expect.poll(() => saved(page)).toHaveLength(0)
  await expect.poll(() => saved(page, 'recording-history')).toHaveLength(1)
  const original = (await saved(page, 'recording-history'))[0]
  expect(original.bytes).toBeGreaterThan(0); expect(original.points).toBeGreaterThan(0)
  const received = await page.evaluate(label => {
    const parts = (window as any).durability.input
    return { evidence: JSON.parse(parts.find((part: any) => part.text?.startsWith(label)).text.slice(label.length)), instruction: parts[0].text, images: parts.filter((part: any) => part.type === 'image').length }
  }, RECORDING_EVIDENCE_LABEL)
  expect(received.evidence.id).toBe(original.id)
  expect(received.evidence.transcript.text).toBe('Hidden speech fixture')
  expect(received.evidence.transcript.provider).toBe('cloudflare')
  expect(received.evidence.transcript.words[0].confidence).toBeUndefined()
  expect(received.instruction).toContain('Use the recording and this edit.')
  expect(received.images).toBeGreaterThanOrEqual(received.evidence.frames.length)
  const request = await page.evaluate(() => (window as any).recordingSpeechRequest)
  expect(request.locale).toBeUndefined(); expect(request.header).toBe('RIFF')
  expect(request.authorization).toBe('Bearer ' + 'f'.repeat(64))
  expect(await page.evaluate(() => (window as any).speechAuthorization)).toMatchObject({ id: original.id, digest: expect.any(String) })
  expect(JSON.stringify(received.evidence)).not.toContain('f'.repeat(64))
  await page.evaluate(() => (window as any).durability.finish())
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toHaveCount(0)
  await page.reload()
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Play sent recording', exact: true }).click()
  await expect.poll(() => page.locator('.recording-playback video').evaluate((video: HTMLVideoElement) => Number.isFinite(video.duration) && video.duration > 0 && video.readyState >= 2)).toBe(true)
  await page.locator('.recording-playback video').evaluate((video: HTMLVideoElement) => video.play())
  await expect.poll(() => page.locator('.recording-playback video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.recording-playback video')).toHaveCount(0)
})

test('signed-out Send opens the existing account view and retains recording; signing in does not auto-send', async ({ page }) => {
  await open(page); await start(page); await stop(page)
  await page.evaluate(() => { (window as any).speechSignedOut = true; window.dispatchEvent(new Event('focus')) })
  await page.getByRole('button', { name: 'Send recording', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  expect(await saved(page)).toHaveLength(1)
  expect(await page.evaluate(() => (window as any).recordingSpeechRequest)).toBeUndefined()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await page.evaluate(() => { (window as any).speechSignedOut = false; window.dispatchEvent(new Event('focus')) })
  expect(await page.evaluate(() => Boolean((window as any).durability.active))).toBe(false)
  await page.getByRole('button', { name: 'Send recording', exact: true }).click()
  await page.waitForFunction(() => (window as any).durability.active)
})

test('Stop during account authorization never uploads audio even if a grant arrives later', async ({ page }) => {
  await open(page); await start(page); await stop(page)
  await page.evaluate(() => { (window as any).holdSpeechAuthorization = true })
  await page.getByRole('button', { name: 'Send recording', exact: true }).click()
  await page.waitForFunction(() => Boolean((window as any).releaseSpeechAuthorization))
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore recording', exact: true })).toBeVisible()
  await page.evaluate(() => (window as any).releaseSpeechAuthorization())
  await expect(page.getByRole('button', { name: 'Record a request', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => (window as any).recordingSpeechRequest)).toBeUndefined()
  expect(await page.evaluate(() => Boolean((window as any).durability.active))).toBe(false)
})

test('a revoked account during accepted preparation opens Account and preserves the sent original', async ({ page }) => {
  await open(page); await start(page); await stop(page)
  // Keep the already displayed identity; revocation is discovered by the host.
  await page.evaluate(() => { (window as any).speechSignedOut = true })
  await page.getByRole('button', { name: 'Send recording', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).recordingSpeechRequest)).toBeUndefined()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore recording', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Restore recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Review recording', exact: true })).toBeVisible()
  expect(await saved(page)).toHaveLength(1)
  expect(await page.evaluate(() => Boolean((window as any).durability.active))).toBe(false)
})

for (const action of ['button', 'canvas Escape', 'stop tooltip Escape', 'cancel tooltip Escape']) test(`cancel via ${action} releases capture without saving or sending`, async ({ page }) => {
  await open(page)
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Keep this typed context.')
  await start(page)
  if (action === 'button') await page.getByRole('button', { name: 'Cancel recording', exact: true }).click()
  else {
    if (action === 'canvas Escape') await page.mouse.click(600, 300)
    else {
      await page.getByRole('button', { name: action.startsWith('stop') ? 'Stop recording' : 'Cancel recording', exact: true }).hover()
      await expect(page.getByRole('tooltip')).toContainText(action.startsWith('stop') ? 'Stop and keep draft · Enter' : 'Discard this recording · Esc')
    }
    await page.keyboard.press('Escape')
  }
  await expect(page.locator('.recording-pointer, .recording-wave')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).capturedStream.getTracks().every((track: MediaStreamTrack) => track.readyState === 'ended'))).toBe(true)
  await expect.poll(() => page.evaluate(() => (window as any).meterContexts.every((context: AudioContext) => context.state === 'closed'))).toBe(true)
  expect(await saved(page)).toHaveLength(0)
  expect(await page.evaluate(() => Boolean((window as any).durability.active))).toBe(false)
  expect(await page.evaluate(() => (window as any).speechAuthorization)).toBeUndefined()
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('Keep this typed context.')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Record a request', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Review recording', exact: true })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('Keep this typed context.')
})

test('unavailable conversation recovery retains the recording and text through reload, playback and explicit send', async ({ page }) => {
  await open(page)
  const input = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  await input.fill('Original conversation')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.waitForFunction(() => (window as any).durability.active)
  await page.evaluate(() => (window as any).durability.finish())
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toHaveCount(0)
  await input.fill('Keep the recording with this idea.')
  await start(page); await stop(page)
  await expect.poll(() => saved(page)).toHaveLength(1)
  const before = (await saved(page))[0]
  await page.evaluate(() => sessionStorage.setItem('durability-unavailable', 'true'))
  await page.reload()
  const fresh = page.getByRole('button', { name: 'Start a new conversation', exact: true })
  await expect(fresh).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send recording', exact: true })).toBeDisabled()
  await fresh.click()
  await expect(fresh).toHaveCount(0)
  await expect(input).toHaveValue('Keep the recording with this idea.')
  await expect(page.getByRole('button', { name: 'Review recording', exact: true })).toBeVisible()
  await page.reload(); await mockSpeech(page)
  await expect(input).toHaveValue('Keep the recording with this idea.')
  const recordings = await saved(page)
  expect(recordings.length).toBeGreaterThan(0)
  for (const recording of recordings) expect(recording).toEqual(before)
  await page.getByRole('button', { name: 'Review recording', exact: true }).click()
  const video = page.locator('.recording-playback video')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2)
  await video.evaluate((element: HTMLVideoElement) => element.play())
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => (window as any).durability.calls.some((call: any) => call.method === 'turn/start'))).toBe(false)
  await page.getByRole('button', { name: 'Send recording', exact: true }).click()
  await page.waitForFunction(() => (window as any).durability.active)
  const calls = await page.evaluate(() => (window as any).durability.calls)
  expect(calls.some((call: any) => call.method === 'thread/start')).toBe(true)
  expect(calls.some((call: any) => call.method === 'thread/resume')).toBe(false)
  const parts = calls.find((call: any) => call.method === 'turn/start').params.input
  expect(parts[0].text).toContain('Keep the recording with this idea.')
  expect(JSON.parse(parts.find((part: any) => part.text?.startsWith(RECORDING_EVIDENCE_LABEL)).text.slice(RECORDING_EVIDENCE_LABEL.length)).id).toBe(before.id)
  await page.evaluate(() => (window as any).durability.finish())
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toHaveCount(0)
})

test('failed processing preserves the original across reload and an explicit send retries', async ({ page }) => {
  await open(page)
  await page.evaluate(() => { (window as any).speechFailure = true })
  await start(page); await stop(page)
  await page.getByRole('button', { name: 'Send recording', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Speech test failure')
  await expect.poll(() => saved(page)).toHaveLength(0)
  const id = (await saved(page, 'recording-history'))[0].id
  await page.reload(); await mockSpeech(page)
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Restore recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Review recording', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('')
  await page.getByRole('button', { name: 'Send recording', exact: true }).click()
  await page.waitForFunction(() => (window as any).durability.active)
  await expect.poll(() => saved(page)).toHaveLength(0)
  expect((await saved(page, 'recording-history'))[0].id).toBe(id)
})

test('a failed media save never starts an agent and removal preserves typed text', async ({ page }) => {
  await open(page)
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Keep this typed context.')
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
      if (this.name === 'recordings') { IDBObjectStore.prototype.put = put; throw new DOMException('Recording quota test', 'QuotaExceededError') }
      return put.call(this, value, key!)
    }
  })
  await start(page); await stop(page)
  await expect(page.getByRole('alert')).toContainText('Recording quota test')
  expect(await saved(page)).toHaveLength(0)
  expect(await page.evaluate(() => Boolean((window as any).durability.active))).toBe(false)
  await page.getByRole('button', { name: 'Remove recording', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('Keep this typed context.')
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeFocused()
})

test('hiding the view saves a recording without treating the interruption as Send', async ({ page }) => {
  await open(page); await start(page)
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
  await expect(page.getByRole('button', { name: 'Review recording', exact: true })).toBeVisible()
  await expect.poll(() => saved(page)).toHaveLength(1)
  expect(await page.evaluate(() => Boolean((window as any).durability.active))).toBe(false)
})

for (const width of [320, 390]) test(`one-button recording fits ${width}px and restored playback keeps keyboard focus`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(page); await start(page)
  const dock = await page.locator('.conversation-dock').boundingBox()
  expect(dock!.x).toBeGreaterThanOrEqual(0); expect(dock!.x + dock!.width).toBeLessThanOrEqual(width)
  expect(dock!.height).toBeLessThan(70)
  await page.screenshot({ path: `output/recording-verification/ripple-recording-active-${width}.png` })
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await expect.poll(() => saved(page)).toHaveLength(1)
  expect(await page.evaluate(() => Boolean((window as any).durability.active))).toBe(false)
  await page.getByRole('button', { name: 'Review recording', exact: true }).click()
  await expect(page.locator('.recording-playback video')).toBeVisible()
  const playback = await page.locator('.recording-playback').boundingBox()
  expect(playback!.x).toBeGreaterThanOrEqual(0); expect(playback!.x + playback!.width).toBeLessThanOrEqual(width)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Review recording', exact: true })).toBeFocused()
  await expect(page.locator('.recording-playback video')).toHaveCount(0)
  await expect.poll(() => saved(page)).toHaveLength(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
})


test('a writer conflict preserves the recording and restores it for an explicit resend', async ({ page }) => {
  await open(page); await start(page); await stop(page)
  await page.getByRole('button', { name: 'Send recording', exact: true }).click()
  await page.waitForFunction(() => (window as any).durability.active)
  const firstId = (await saved(page, 'recording-history'))[0].id
  await page.evaluate(() => (window as any).durability.finish())
  await expect(page.getByRole('button', { name: 'Record a request', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const runtime = (window as any).chrome.runtime, send = runtime.sendMessage
    runtime.sendMessage = (request: any) => request.method === 'thread/resume'
      ? Promise.resolve({ ok: false, error: 'thread durability-thread already has an active writer' }) : send(request)
  })
  await start(page); await stop(page)
  await page.getByRole('button', { name: 'Send recording', exact: true }).click()
  await expect(page.getByRole('alert').getByText('Conversation is busy', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Restore recording', exact: true })).toBeVisible()
  await expect.poll(() => saved(page)).toHaveLength(0)
  await expect.poll(() => saved(page, 'recording-history')).toHaveLength(2)
  const failedId = (await saved(page, 'recording-history')).find(row => row.id !== firstId)!.id
  await page.reload(); await mockSpeech(page)
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Restore recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Review recording', exact: true })).toBeVisible()
  expect((await saved(page))[0].id).toBe(failedId)
  expect(await page.evaluate(() => Boolean((window as any).durability.active))).toBe(false)
  expect(await page.evaluate(() => (window as any).recordingSpeechRequest)).toBeUndefined()
  await page.getByRole('button', { name: 'Send recording', exact: true }).click()
  await page.waitForFunction(() => (window as any).durability.active)
  // Task recovery reuses the retained transcript instead of charging ASR again.
  expect(await page.evaluate(() => (window as any).recordingSpeechRequest)).toBeUndefined()
  await expect.poll(() => saved(page)).toHaveLength(0)
  const ids = (await saved(page, 'recording-history')).map(row => row.id)
  expect(ids.filter(id => id === failedId)).toHaveLength(2)
})

test('the pointer refracts artwork with voice, clears in silence, and unmounts on cancel', async ({ page }) => {
  // Read pixels immediately after the draw, only in this correctness test.
  // Production can discard its drawing buffer and never stalls on readback.
  await page.addInitScript(() => {
    const draw = WebGLRenderingContext.prototype.drawArrays
    WebGLRenderingContext.prototype.drawArrays = function(...args) {
      draw.apply(this, args)
      const canvas = this.canvas as HTMLCanvasElement
      if (!canvas.classList.contains('recording-field') || args[0] !== this.TRIANGLES) return
      const pixels = new Uint8Array(canvas.width * canvas.height * 4)
      this.readPixels(0, 0, canvas.width, canvas.height, this.RGBA, this.UNSIGNED_BYTE, pixels)
      const original = document.querySelector<HTMLCanvasElement>('.excalidraw__canvas')!, a = original.getBoundingClientRect(), b = canvas.getBoundingClientRect()
      const scale = original.width / a.width, width = Math.round(b.width * scale)
      const base = original.getContext('2d')!.getImageData(Math.round((b.x - a.x) * scale), Math.round((b.y - a.y) * scale), width, width).data
      let visible = 0, shifted = 0
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const i = ((canvas.height - 1 - y) * canvas.width + x) * 4, j = (Math.floor(y * width / canvas.height) * width + Math.floor(x * width / canvas.width)) * 4
        const alpha = pixels[i + 3]!
        if (alpha) visible++
        if (alpha > 80 && pixels[i]! / (alpha / 255) < 120 && base[j]! > 230) shifted++
      }
      ;(window as any).refractionPixels = { visible, shifted }
      ;(window as any).refractionContext = this
    }
  })
  await open(page); await start(page)
  // A deterministic stripe fixture behind the pointer makes displacement
  // observable. It is not a quality claim about speech recognition.
  await page.evaluate(() => {
    const source = document.querySelector<HTMLCanvasElement>('.excalidraw__canvas')!, box = source.getBoundingClientRect(), context = source.getContext('2d')!
    context.save(); context.setTransform(source.width / box.width, 0, 0, source.height / box.height, 0, 0)
    context.fillStyle = '#fafafa'; context.fillRect(200, 150, 500, 350)
    context.fillStyle = '#222'; for (let x = 200; x < 700; x += 12) context.fillRect(x, 150, 3, 350)
    context.restore()
  })
  await page.mouse.move(360, 290); await page.mouse.move(420, 310, { steps: 12 })
  await expect.poll(() => page.evaluate(() => (window as any).refractionPixels?.visible ?? 0)).toBeGreaterThan(100)
  await expect.poll(() => page.evaluate(() => (window as any).refractionPixels?.shifted ?? 0)).toBeGreaterThan(10)
  await page.screenshot({ path: 'output/recording-verification/ripple-artwork.png' })
  await expect(page.locator('.recording-pointer svg')).toHaveCount(0)
  await page.evaluate(() => (window as any).capturedStream.getAudioTracks().forEach((track: MediaStreamTrack) => { track.enabled = false }))
  await expect(page.locator('.recording-field')).toBeHidden()
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.mouse.move(450, 330)
  await expect(page.locator('.recording-field')).toBeHidden()
  await page.getByRole('button', { name: 'Cancel recording', exact: true }).click()
  await expect(page.locator('[data-recording-pointer], .recording-pointer, .recording-wave')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).refractionContext.isContextLost())).toBe(true)
})


test('the browser owns the cursor across resize and GPU loss; controls retain native feedback', async ({ page }) => {
  await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function(type: any, options: any): any {
      const context = get.call(this, type, options)
      if (type === 'webgl' && this.classList.contains('recording-field')) (window as any).pointerGPU = context
      return context
    }
  })
  await open(page); await start(page)
  const position = async (x: number, y: number) => {
    await page.mouse.move(x, y)
    const cursor = await page.locator('.excalidraw__canvas').last().evaluate(el => getComputedStyle(el).cursor)
    expect(cursor).toContain('data:image/svg+xml')
    expect(cursor).not.toBe('none')
    await expect(page.locator('.recording-head')).toHaveCount(0)
  }
  await position(850, 420)
  await page.setViewportSize({ width: 1050, height: 800 }); await position(600, 300)
  await page.evaluate(() => (window as any).pointerGPU.getExtension('WEBGL_lose_context').loseContext())
  await position(650, 350)
  await expect(page.locator('.recording-field')).toBeHidden()
  await page.getByRole('button', { name: 'Cancel recording', exact: true }).hover()
  await expect(page.locator('.recording-pointer')).toBeHidden()
  await expect(page.locator('[data-recording-pointer]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel recording', exact: true }).click()
})

test('moving the pointer leaves emitted refraction behind and starts new waves along the path @serial', async ({ page }) => {
  await page.addInitScript(() => {
    const draw = WebGLRenderingContext.prototype.drawArrays
    WebGLRenderingContext.prototype.drawArrays = function(...args) {
      draw.apply(this, args)
      const canvas = this.canvas as HTMLCanvasElement, w = window as any
      if (!w.trackWaveOrigins || !canvas.classList.contains('recording-field') || args[0] !== this.TRIANGLES) return
      const program = this.getParameter(this.CURRENT_PROGRAM)
      let size = 0
      for (let i = 0; i < this.getProgramParameter(program, this.ACTIVE_UNIFORMS); i++) {
        const uniform = this.getActiveUniform(program, i)!
        if (uniform.name === 'waves[0]') size = uniform.size
      }
      const rect = canvas.getBoundingClientRect(), centerX = rect.x + rect.width / 2, centerY = rect.y + rect.height / 2
      const origins = []
      for (let i = 0; i < size; i++) {
        const value = this.getUniform(program, this.getUniformLocation(program, `waves[${i}]`)) as Float32Array
        if (value[3]! > .01) origins.push({ x: centerX + value[0]!, y: centerY - value[1]! })
      }
      const pixels = new Uint8Array(canvas.width * canvas.height * 4)
      this.readPixels(0, 0, canvas.width, canvas.height, this.RGBA, this.UNSIGNED_BYTE, pixels)
      let behind = 0
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const px = rect.x + x * rect.width / canvas.width, py = rect.bottom - y * rect.height / canvas.height
        if (Math.hypot(px - 500, py - 400) < 45 && pixels[(y * canvas.width + x) * 4 + 3]! > 50) behind++
      }
      w.movingVoice = { origins, behind, width: rect.width, height: rect.height }
    }
  })
  await open(page); await start(page)
  await page.mouse.move(500, 400)
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)))
  await page.evaluate(async () => {
    ;(window as any).trackWaveOrigins = true
    ;[...document.querySelectorAll('.excalidraw__canvas')].at(-1)!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: 620, clientY: 400 }))
    await new Promise<void>(resolve => { let frames = 0; const tick = () => { if (++frames === 5) resolve(); else requestAnimationFrame(tick) }; requestAnimationFrame(tick) })
  })
  const result = await page.evaluate(() => (window as any).movingVoice)
  console.log(JSON.stringify(result))
  expect(result.origins.some((p: any) => Math.abs(p.x - 500) < 1 && Math.abs(p.y - 400) < 1)).toBe(true)
  expect(result.origins.some((p: any) => p.x > 535 && p.x < 621)).toBe(true)
  expect(result.behind).toBeGreaterThan(50)
  // Transformed DOM bounds can report 336.00003 for a 336 CSS-pixel field.
  expect(result.width).toBeLessThanOrEqual(336.001); expect(result.height).toBeLessThanOrEqual(336.001)
  await page.screenshot({ path: 'output/recording-verification/voice-moving-origins.png', clip: { x: 390, y: 290, width: 340, height: 220 } })
  await page.getByRole('button', { name: 'Cancel recording', exact: true }).click()
})

for (const density of [1, 2]) test.describe(`pointer rendering at ${density}x density`, () => {
test.use({ deviceScaleFactor: density })
test('soft speech stays visible on blank light and dark artwork at normal scale @serial', async ({ page }) => {
  await page.addInitScript(() => {
    const draw = WebGLRenderingContext.prototype.drawArrays
    WebGLRenderingContext.prototype.drawArrays = function(...args) {
      draw.apply(this, args)
      const w = window as any, probe = w.voiceProbe
      if (!probe || !(this.canvas as HTMLCanvasElement).classList.contains('recording-field') || args[0] !== this.TRIANGLES || ++probe.frames % 3) return
      const pixels = new Uint8Array(this.drawingBufferWidth * this.drawingBufferHeight * 4)
      this.readPixels(0, 0, this.drawingBufferWidth, this.drawingBufferHeight, this.RGBA, this.UNSIGNED_BYTE, pixels)
      let contrast = 0, visible = 0
      for (let i = 0; i < pixels.length; i += 4) {
        const change = Math.abs(pixels[i]! - probe.background * pixels[i + 3]! / 255)
        contrast = Math.max(contrast, change)
        if (change >= 6) visible++
      }
      probe.samples.push({ contrast, area: visible / devicePixelRatio ** 2 })
    }
  })
  await open(page); await start(page)
  await page.evaluate(() => { (window as any).captureGain.gain.value = .04 })
  await page.mouse.move(650, 400)
  for (const background of [247, 32]) {
    const result = await page.evaluate(async background => {
      const w = window as any, source = document.querySelector<HTMLCanvasElement>('.excalidraw__canvas')!, box = source.getBoundingClientRect(), context = source.getContext('2d')!
      context.save(); context.setTransform(source.width / box.width, 0, 0, source.height / box.height, 0, 0)
      context.fillStyle = `rgb(${background} ${background} ${background})`; context.fillRect(300, 180, 800, 500); context.restore()
      // Let the previous loud fixture's waves and the artwork cache expire.
      await new Promise(resolve => setTimeout(resolve, 1000))
      w.voiceProbe = { background, frames: 0, samples: [] }
      await new Promise(resolve => setTimeout(resolve, 1100))
      const samples = w.voiceProbe.samples as { contrast: number; area: number }[]
      w.voiceProbe = undefined
      const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!
      return { samples: samples.length, contrast: median(samples.map(s => s.contrast)), area: median(samples.map(s => s.area)) }
    }, background)
    console.log(JSON.stringify({ density, background, ...result }))
    await page.screenshot({ path: `output/recording-verification/voice-${background}-${density}x.png`, clip: { x: 420, y: 250, width: 460, height: 300 } })
    expect(result.samples).toBeGreaterThan(10)
    expect(result.contrast).toBeGreaterThan(10)
    expect(result.area).toBeGreaterThan(100)
  }
  await page.getByRole('button', { name: 'Cancel recording', exact: true }).click()
})
test('fine motion, sharp reversals and stationary silence keep a bounded clean field @serial', async ({ page }) => {
  await open(page); await start(page)
  await page.evaluate(() => {
    const field = document.querySelector<HTMLCanvasElement>('.recording-field')!
    ;(window as any).fieldGPU = field.getContext('webgl')
    const source = document.querySelector<HTMLCanvasElement>('.excalidraw__canvas')!, box = source.getBoundingClientRect(), context = source.getContext('2d')!
    context.save(); context.setTransform(source.width / box.width, 0, 0, source.height / box.height, 0, 0)
    context.fillStyle = '#f7f7f7'; context.fillRect(260, 180, 800, 460)
    context.fillStyle = '#ddd'; for (let x = 260; x < 1060; x += 24) context.fillRect(x, 180, 1, 460)
    context.fillStyle = '#252525'; context.font = '32px system-ui'; context.fillText('Point. Speak. Create.', 420, 270)
    context.fillStyle = '#535353'; context.font = '15px system-ui'; context.fillText('Keep the canvas in view.', 420, 305)
    context.restore()
  })
  for (const motion of ['sweep', 'fine', 'reverse', 'sweep-dark']) {
    if (motion === 'sweep-dark') await page.evaluate(() => {
      const source = document.querySelector<HTMLCanvasElement>('.excalidraw__canvas')!, box = source.getBoundingClientRect(), context = source.getContext('2d')!
      context.save(); context.setTransform(source.width / box.width, 0, 0, source.height / box.height, 0, 0)
      context.fillStyle = '#202326'; context.fillRect(260, 180, 800, 460)
      context.fillStyle = '#33373a'; for (let x = 260; x < 1060; x += 24) context.fillRect(x, 180, 1, 460)
      context.fillStyle = '#eee'; context.font = '32px system-ui'; context.fillText('Point. Speak. Create.', 420, 270)
      context.restore()
    })
    await page.evaluate(async motion => {
      const canvas = [...document.querySelectorAll('.excalidraw__canvas')].at(-1)!
      await new Promise<void>(resolve => {
        let frame = 0
        const drive = () => {
          const t = frame / 60
          const x = motion.startsWith('sweep') ? 650 + Math.cos(t * 5) * 190 : motion === 'fine' ? 650 + t * 36 : 650 + Math.sin(t * 8) * 160
          const y = motion.startsWith('sweep') ? 430 + Math.sin(t * 5) * 90 : motion === 'fine' ? 400 + Math.sin(t * 2) * 8 : 430 + Math.sin(t * 16) * 24
          canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: x, clientY: y }))
          if (++frame < 60) requestAnimationFrame(drive); else resolve()
        }; requestAnimationFrame(drive)
      })
    }, motion)
    await page.screenshot({ path: `output/recording-verification/field-${motion}-${density}x.png`, clip: { x: 260, y: 180, width: 800, height: 460 } })
    expect(await page.evaluate(() => (window as any).fieldGPU.getError())).toBe(0)
  }
  await page.evaluate(() => (window as any).capturedStream.getAudioTracks().forEach((track: MediaStreamTrack) => { track.enabled = false }))
  await expect(page.locator('.recording-field')).toBeHidden()
  const idle = await page.evaluate(async () => {
    const gl = (window as any).fieldGPU, draw = gl.drawArrays.bind(gl)
    let draws = 0; gl.drawArrays = (...args: any[]) => { draws++; draw(...args) }
    await new Promise(resolve => setTimeout(resolve, 250))
    gl.drawArrays = draw
    return draws
  })
  expect(idle).toBe(0)
  await page.getByRole('button', { name: 'Cancel recording', exact: true }).click()
  expect(await page.evaluate(() => (window as any).fieldGPU.isContextLost())).toBe(true)
})
})

test('pending shader compilation never queries blocking link status or uniforms @serial', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    const proto = WebGLRenderingContext.prototype, get = proto.getProgramParameter, uniform = proto.getUniformLocation, extension = proto.getExtension
    const w = window as any
    w.compilation = { ready: false, links: 0, uniforms: 0, polls: 0 }
    proto.getExtension = function(name: string) {
      if (name === 'KHR_parallel_shader_compile') return { COMPLETION_STATUS_KHR: 0x91b1 } as any
      return extension.call(this, name)
    }
    proto.getProgramParameter = function(program, name) {
      if ((this.canvas as HTMLCanvasElement).classList.contains('recording-field')) {
        if (name === 0x91b1) { w.compilation.polls++; return w.compilation.ready }
        if (name === this.LINK_STATUS) w.compilation.links++
      }
      return get.call(this, program, name)
    }
    proto.getUniformLocation = function(program, name) { if ((this.canvas as HTMLCanvasElement).classList.contains('recording-field')) w.compilation.uniforms++; return uniform.call(this, program, name) }
  })
  await start(page)
  const pending = await page.evaluate(() => (window as any).compilation)
  expect(pending.polls).toBeGreaterThan(2)
  expect(pending.links).toBe(0); expect(pending.uniforms).toBe(0)
  await page.evaluate(() => { (window as any).compilation.ready = true })
  await expect.poll(() => page.evaluate(() => (window as any).compilation.uniforms)).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.querySelector<HTMLCanvasElement>('.recording-field')!.getContext('webgl')!.getError())).toBe(0)
  await page.getByRole('button', { name: 'Cancel recording', exact: true }).click()
  await expect(page.locator('.recording-pointer')).toHaveCount(0)
})

test('Escape during microphone permission invalidates a late stream without losing typed context', async ({ page }) => {
  await open(page)
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Keep my typed draft.')
  await page.evaluate(() => {
    const acquire = navigator.mediaDevices.getUserMedia
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { (window as any).grantMicrophone = async () => resolve(await acquire.call(navigator.mediaDevices, { audio: true })) })
  })
  await page.getByRole('button', { name: 'Record a request', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await page.evaluate(() => (window as any).grantMicrophone())
  await expect.poll(() => page.evaluate(() => (window as any).capturedStream.getTracks().every((track: MediaStreamTrack) => track.readyState === 'ended'))).toBe(true)
  await expect.poll(() => page.evaluate(() => (window as any).meterContexts.every((context: AudioContext) => context.state === 'closed'))).toBe(true)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('Keep my typed draft.')
  await expect(page.getByRole('button', { name: 'Record a request', exact: true })).toBeEnabled()
  expect(await saved(page)).toHaveLength(0)
  expect(await page.evaluate(() => Boolean((window as any).durability.active))).toBe(false)
})

test('stopping speech processing ignores the late response and preserves the next draft', async ({ page }) => {
  await open(page); await start(page); await stop(page)
  await page.evaluate(() => { (window as any).holdSpeech = true })
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Preserve this edit.')
  await page.getByRole('button', { name: 'Send recording', exact: true }).click()
  await page.waitForFunction(() => Boolean((window as any).releaseSpeech))
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('My next thought.')
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore recording', exact: true })).toBeVisible()
  await page.evaluate(() => (window as any).releaseSpeech())
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('My next thought.')
  await expect.poll(() => saved(page)).toHaveLength(0)
  expect(await saved(page, 'recording-history')).toHaveLength(1)
  expect(await page.evaluate(() => Boolean((window as any).durability.active))).toBe(false)
})

test('Enter stops capture; IME and dialogs retain their keys, and holding Enter never sends', async ({ page }) => {
  await open(page)
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).focus()
  await page.keyboard.press('Shift+R')
  await expect(page.getByRole('button', { name: 'Record a request', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Record a request', exact: true }).focus()
  await page.keyboard.press('Shift+R')
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeEnabled()
  await expect(page.locator('.conversation-composer')).not.toHaveAttribute('data-morphing')
  await expect(page.locator('.recording-rec-dot')).toHaveAttribute('data-active', 'true')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeEnabled()
  await page.mouse.click(600, 300)
  await page.waitForTimeout(600)
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })))
  await expect(page.locator('.recording-rec-dot')).toHaveAttribute('data-active', 'true')
  await page.keyboard.down('Enter')
  await expect(page.getByRole('button', { name: 'Review recording', exact: true })).toBeVisible()
  await expect.poll(() => saved(page)).toHaveLength(1)
  expect(await page.evaluate(() => Boolean((window as any).durability.active))).toBe(false)
  const input = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  await expect(input).toHaveValue('R')
  await input.focus()
  await page.keyboard.down('Enter')
  expect(await page.evaluate(() => (window as any).speechAuthorization)).toBeUndefined()
  expect(await page.evaluate(() => Boolean((window as any).durability.active))).toBe(false)
  await page.keyboard.up('Enter')
  await input.press('Enter')
  await page.waitForFunction(() => (window as any).durability.active)
})

test('continuous composer motion preserves its controls and reverses without layout animation @serial', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('The same draft stays here.')
  await page.evaluate(() => {
    const w = window as any, form = document.querySelector('.conversation-composer')!
    w.originalInput = form.querySelector('.composer-input'); w.originalRecord = form.querySelector('.recording-primary'); w.originalClock = form.querySelector('.recording-status time')
    w.frames = []; w.layoutKeys = new Set(); w.reservations = 0
    w.reservationObserver = new MutationObserver(() => { w.reservations++ })
    w.reservationObserver.observe(document.querySelector('.galta-shell'), { attributes: true, attributeFilter: ['style'] })
    w.frameStop = false
    const sample = () => {
      const box = form.getBoundingClientRect(), clip = getComputedStyle(form).clipPath
      const top = clip === 'none' ? 0 : parseFloat(clip.slice(6)) + 4
      w.frames.push({ height: box.height - top, width: box.width, bottom: box.bottom, opacity: getComputedStyle(form.querySelector('.recording-primary')!).opacity })
      for (const animation of form.getAnimations({ subtree: true })) for (const frame of animation.effect!.getKeyframes()) for (const key of ['height', 'width', 'paddingTop', 'marginBottom']) if (key in frame) w.layoutKeys.add(key)
      if (!w.frameStop) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.getByRole('button', { name: 'Record a request', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.conversation-composer')?.hasAttribute('data-morphing'))
  await page.waitForTimeout(40)
  await page.getByRole('button', { name: 'Cancel recording', exact: true }).evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.locator('.conversation-composer')).not.toHaveAttribute('data-morphing')
  const result = await page.evaluate(() => {
    const w = window as any; w.frameStop = true; w.reservationObserver.disconnect()
    return { frames: w.frames, layoutKeys: [...w.layoutKeys], reservations: w.reservations,
      same: w.originalInput === document.querySelector('.composer-input') && w.originalRecord === document.querySelector('.recording-primary') && w.originalClock === document.querySelector('.recording-status time'),
      animations: document.querySelector('.conversation-composer')!.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length }
  })
  console.log(JSON.stringify({ motion: { reservations: result.reservations, opacity: [...new Set(result.frames.map((f: any) => f.opacity))], widths: [...new Set(result.frames.map((f: any) => f.width))], bottoms: [...new Set(result.frames.map((f: any) => f.bottom))] } }))
  expect(result.same).toBe(true); expect(result.layoutKeys).toEqual([])
  expect(result.reservations).toBeLessThanOrEqual(6)
  expect(result.frames.some((f: any) => f.height > 49 && f.height < 87)).toBe(true)
  expect(result.frames.every((f: any) => f.opacity === '1' && Math.abs(f.width - result.frames[0].width) < 1 && Math.abs(f.bottom - result.frames[0].bottom) < 1)).toBe(true)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('The same draft stays here.')
  await expect.poll(() => page.locator('.conversation-composer').evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length)).toBe(0)
  expect(await saved(page)).toHaveLength(0)
})


test('recording before connecting an agent retains locally and keeps connection controls out of capture', async ({ page }) => {
  await open(page, false)
  await page.getByRole('button', { name: 'Record a request', exact: true }).click()
  await expect(page.locator('.recording-rec-dot')).toHaveAttribute('data-active', 'true')
  await expect(page.locator('.recording-status time')).toContainText('0:01')
  await expect(page.getByRole('button', { name: 'Connect to send', exact: true })).toHaveCount(0)
  await stop(page)
  await expect.poll(() => saved(page)).toHaveLength(1)
  expect(await page.evaluate(() => Boolean((window as any).durability.active))).toBe(false)
  await page.getByRole('button', { name: 'Connect to send', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: /^Chat in Galta/ }).click()
  await page.getByRole('button', { name: 'Back to your canvas', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Send recording', exact: true })).toBeEnabled()
  await expect.poll(() => saved(page)).toHaveLength(1)
})


test('recording Send is acknowledged before speech processing and leaves the composer usable @serial', async ({ page }) => {
  await open(page); await start(page); await stop(page)
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('The submitted recording.')
  await page.evaluate(() => {
    const w = window as any
    w.holdSpeech = true; w.sendProbe = { started: performance.now(), longTasks: [], frames: [] }
    document.addEventListener('click', () => { w.sendProbe.started = performance.now() }, { once: true, capture: true })
    w.sendObserver = new PerformanceObserver(list => { for (const entry of list.getEntries()) w.sendProbe.longTasks.push(entry.duration) })
    w.sendObserver.observe({ type: 'longtask' })
    let previous = performance.now()
    const frame = (now: number) => {
      w.sendProbe.frames.push(now - previous); previous = now
      if (!w.sendProbe.acknowledged && document.querySelector('[aria-label="Play sent recording"]') && (document.querySelector('[aria-label="Ask Galta"]') as HTMLTextAreaElement)?.value === '') w.sendProbe.acknowledged = now - w.sendProbe.started
      if (!w.sendProbe.done) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
  await page.getByRole('button', { name: 'Send recording', exact: true }).click()
  await page.waitForFunction(() => Boolean((window as any).releaseSpeech))
  await page.waitForTimeout(500)
  const probe = await page.evaluate(() => { const w = window as any; w.sendProbe.done = true; w.sendObserver.disconnect(); return { ...w.sendProbe, elapsed: performance.now() - w.sendProbe.started, text: document.body.innerText } })
  await test.info().attach('send-response', { body: JSON.stringify(probe, null, 2), contentType: 'application/json' })
  await writeFile(test.info().outputPath('send-response.json'), JSON.stringify(probe, null, 2))
  await page.screenshot({ path: test.info().outputPath('send-held.png') })
  await expect(page.getByRole('button', { name: 'Play sent recording', exact: true })).toBeVisible({ timeout: 500 })
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('')
  expect(probe.acknowledged).toBeGreaterThan(0)
  expect(probe.acknowledged).toBeLessThan(500)
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('My next thought.')
  expect(await page.evaluate(() => Boolean((window as any).durability.active))).toBe(false)
  await page.evaluate(() => (window as any).releaseSpeech())
  await page.waitForFunction(() => (window as any).durability.active)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('My next thought.')
  expect(await page.evaluate(() => (window as any).durability.input[0].text)).toContain('The submitted recording.')
  expect(await page.evaluate(() => (window as any).durability.input[0].text)).not.toContain('My next thought.')
})
