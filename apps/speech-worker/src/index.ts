import { parseCloudSpeechResponse, speechDigest, SPEECH_AUDIO_BYTES } from '../../../packages/capture/src/cloudSpeech'
import { authorize } from './authorize'

export const MODEL = '@cf/openai/whisper-large-v3-turbo'
const DEADLINE = 45_000
class SpeechError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
export function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return origin
  try {
    const url = new URL(origin)
    if (url.origin !== origin) return null
    if (url.protocol === 'https:' && ['galta.art', 'www.galta.art'].includes(url.hostname)) return origin
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return origin
  } catch { /* Reject malformed origins before reading audio. */ }
  return null
}
async function boundedAudio(request: Request, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted()
  const length = request.headers.get('content-length')
  if (length && Number(length) > SPEECH_AUDIO_BYTES) throw new SpeechError(413, 'invalid_request', 'Recording audio exceeds 60 seconds.')
  if (!request.body) throw new SpeechError(400, 'invalid_request', 'Recording audio is missing.')
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break
      bytes += next.value.byteLength
      if (bytes > SPEECH_AUDIO_BYTES) { await reader.cancel(); throw new SpeechError(413, 'invalid_request', 'Recording audio exceeds 60 seconds.') }
      chunks.push(next.value)
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock() }
  signal.throwIfAborted()
  const audio = new Uint8Array(bytes); let offset = 0
  for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length }
  return audio
}
export function wavDuration(audio: Uint8Array): number {
  const invalid = () => { throw new SpeechError(400, 'invalid_request', 'Use mono 16 kHz PCM16 WAV audio, up to 60 seconds.') }
  if (audio.length < 46 || audio.length > SPEECH_AUDIO_BYTES || audio.length % 2) return invalid()
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  const text = (a: number, b: number) => String.fromCharCode(...audio.subarray(a, b))
  if (text(0, 4) !== 'RIFF' || text(8, 16) !== 'WAVEfmt ' || text(36, 40) !== 'data' ||
      view.getUint32(4, true) !== audio.length - 8 || view.getUint32(16, true) !== 16 ||
      view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 16000 ||
      view.getUint32(28, true) !== 32000 || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 ||
      view.getUint32(40, true) !== audio.length - 44) return invalid()
  return (audio.length - 44) / 32000
}

/** Zero-width punctuation/subword tokens share an observed neighbour's span.
 * Otherwise preserve the provider's whole segment rather than invent timing. */
