import { test, expect } from 'bun:test'
import worker, { allowedOrigin, wavDuration, timedWords } from '../apps/speech-worker/src/index.ts'
import { prepareSpeechAudio, originalSpeechSpans } from '../packages/capture/src/speechAudio.ts'
import { parseCloudSpeechResponse } from '../packages/capture/src/cloudSpeech.ts'
import { validateRecordingWords } from '../packages/capture/src/recording.ts'
import { readFileSync } from 'node:fs'

const rate = 16000
function tone(source, start, end, amplitude = .1) {
  for (let i = start * rate; i < Math.min(source.length, end * rate); i++) source[i] = Math.sin(i * .17) * amplitude
}
function request(audio, signal) {
  return new Request('https://speech.galta.art/v1/transcribe', { method: 'POST', headers: {
    'origin': 'http://127.0.0.1:4471', 'content-type': 'audio/wav', 'x-galta-recording': crypto.randomUUID(), 'cf-connecting-ip': '192.0.2.1', authorization: 'Bearer ' + 'f'.repeat(64) }, body: audio, signal })
}
function fixture(run = async () => ({ text: 'here', transcription_info: { language: 'en' }, segments: [{ words: [{ word: 'here', start: .1, end: .5 }] }] })) {
  let calls = 0
  return { env: { ENABLED: 'true', SPEECH_LIMIT: { limit: async () => ({ success: true }) }, SPEECH_BUDGET: { getByName: () => ({ consume: async () => ({ ok: true }) }) }, AI: { run: async (...args) => { calls++; return run(...args) } } }, calls: () => calls }
}
test('quiet, brief utterances survive compaction even when not classified as activity', () => {
  const source = new Float32Array(rate * 10)
  tone(source, 1, 1.04, .003); tone(source, 4, 4.4); tone(source, 8, 8.4)
  const audio = prepareSpeechAudio(source)
  expect(audio.removedSilence).toBeGreaterThan(5)
  expect(audio.regions.some(r => r.start <= rate && r.end >= 1.04 * rate)).toBe(true)
  const pcm = new DataView(audio.wav.buffer)
  for (const region of audio.regions) for (let i = region.start; i < region.end; i++) {
    const sample = source[i]
    expect(pcm.getInt16(44 + (region.outputStart + i - region.start) * 2, true)).toBe(Math.round(sample * (sample < 0 ? 32768 : 32767)) || 0)
  }
})
test('a word crossing a splice keeps distinct original intervals and all three indications', () => {
  const source = new Float32Array(rate * 10)
  for (const start of [1, 4, 8]) tone(source, start, start + .4)
  const audio = prepareSpeechAudio(source)
  expect(audio.activity.map(a => a.start)).toEqual([1, 4, 8])
  const spans = originalSpeechSpans(audio.regions, 0, (audio.wav.length - 44) / 32000)
  expect(spans).toHaveLength(3)
  expect(spans[1].start).toBeGreaterThan(spans[0].end + 1)
  expect(validateRecordingWords([{ text: 'ambiguous span', start: spans[0].start, end: spans.at(-1).end, spans }], 10)).toHaveLength(1)
})
test('continuous speech and uncertain silence retain original PCM; nonfinite and overlong audio reject', () => {
  const source = new Float32Array(rate * 3); tone(source, 0, 3, .001)
  expect(prepareSpeechAudio(source).removedSilence).toBe(0)
  expect(prepareSpeechAudio(new Float32Array(rate)).removedSilence).toBe(0)
  expect(() => prepareSpeechAudio(new Float32Array([NaN]))).toThrow()
  expect(() => prepareSpeechAudio(new Float32Array(960001))).toThrow()
})
test('service admits only supported origins and canonical bounded WAV', async () => {
  expect(allowedOrigin('https://galta.art.evil.test')).toBeNull()
  expect(allowedOrigin('null')).toBeNull()
  expect(allowedOrigin('chrome-extension://' + 'a'.repeat(32))).toBeTruthy()
  const audio = prepareSpeechAudio(new Float32Array(rate)).wav
  expect(wavDuration(audio)).toBe(1)
  const invalid = audio.slice(); invalid[22] = 2
  expect(() => wavDuration(invalid)).toThrow()
  const f = fixture()
  expect((await worker.fetch(request(invalid), f.env)).status).toBe(400)
  const oversize = new Request(request(audio), { headers: { ...Object.fromEntries(request(audio).headers), 'content-length': '2000000' } })
  expect((await worker.fetch(oversize, f.env)).status).toBe(413)
  expect(f.calls()).toBe(0)
})
test('one audio-only call uses language autodetection, VAD and cancellation; never retries or stores', async () => {
  const f = fixture(async (model, input, options) => {
    expect(model).toBe('@cf/openai/whisper-large-v3-turbo')
    expect(Object.keys(input).sort()).toEqual(['audio', 'condition_on_previous_text', 'task', 'vad_filter'])
    expect(input.audio.contentType).toBe('audio/wav')
    expect((await new Response(input.audio.body).arrayBuffer()).byteLength).toBe(32044)
    expect(input.vad_filter).toBe(true); expect(input.condition_on_previous_text).toBe(false)
    expect(options.signal).toBeInstanceOf(AbortSignal)
    throw new Error('upstream secret diagnostic')
  })
  const response = await worker.fetch(request(prepareSpeechAudio(new Float32Array(rate)).wav), f.env)
  expect(response.status).toBe(503); expect(await response.text()).not.toContain('secret')
  expect(f.calls()).toBe(1)
})
test('rate limiting and disabled service stop before inference; empty timing is rejected', async () => {
  const audio = prepareSpeechAudio(new Float32Array(rate)).wav, f = fixture()
  f.env.SPEECH_LIMIT.limit = async () => ({ success: false })
  expect((await worker.fetch(request(audio), f.env)).status).toBe(429)
  f.env.ENABLED = 'false'
  expect((await worker.fetch(request(audio), f.env)).status).toBe(503)
  expect(f.calls()).toBe(0)
  const missing = fixture(async () => ({ text: 'do something', segments: [] }))
  expect((await worker.fetch(request(audio), missing.env)).status).toBe(502)
})
test('aborting a slow upload releases its reader and makes no model call', async () => {
  const control = new AbortController(), f = fixture(); let cancelled = false
  const stream = new ReadableStream({ cancel() { cancelled = true } })
  const r = new Request(request(prepareSpeechAudio(new Float32Array(rate)).wav, control.signal), { body: stream, duplex: 'half' })
  const result = worker.fetch(r, f.env)
  await new Promise(resolve => setTimeout(resolve, 1)); control.abort()
  expect((await result).status).toBe(499); expect(cancelled).toBe(true); expect(f.calls()).toBe(0)
})

