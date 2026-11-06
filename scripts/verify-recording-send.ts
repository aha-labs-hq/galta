/** Isolated extension acceptance. Synthetic audio and mocked speech; no paid
 * inference, real account session, user profile or installed build is touched. */
import { expect } from '@playwright/test'
import { writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { installedExtension } from './lib/installed-extension'

const root = resolve(import.meta.dir, '..')
const installed = await installedExtension(root, { prefix: 'galta-recording-send-', codexCommand: async ({ directory }) => {
  const host = join(directory, 'codex-fixture.js')
  const built = await Bun.build({ entrypoints: [join(root, 'tests/helpers/task-codex-host.ts')], target: 'bun' })
  if (!built.success) throw new Error(built.logs.map(String).join('\n'))
  await writeFile(host, await built.outputs[0]!.text())
  return [process.execPath, host, join(directory, 'fixture-port')]
} })
const { browser, worker, origin, directory } = installed
try {
  await worker.evaluate(() => chrome.storage.local.set({ 'galta.ai.enabled': true }))
  let page = await browser.newPage()
  await page.goto(`${origin}/canvas/index.html`)
  await expect(page.getByRole('button', { name: 'Record a request', exact: true })).toBeEnabled({ timeout: 15_000 })
  await expect.poll(async () => (await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] }))).length).toBe(1)
  // Offscreen documents are CDP targets, not Playwright pages. Attach to this
  // disposable extension's exact target to stub only hosted speech at its owner.
  const inspector = await browser.newPage()
  const cdp = await browser.newCDPSession(inspector)
  const targets = await cdp.send('Target.getTargets')
  const target = targets.targetInfos.find(target => target.url.startsWith(origin) && target.url.includes('/tasks/'))
  if (!target) throw new Error('No offscreen task target')
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })
  let serial = 0
  const evaluate = (expression: string): Promise<any> => new Promise((resolve, reject) => {
    const id = ++serial
    const timer = setTimeout(() => finish(new Error('Offscreen evaluation timed out')), 15_000)
    const finish = (error?: Error, value?: unknown) => { clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', message); error ? reject(error) : resolve(value) }
    const message = (event: { sessionId: string; message: string }) => {
      if (event.sessionId !== sessionId) return
      const result = JSON.parse(event.message)
      if (result.id !== id) return
      if (result.error || result.result?.exceptionDetails) finish(new Error(JSON.stringify(result)))
      else finish(undefined, result.result?.result?.value)
    }
    cdp.on('Target.receivedMessageFromTarget', message)
    void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }) }).catch(error => finish(error))
  })
  await evaluate(`(${function () {
    const w = window as any, send = chrome.runtime.sendMessage.bind(chrome.runtime), fetch = window.fetch.bind(window)
    chrome.runtime.sendMessage = (async (message: any) => message.type === 'speech-authorize' ? { ok: true, token: 'f'.repeat(64), expiresAt: Date.now() + 120_000 } : send(message)) as typeof chrome.runtime.sendMessage
    window.fetch = async (input, init) => {
      if (String(input) !== 'https://speech.galta.art/v1/transcribe') return fetch(input, init)
      const bytes = new Uint8Array(await new Response(init!.body).arrayBuffer()), duration = (bytes.length - 44) / 32_000
      const id = new Headers(init!.headers).get('X-Galta-Recording')
      w.speechRequest = { id, duration, header: String.fromCharCode(...bytes.slice(0, 4)) }
      await new Promise(resolve => { w.releaseSpeech = resolve })
      return Response.json({ ok: true, id, duration, locale: 'en', text: 'Synthetic recorded request.', words: [{ text: 'Synthetic', start: .1, end: .5 }], provider: 'cloudflare' })
    }
  }.toString()})()`)
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime)
    chrome.runtime.sendMessage = (async (message: any) => message.type === 'account' ? { ok: true, state: { user: { id: 'fixture', name: 'Fixture', email: 'fixture@example.test', image: null }, ended: false, google: null } } : send(message)) as typeof chrome.runtime.sendMessage
    window.dispatchEvent(new Event('focus'))
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext(), oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination()
      oscillator.connect(destination); oscillator.start(); await audio.resume()
      destination.stream.addEventListener('inactive', () => { void audio.close() })
      return destination.stream
    }
  })
  await page.getByRole('button', { name: 'Record a request', exact: true }).click()
  await expect(page.locator('.recording-status time')).toContainText('0:01')
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click()
  await page.getByRole('button', { name: 'Send recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Play sent recording', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('')
  await expect.poll(() => evaluate('Boolean(window.speechRequest)')).toBe(true)
  const audio = await evaluate('window.speechRequest')
  expect(audio.header).toBe('RIFF')
  expect(audio.duration).toBeGreaterThan(.5)
  const state = async () => (await fetch(`http://127.0.0.1:${await readFile(join(directory, 'fixture-port'), 'utf8')}`)).json() as Promise<any>
  // Closing the view must not cancel processing, evidence rendering or task
  // submission. The inspector is an unconnected blank page, not a Galta client.
  await page.close()
  await evaluate('window.releaseSpeech(); true')
  await expect.poll(async () => (await state().catch(() => null))?.active?.turn.status, { timeout: 15_000 }).toBe('inProgress')
  page = await browser.newPage(); await page.goto(`${origin}/canvas/index.html?project=default-project`)
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Play sent recording', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore recording', exact: true })).toBeVisible()
  console.log(JSON.stringify({ offscreenAudioDecoded: true, preparedWavSeconds: audio.duration, acknowledgedBeforeSpeech: true, taskContinuedWithoutView: true, stoppedOriginalRestorable: true, hostedInferenceCalls: 0 }))
} catch (error) {
  const logs = { canvas: await readFile(join(directory, 'canvas.log'), 'utf8').catch(String), codex: await readFile(join(directory, 'codex.log'), 'utf8').catch(String) }
  const inspect = await browser.newPage()
  await inspect.goto(`${origin}/canvas/index.html?project=default-project`)
  await inspect.getByRole('button', { name: 'Open conversation', exact: true }).click().catch(() => {})
  console.error(JSON.stringify({ page: await inspect.locator('body').innerText(), ...logs }))
  throw error
} finally { await browser.close(); await rm(directory, { recursive: true, force: true }) }
