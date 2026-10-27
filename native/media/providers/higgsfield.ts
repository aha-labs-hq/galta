import type { MediaKind } from '../../../packages/canvas/src/capabilities/media'
import { Endpoint, resultFiles } from './endpoint'
import { HIGGSFIELD_MODELS } from './higgsfield-models'
import { NotSent, ProviderError, ProviderHttp, type KeyVerdict, type MediaProvider, type MediaRequest, type ModelInfo, type Prepared, type ProviderUpdate } from './provider'

const API = 'https://api.higgsfield.ai'
const TASK = /^[\w-]{8,64}$/
/** A request no account has: Higgsfield tells a key it accepts that it does not exist. */
const NOBODY = '00000000-0000-4000-8000-000000000000'
const LOCAL = /^data:(image\/(?:png|jpeg|webp));base64,/
const MODELS = HIGGSFIELD_MODELS.map(model => ({ ...model, endpoint: new Endpoint(model.id, model.kind, model.input) }))

/**
 * Higgsfield: the models its API docs describe, with their input schemas
 * copied into higgsfield-models.ts, since the API lists none. Higgsfield reads
 * inputs only from public HTTPS addresses, so local references are uploaded to
 * its file storage as the request is sent, never before: what was prepared,
 * and is paid for once per requestId, stays the same bytes.
 */
export class Higgsfield implements MediaProvider {
  readonly id = 'higgsfield'
  readonly name = 'Higgsfield'
  private readonly http: ProviderHttp
  constructor(private readonly fetcher: typeof fetch = fetch) { this.http = new ProviderHttp(this.name, fetcher, key => ({ Authorization: `Key ${key}` })) }

  async check(key: string): Promise<KeyVerdict> {
    const verdict = await this.http.check(`${API}/requests/${NOBODY}/status`, key)
    return typeof verdict === 'object' && verdict.unavailable === 404 ? 'accepted' : verdict
  }

  async models(kind: MediaKind): Promise<ModelInfo[]> {
    return MODELS.filter(model => model.kind === kind).map(({ id, name, endpoint }) => ({ provider: this.id, id, name, kind, controls: endpoint.controls() }))
  }

  async prepare(request: MediaRequest): Promise<Prepared> {
    const id = request.input.model
    if (!id) throw new Error('Higgsfield needs an exact model id; call generation_models')
    const model = MODELS.find(candidate => candidate.id === id && candidate.kind === request.kind)
    if (!model) throw new Error(`Unknown Higgsfield ${request.kind === 'speech' ? 'speech' : request.kind} model ${id}; call generation_models`)
    return { model: id, body: model.endpoint.body(request) }
  }

  async submit(_kind: MediaKind, prepared: Prepared, key: string): Promise<ProviderUpdate> {
    const body = await this.upload(prepared.body, key)
    const { request_id } = await this.http.json<{ request_id?: string }>(`${API}/${prepared.model}`, key, body)
    if (!request_id || !TASK.test(request_id)) throw new ProviderError('Higgsfield accepted the request without a valid request id', 502)
    return { status: 'running', taskId: request_id }
  }

  /** The body with each local image replaced by its address in Higgsfield's storage. Nothing is paid for yet. */
  private async upload(body: Record<string, unknown>, key: string): Promise<Record<string, unknown>> {
    const local = new Set(Object.values(body).flat().filter((value): value is string => typeof value === 'string' && LOCAL.test(value)))
    if (!local.size) return body
    const addresses = new Map<string, string>()
    try { for (const image of local) addresses.set(image, await this.store(image, key)) }
    catch (error) { throw new NotSent(`Higgsfield could not take the reference images, so nothing was sent: ${error instanceof Error ? error.message : String(error)}`) }
    const swap = (value: unknown): unknown => Array.isArray(value) ? value.map(swap) : typeof value === 'string' ? addresses.get(value) ?? value : value
    return Object.fromEntries(Object.entries(body).map(([name, value]) => [name, swap(value)]))
  }

  private async store(image: string, key: string): Promise<string> {
    const type = LOCAL.exec(image)![1]!
    const slot = await this.http.json<{ public_url?: string; upload_url?: string; upload_headers?: Record<string, string> }>(`${API}/files/generate-upload-url`, key, { content_type: type })
    if (!slot.public_url?.startsWith('https://') || !slot.upload_url?.startsWith('https://')) throw new Error('Higgsfield gave no upload address')
    // A presigned address: it gets the bytes and the headers it asked for, never the key.
    const response = await this.fetcher(slot.upload_url, {
      method: 'PUT', headers: { 'Content-Type': type, ...slot.upload_headers }, body: Buffer.from(image.slice(image.indexOf(',') + 1), 'base64'),
      redirect: 'error', signal: AbortSignal.timeout(120_000)
    })
    await response.body?.cancel()
    if (!response.ok) throw new Error(`the upload answered ${response.status}`)
    return slot.public_url
  }

  async poll(taskId: string, key: string): Promise<ProviderUpdate> {
    if (!TASK.test(taskId)) throw new ProviderError('Higgsfield returned an unexpected request id', 502)
    const result = await this.http.json<Record<string, unknown> & { status?: string; error?: string }>(`${API}/requests/${taskId}/status`, key)
    switch (result.status) {
      case 'queued': case 'in_progress': return { status: 'running' }
      case 'completed': {
        const outputs = resultFiles(result)
        return outputs.length ? { status: 'succeeded', outputs } : { status: 'failed', error: 'Higgsfield finished the request without a file' }
      }
      // Higgsfield charges for none of these.
      case 'nsfw': return { status: 'failed', error: 'Higgsfield moderation refused the request or its result; it was not charged' }
      case 'failed': case 'canceled': return { status: 'failed', error: `Higgsfield: ${result.error ?? `the request was ${result.status}`}; it was not charged` }
      default: throw new ProviderError(`Higgsfield reported the request as ${result.status ?? 'unknown'}`, 502)
    }
  }

  /** Results are public files; they carry no key. */
  open(url: string): Promise<Response> {
    return this.fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
  }
}
