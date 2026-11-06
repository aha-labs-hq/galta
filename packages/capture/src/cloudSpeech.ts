/** Small, shared wire contract. The edge Worker does not need the canvas or a
 * schema runtime to validate this bounded response. Historical Apple schemas
 * stay in speech.ts for native protocol compatibility. */
export const SPEECH_AUDIO_BYTES = 1_920_044
export const CLOUD_SPEECH_URL = 'https://speech.galta.art/v1/transcribe'
export type SpeechGrantRequest = { id: string; digest: string }
export type SpeechGrantResponse = { ok: true; token: string; expiresAt: number }
  | { ok: false; code: 'sign_in' | 'rate_limit' | 'unavailable' | 'invalid_request'; error: string }
export function isSpeechGrantRequest(value: unknown): value is SpeechGrantRequest {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.id)
    && typeof v.digest === 'string' && /^[0-9a-f]{64}$/.test(v.digest)
}
export async function speechDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
const errorCodes = ['invalid_request', 'rate_limit', 'unavailable', 'timeout', 'invalid_result'] as const
export type CloudSpeechResponse = {
  ok: true; id: string; provider: 'cloudflare'; text: string; duration: number
  locale: string; words: { text: string; start: number; end: number }[]
} | { ok: false; code: typeof errorCodes[number]; error: string }

export function parseCloudSpeechResponse(value: unknown): CloudSpeechResponse {
  const invalid = (): never => { throw new Error('Invalid speech response.') }
  if (!value || typeof value !== 'object') return invalid()
  const v = value as Record<string, unknown>
  if (v.ok === false) {
    if (typeof v.error !== 'string' || !v.error || v.error.length > 2000 || !errorCodes.some(code => code === v.code)) return invalid()
    return { ok: false, error: v.error, code: v.code as typeof errorCodes[number] }
  }
  if (v.ok !== true || v.provider !== 'cloudflare' || typeof v.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.id) ||
      typeof v.text !== 'string' || v.text.length > 20_000 || typeof v.locale !== 'string' || !v.locale || v.locale.length > 20 ||
      typeof v.duration !== 'number' || !Number.isFinite(v.duration) || v.duration <= 0 || v.duration > 60 ||
      !Array.isArray(v.words) || v.words.length > 2000 || (v.text.trim() && !v.words.length)) return invalid()
  const duration = v.duration
  let previous = 0, characters = 0
  const words = v.words.map((item: unknown) => {
    if (!item || typeof item !== 'object') return invalid()
    const w = item as Record<string, unknown>
    if (typeof w.text !== 'string' || !w.text || w.text.length > 1000 || typeof w.start !== 'number' ||
        typeof w.end !== 'number' || !Number.isFinite(w.start) || !Number.isFinite(w.end) ||
        w.start < previous || w.start >= duration || w.end <= w.start || w.end > duration + .1) return invalid()
    characters += w.text.length; previous = w.start
    if (characters > 20_000) return invalid()
    return { text: w.text, start: w.start, end: Math.min(w.end, duration) }
  })
  return { ok: true, id: v.id, provider: 'cloudflare', text: v.text, duration, locale: v.locale, words }
}