export function timedWords(segments: NonNullable<Ai_Cf_Openai_Whisper_Large_V3_Turbo_Output['segments']>) {
  return segments.flatMap(segment => {
    const words: { text: string | undefined; start: number | undefined; end: number | undefined }[] = []
    let prefix = ''
    for (const word of segment.words ?? []) {
      if (word.start === word.end) {
        const last = words.at(-1)
        if (last && last.end === word.start) last.text = (last.text ?? '') + (word.word ?? '')
        else prefix += word.word ?? ''
      } else {
        words.push({ text: prefix + (word.word ?? ''), start: word.start, end: word.end }); prefix = ''
      }
    }
    if (prefix || !words.length) return segment.text?.trim() ? [{ text: segment.text, start: segment.start, end: segment.end }] : []
    return words
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url), origin = allowedOrigin(request.headers.get('origin'))
    const headers: Record<string, string> = { 'cache-control': 'no-store', 'content-type': 'application/json', 'vary': 'Origin', 'x-content-type-options': 'nosniff' }
    if (origin) headers['access-control-allow-origin'] = origin
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers })
    if (url.pathname === '/health' && request.method === 'GET') return reply({ ready: env.ENABLED === 'true', model: MODEL }, env.ENABLED === 'true' ? 200 : 503)
    const authorizationRoute = url.pathname === '/v1/authorize'
    if (url.pathname !== '/v1/transcribe' && !authorizationRoute) return reply({ ok: false, code: 'invalid_request', error: 'Not found.' }, 404)
    // The local web host authorizes server-to-server, with no Origin. Browser
    // origins are still checked; they are not an authentication mechanism.
    if (!origin && (!authorizationRoute || request.headers.has('origin'))) return reply({ ok: false, code: 'invalid_request', error: 'This origin is not allowed.' }, 403)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers,
      'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'Content-Type, X-Galta-Recording, Authorization', 'access-control-max-age': '86400' } })
    if (request.method !== 'POST') return reply({ ok: false, code: 'invalid_request', error: 'Use POST.' }, 405)
    if (authorizationRoute) {
      if (env.ENABLED !== 'true') return reply({ ok: false, code: 'unavailable', error: 'Speech recognition is temporarily unavailable. Your recording is saved.' }, 503)
      const ip = request.headers.get('cf-connecting-ip')
      if (!ip || !(await env.SPEECH_LIMIT.limit({ key: ip })).success) return reply({ ok: false, code: 'rate_limit', error: 'Too many requests. Your recording is saved; try again in a minute.' }, 429)
      const response = await authorize(request, env)
      return new Response(response.body, { status: response.status, headers })
    }
    const id = request.headers.get('x-galta-recording') ?? '', started = Date.now()
    let status = 200, seconds: number | undefined, upload: ReadableStream<Uint8Array> | undefined
    // One request, one model call. No automatic retry, storage or provider fallback.
    const controller = new AbortController(), abort = () => controller.abort()
    request.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, DEADLINE)
    try {
      if (request.signal.aborted) throw new SpeechError(499, 'timeout', 'Transcription cancelled.')
      if (env.ENABLED !== 'true') throw new SpeechError(503, 'unavailable', 'Speech recognition is temporarily unavailable. Your recording is saved.')
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || request.headers.get('content-type') !== 'audio/wav')
        throw new SpeechError(400, 'invalid_request', 'Invalid recording request.')
      const token = request.headers.get('authorization')?.match(/^Bearer ([0-9a-f]{64})$/)?.[1]
      if (!token) throw new SpeechError(401, 'invalid_request', 'Update Galta and sign in with Aha Labs to transcribe. Your recording is saved.')
      const ip = request.headers.get('cf-connecting-ip')
      if (!ip || !(await env.SPEECH_LIMIT.limit({ key: ip })).success) throw new SpeechError(429, 'rate_limit', 'Too many recordings. Your recording is saved; try again in a minute.')
      const audio = await boundedAudio(request, controller.signal); seconds = wavDuration(audio)
      const digest = await speechDigest(audio)
      controller.signal.throwIfAborted()
      const admission = await env.SPEECH_BUDGET.getByName('whisper-allowance').consume(token, { id, digest }, seconds)
      if (!admission.ok) throw new SpeechError(admission.status, admission.status === 429 ? 'rate_limit' : 'invalid_request', admission.error)
      upload = new Response(audio).body!
      controller.signal.throwIfAborted()
      const inferenceStart = Date.now()
      const output = await env.AI.run(MODEL, { audio: { body: upload, contentType: 'audio/wav' }, task: 'transcribe',
        vad_filter: true, condition_on_previous_text: false }, { signal: controller.signal })
      controller.signal.throwIfAborted()
      headers['server-timing'] = `prepare;dur=${inferenceStart - started},inference;dur=${Date.now() - inferenceStart}`
      headers['access-control-expose-headers'] = 'Server-Timing'
      const words = timedWords(output.segments ?? [])
      let result
      try { result = parseCloudSpeechResponse({ ok: true, id, provider: 'cloudflare', text: output.text,
        duration: seconds, locale: output.transcription_info?.language ?? 'und', words }) }
      catch { throw new SpeechError(502, 'invalid_result', 'Speech recognition returned incomplete timing. Your recording is saved; try again.') }
      return reply(result)
    } catch (error) {
      const failure = error instanceof SpeechError ? error : controller.signal.aborted
        ? new SpeechError(request.signal.aborted ? 499 : 504, 'timeout', 'Speech recognition timed out. Your recording is saved; try again.')
        : new SpeechError(503, 'unavailable', 'Cloudflare speech is unavailable or its free allowance is exhausted. Your recording is saved; try again later.')
      status = failure.status
      if (status === 429) headers['retry-after'] = '60'
      return reply({ ok: false, code: failure.code, error: failure.message }, status)
    } finally {
      clearTimeout(timer); request.signal.removeEventListener('abort', abort)
      // An early provider rejection may leave the upload unread.
      await upload?.cancel().catch(() => {})
      // No audio, transcript, IP, headers or upstream error bodies in logs.
      console.info(JSON.stringify({ event: 'speech', status, elapsedMs: Date.now() - started, seconds }))
    }
  }
} satisfies ExportedHandler<Env>