test('provider tokens without duration keep observed grouped timing, never fabricated character times', () => {
  expect(timedWords([{ words: [{ word: 'hello', start: .2, end: .5 }, { word: '.', start: .5, end: .5 }] }]))
    .toEqual([{ text: 'hello.', start: .2, end: .5 }])
  expect(timedWords([{ text: 'a phrase', start: .1, end: .8, words: [{ word: 'a phrase', start: .8, end: .8 }] }]))
    .toEqual([{ text: 'a phrase', start: .1, end: .8 }])
})
test('shared response contract rejects misordered, missing, nonfinite and oversized timing', () => {
  const result = { ok: true, id: crypto.randomUUID(), provider: 'cloudflare', text: 'here', locale: 'en', duration: 1, words: [{ text: 'here', start: .1, end: .5 }] }
  expect(parseCloudSpeechResponse(result)).toEqual(result)
  for (const words of [[], [{ text: 'x', start: NaN, end: .5 }], [{ text: 'x', start: .8, end: 2 }], [{ text: 'x', start: .8, end: .9 }, { text: 'y', start: .1, end: .2 }]])
    expect(() => parseCloudSpeechResponse({ ...result, words })).toThrow()
})
test('client cancellation reaches an in-flight inference and never schedules a retry', async () => {
  // Bun's synthetic Request always signals abort. Workerd only does so for
  // incoming HTTP requests when this deployment flag is present.
  const config = JSON.parse(readFileSync(new URL('../apps/speech-worker/wrangler.jsonc', import.meta.url), 'utf8'))
  expect(config.compatibility_flags).toContain('enable_request_signal')
  expect(config.env.staging.compatibility_flags ?? config.compatibility_flags).toContain('enable_request_signal')
  const control = new AbortController(); let started
  const ready = new Promise(resolve => { started = resolve })
  const f = fixture(async (_, __, { signal }) => {
    started()
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  const pending = worker.fetch(request(prepareSpeechAudio(new Float32Array(rate)).wav, control.signal), f.env)
  await ready; control.abort()
  expect((await pending).status).toBe(499); expect(f.calls()).toBe(1)
})
