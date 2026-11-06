import { isSpeechGrantRequest, speechDigest } from '../../../packages/capture/src/cloudSpeech'

/** Account is the authority. The speech service sees the session only while
 * exchanging it; audio requests carry an opaque one-use capability instead. */
export async function authorize(request: Request, env: Env): Promise<Response> {
  const reply = (value: unknown, status: number) => Response.json(value, { status })
  const authorization = request.headers.get('authorization') ?? ''
  if (!/^Bearer [^\s]{1,4096}$/.test(authorization))
    return reply({ ok: false, code: 'sign_in', error: 'Sign in with Aha Labs to transcribe this recording. Your recording is saved.' }, 401)
  if (request.headers.get('content-type') !== 'application/json') return reply({ ok: false, code: 'invalid_request', error: 'Invalid speech authorization.' }, 400)
  // Bound before JSON parsing, including chunked bodies with no Content-Length.
  const reader = request.body?.getReader(); let bytes = 0, json = ''
  if (!reader) return reply({ ok: false, code: 'invalid_request', error: 'Missing speech authorization.' }, 400)
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
  const abort = () => { void reader.cancel().catch(() => {}) }
  let stage = 'request'
  signal.addEventListener('abort', abort, { once: true })
  try {
    const decoder = new TextDecoder()
    while (true) {
      signal.throwIfAborted()
      const item = await reader.read(); signal.throwIfAborted(); if (item.done) break
      bytes += item.value.byteLength
      if (bytes > 1024) { await reader.cancel(); return reply({ ok: false, code: 'invalid_request', error: 'Invalid speech authorization.' }, 413) }
      json += decoder.decode(item.value, { stream: true })
    }
    json += decoder.decode()
    let input: unknown
    try { input = JSON.parse(json) } catch { return reply({ ok: false, code: 'invalid_request', error: 'Invalid speech authorization.' }, 400) }
    if (!isSpeechGrantRequest(input)) return reply({ ok: false, code: 'invalid_request', error: 'Invalid speech authorization.' }, 400)
    stage = 'account'
    const response = await env.ACCOUNT.fetch('https://account.ahalabs.site/api/auth/get-session', {
      // Workerd supports manual/follow, not "error". Never forward a session
      // through a redirect; the status check below rejects every non-200.
      headers: { Authorization: authorization }, redirect: 'manual', signal,
    })
    if (response.status !== 200) {
      if (response.status !== 401) {
        console.info(JSON.stringify({ event: 'speech_authorization', stage, status: response.status }))
        throw new Error('Account service unavailable')
      }
      return reply({ ok: false, code: 'sign_in', error: 'Your session ended. Sign in again.' }, 401)
    }
    const session = await response.json<{ user?: { id?: unknown; emailVerified?: unknown }; session?: { userId?: unknown; expiresAt?: unknown } } | null>()
    const userId = session?.user?.id, expires = session?.session?.expiresAt
    if (typeof userId !== 'string' || !userId || userId.length > 200 || session?.user?.emailVerified !== true ||
        session?.session?.userId !== userId || typeof expires !== 'string' || !(Date.parse(expires) > Date.now()))
      return reply({ ok: false, code: 'sign_in', error: 'Sign in with a verified Aha Labs account. Your recording is saved.' }, 401)
    signal.throwIfAborted()
    const account = await speechDigest(new TextEncoder().encode(`galta-speech:${userId}`))
    stage = 'admission'
    const grant = await env.SPEECH_BUDGET.getByName('whisper-allowance').grant(account, input)
    return reply(grant, grant.ok ? 200 : 429)
  } catch (error) {
    console.info(JSON.stringify({ event: 'speech_authorization', stage, error: error instanceof Error ? error.name : 'unknown', cancelled: signal.aborted }))
    return reply({ ok: false, code: 'unavailable', error: 'Could not authorize speech recognition. Your recording is saved; try again.' }, signal.aborted ? 504 : 503)
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock() }
}
