import type { MediaKind, MediaProviderId, MediaToolInput } from '../../../packages/canvas/src/capabilities/media'

export type MediaRequest =
  | { kind: 'image'; input: MediaToolInput<'generate_image'> }
  | { kind: 'video'; input: MediaToolInput<'generate_video'> }
  | { kind: 'speech'; input: MediaToolInput<'generate_speech'> }

export type ModelInfo = { provider: MediaProviderId; id: string; name: string; kind: MediaKind; bestFor?: string; controls: Record<string, unknown>; pricing?: unknown }

/** The exact body a provider will be paid for. The idempotency fingerprint
 * covers it, so a reused requestId cannot buy something different. */
export type Prepared = { model: string; body: Record<string, unknown> }

/** What a provider said of a key on a free, read-only request. */
export type KeyVerdict = 'accepted' | 'refused' | { unavailable: number }

export type ProviderOutput = { url: string } | { bytes: Uint8Array }
export type ProviderUpdate =
  | { status: 'running'; taskId?: string; progress?: number }
  | { status: 'succeeded'; outputs: ProviderOutput[] }
  | { status: 'failed'; error: string }

export interface MediaProvider {
  readonly id: MediaProviderId
  readonly name: string
  /** Ask the provider whether it accepts a key, without charge or side effect. */
  check(key: string): Promise<KeyVerdict>
  models(kind: MediaKind, key: string | undefined): Promise<ModelInfo[]>
  /** Validate every control against the model before anything is paid for. */
  prepare(request: MediaRequest, key: string): Promise<Prepared>
  submit(kind: MediaKind, prepared: Prepared, key: string): Promise<ProviderUpdate>
  poll(taskId: string, key: string): Promise<ProviderUpdate>
  /** Open a finished output for streaming into a file. */
  open(url: string, key: string): Promise<Response>
}

/** A definite answer from the provider. A 4xx means the request was refused,
 * so nothing was paid for; anything else leaves the outcome uncertain. */
export class ProviderError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
  get refused() { return this.status >= 400 && this.status < 500 }
}

/** Work a submission needs before the paid request failed, so nothing was sent or paid for. */
export class NotSent extends ProviderError {
  constructor(message: string) { super(message, 0) }
  override get refused() { return true }
}

/** How a provider's API takes a key. */
export const bearer = (key: string) => ({ Authorization: `Bearer ${key}` })

export class ProviderHttp {
  constructor(readonly name: string, private readonly fetcher: typeof fetch, private readonly authorize: (key: string) => Record<string, string> = bearer) {}

  /** A free, read-only request with the key: 401 and 403 refuse it. */
  async check(url: string, key: string): Promise<KeyVerdict> {
    const response = await this.fetcher(url, { headers: this.authorize(key), redirect: 'error', signal: AbortSignal.timeout(15_000) })
    await response.body?.cancel()
    if (response.status === 401 || response.status === 403) return 'refused'
    return response.ok ? 'accepted' : { unavailable: response.status }
  }

  async request(url: string, key: string | undefined, body?: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
    const response = await this.fetcher(url, {
      method: body ? 'POST' : 'GET',
      headers: { ...headers, ...(key ? this.authorize(key) : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      // A key is sent to the provider's API and never follows a redirect.
      redirect: 'manual',
      signal: AbortSignal.timeout(body ? 300_000 : 60_000)
    })
    if (response.ok || (response.status >= 300 && response.status < 400)) return response
    const data = await response.json().catch(() => ({})) as { error?: string | { message?: string }; message?: string; detail?: string | { msg?: string }[] }
    // FastAPI services answer validation errors as a list of { msg }.
    const detail = typeof data.error === 'string' ? data.error : data.error?.message ?? data.message
      ?? (Array.isArray(data.detail) ? data.detail.map(item => item?.msg).filter(Boolean).join('; ') : data.detail)
    throw new ProviderError(`${this.name} ${response.status}${detail ? `: ${redact(detail, key)}` : ''}`, response.status)
  }

  async json<T>(url: string, key: string | undefined, body?: Record<string, unknown>, headers?: Record<string, string>): Promise<T> {
    const response = await this.request(url, key, body, headers)
    if (!response.ok) throw new ProviderError(`${this.name} answered ${response.status} without a result`, 502)
    return await response.json().catch(() => { throw new ProviderError(`${this.name} returned an unreadable answer`, 502) }) as T
  }
}

export function redact(text: string, key: string | undefined) {
  return (key ? text.split(key).join('[key]') : text).replace(/Bearer\s+\S+/gi, 'Bearer [key]').slice(0, 600)
}
