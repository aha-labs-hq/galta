import { test, expect } from 'bun:test'
import { attachSpeech } from '../apps/extension/src/background/speech.ts'
import { speechRequestSchema } from '../packages/capture/src/speech.ts'

const event = () => { const handlers = []; return { addListener: fn => handlers.push(fn), emit: value => handlers.forEach(fn => fn(value)) } }
function port(sender) { return { sender, onMessage: event(), onDisconnect: event(), sent: [], closed: 0, postMessage(value) { this.sent.push(value) }, disconnect() { this.closed++ } } }
function fixture(run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome'), native = port(), calls = []
  globalThis.chrome = { runtime: { id: 'galta', getURL: () => 'chrome-extension://galta/', connectNative(name) { calls.push(name); return native } } }
  try { run({ native, calls }) } finally { if (previous) Object.defineProperty(globalThis, 'chrome', previous); else delete globalThis.chrome }
}
const request = { id: crypto.randomUUID(), locale: 'zh-CN', wav: btoa('bounded wave'.repeat(8)) }
test('automatic speech language is a bounded request without a user-selected locale', () => {
  const { locale: _, ...automatic } = request
  expect(speechRequestSchema.parse(automatic)).toEqual(automatic)
  expect(speechRequestSchema.safeParse({ ...automatic, locale: 'anything' }).success).toBe(false)
})
test('only a Galta page can reach native speech; malformed audio never starts a helper', () => fixture(({ calls }) => {
  const web = port({ id: 'galta', url: 'https://example.test/' }); attachSpeech(web)
  expect(web.closed).toBe(1); expect(calls).toHaveLength(0)
  const page = port({ id: 'galta', url: 'chrome-extension://galta/canvas/index.html' }); attachSpeech(page)
  page.onMessage.emit({ ...request, wav: 'bad' })
  expect(page.sent[0].ok).toBe(false); expect(calls).toHaveLength(0)
  expect(speechRequestSchema.safeParse({ ...request, wav: 'A'.repeat(2_560_061) }).success).toBe(false)
}))
test('one bounded speech exchange releases the native port; closing the view cancels it', () => fixture(({ native, calls }) => {
  const page = port({ id: 'galta', url: 'chrome-extension://galta/sidepanel/index.html' }); attachSpeech(page)
  page.onMessage.emit(request)
  expect(calls).toEqual(['com.galta.companion']); expect(native.sent).toEqual([{ method: 'speech/transcribe', params: request }])
  page.onMessage.emit(request); expect(native.sent).toHaveLength(1)
  page.onDisconnect.emit()
  expect(native.closed).toBe(1)
  native.onMessage.emit({ ok: false, error: 'late result' })
  expect(page.sent).toHaveLength(0)
}))
test('an old native speech response becomes an explicit update error without a fallback', () => fixture(({ native, calls }) => {
  const page = port({ id: 'galta', url: 'chrome-extension://galta/canvas/index.html' }); attachSpeech(page)
  page.onMessage.emit(request); native.onMessage.emit({ error: 'unsupported' })
  expect(page.sent).toEqual([{ ok: false, error: 'Update Galta for Mac to transcribe recorded requests.' }])
  expect(native.closed).toBe(1); expect(calls).toHaveLength(1)
}))
