import { CLOUD_SPEECH_URL, parseCloudSpeechResponse, originalSpeechSpans, validateRecordingWords, validateRecordingSpans,
  type PreparedSpeechAudio, type RecordingPacket } from '@galta/capture'
import { speechDigest, type SpeechGrantResponse } from '@galta/capture'
import { hostRuntime } from '../shared/hostRuntime'

export class SpeechSignInRequired extends Error {}

async function speechAuthorization(id: string, wav: Uint8Array, signal: AbortSignal): Promise<string> {
  const digest = await speechDigest(wav)
  signal.throwIfAborted()
  const runtime = hostRuntime()
  if (!runtime) throw new SpeechSignInRequired('Sign in with Aha Labs to transcribe this recording. Your recording is saved.')
  const result = await new Promise<SpeechGrantResponse>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void runtime.sendMessage({ type: 'speech-authorize', request: { id, digest } }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
  signal.throwIfAborted()
  if (!result?.ok) {
    if (result?.code === 'sign_in') throw new SpeechSignInRequired(result.error)
    throw new Error(result?.error ?? 'Could not authorize speech recognition. Your recording is saved.')
  }
  return result.token
}

async function speechResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  if (!response.body) throw new Error('Empty speech response.')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      const next = await reader.read(); signal.throwIfAborted(); if (next.done) break
      size += next.value.byteLength
      if (size > 524_288) { await reader.cancel(); throw new Error('Speech response is too large.') }
      chunks.push(next.value)
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** Decode off the UI thread, then transfer PCM to a short-lived preparation worker. */
async function recordingAudio(media: Blob, duration: number, signal: AbortSignal): Promise<PreparedSpeechAudio> {
  signal.throwIfAborted()
  const decoder = new OfflineAudioContext(1, 1, 16_000)
  const audio = await decoder.decodeAudioData(await media.arrayBuffer())
  signal.throwIfAborted()
  if (Math.abs(audio.duration - duration) > .5) throw new Error('Audio timing does not match this recording.')
  // MediaRecorder may append a partial codec frame after Stop. Clip that tail
  // to the session end; never stretch audio or shift the remaining timestamps.
  const frames = Math.min(960_000, Math.floor(Math.min(audio.duration, duration) * 16_000))
  if (!frames) throw new Error('The recording has no audio.')
  const context = new OfflineAudioContext(1, frames, 16_000), source = context.createBufferSource()
  source.buffer = audio; source.connect(context.destination); source.start()
  const mono = (await context.startRendering()).getChannelData(0).slice()
  source.disconnect(); signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./speech.worker.ts', import.meta.url), { type: 'module' })
    const finish = (error?: Error, value?: PreparedSpeechAudio) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate()
      if (error) reject(error); else resolve(value!)
    }
    const abort = () => finish(new DOMException('Transcription cancelled', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('Audio preparation timed out. Your recording is saved.')), 10_000)
    signal.addEventListener('abort', abort, { once: true })
    worker.onerror = () => finish(new Error('Audio preparation failed. Your recording is saved.'))
    worker.onmessage = (event: MessageEvent<{ audio?: PreparedSpeechAudio; error?: string }>) => {
      finish(event.data.error ? new Error(event.data.error) : undefined, event.data.audio)
    }
    worker.postMessage(mono, [mono.buffer])
  })
}

/** Only explicit Send calls this. Cloudflare receives audio, never the canvas. */
export async function transcribeRecording(packet: RecordingPacket, media: Blob, signal: AbortSignal): Promise<RecordingPacket['transcript']> {
  const audio = await recordingAudio(media, packet.duration, signal)
  if (Math.abs(audio.duration - packet.duration) > .5) throw new Error('Audio timing does not match this recording.')
  signal.throwIfAborted()
  const token = await speechAuthorization(packet.id, audio.wav, signal)
  const deadline = AbortSignal.timeout(55_000), requestSignal = AbortSignal.any([signal, deadline])
  let response: Response
  try {
    response = await fetch(CLOUD_SPEECH_URL, { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'audio/wav', 'X-Galta-Recording': packet.id, Authorization: `Bearer ${token}` }, body: audio.wav, signal: requestSignal })
  } catch (error) {
    signal.throwIfAborted()
    if (deadline.aborted) throw new Error('Speech recognition timed out. Your recording is saved; try again.')
    throw new Error('Could not reach Cloudflare speech. Your recording is saved; check your connection and try again.', { cause: error })
  }
  signal.throwIfAborted()
  // Responses are bounded by the service; do not expose HTML or provider diagnostics.
  let result
  try { result = parseCloudSpeechResponse(await speechResponse(response, requestSignal)); signal.throwIfAborted() }
  catch {
    signal.throwIfAborted()
    if (deadline.aborted) throw new Error('Speech recognition timed out. Your recording is saved; try again.')
    throw new Error('Speech recognition returned an invalid response. Your recording is saved.')
  }
  if (!result.ok) throw new Error(result.error)
  const compactDuration = (audio.wav.length - 44) / 32_000
  if (!response.ok || result.id !== packet.id || Math.abs(result.duration - compactDuration) > 1 / 16_000)
    throw new Error('Speech timing does not match this recording.')
  const words = validateRecordingWords(result.words, compactDuration).map(word => {
    const spans = originalSpeechSpans(audio.regions, word.start, word.end)
    if (!spans.length) throw new Error('Speech timing does not match this recording.')
    return { ...word, start: spans[0]!.start, end: spans.at(-1)!.end, ...(spans.length > 1 ? { spans } : {}) }
  })
  return { status: 'available', provider: 'cloudflare', locale: result.locale, text: result.text,
    words: validateRecordingWords(words, packet.duration), audio: {
      activity: validateRecordingSpans(audio.activity, packet.duration), removedSilence: audio.removedSilence } }
}
