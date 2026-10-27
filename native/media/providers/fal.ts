import type { MediaKind } from '../../../packages/canvas/src/capabilities/media'
import { Endpoint, kindOf, resultFiles, type JsonSchema } from './endpoint'
import { ProviderError, ProviderHttp, type KeyVerdict, type MediaProvider, type MediaRequest, type ModelInfo, type Prepared, type ProviderUpdate } from './provider'

const QUEUE = 'https://queue.fal.run'
const PLATFORM = 'https://api.fal.ai/v1'
const CATALOG_TTL = 5 * 60_000
/** fal's categories for the endpoints that make each kind. */
const CATEGORIES: Record<MediaKind, readonly string[]> = {
  image: ['text-to-image', 'image-to-image'],
  video: ['text-to-video', 'image-to-video', 'video-to-video'],
  speech: ['text-to-speech']
}
const MODEL = /^[\w-]+(\/[\w.-]+)+$/
/** A queued request's address: owner/alias, or a namespace before them, then the request id. */
const TASK = /^([\w-]+\/){2,3}requests\/[\w-]+$/
const noun: Record<MediaKind, string> = { image: 'images', video: 'video', speech: 'speech' }

type Listed = { endpoint_id?: string; metadata?: { display_name?: string; status?: string } }
type Operation = { requestBody?: { content?: Record<string, { schema?: JsonSchema }> }; responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }> }
type OpenApi = { paths?: Record<string, Record<string, Operation>>; components?: { schemas?: Record<string, JsonSchema> } }
type Cached<T> = { until: number; value: Promise<T> }

/**
 * fal: hundreds of models behind one queue. The catalogue lists each kind's
 * most used endpoints; any endpoint can be named, and its published OpenAPI
 * input decides which controls it takes before anything is paid for. Every
 * request waits in fal's queue, so even an image has a task to resume from.
 */
export class Fal implements MediaProvider {
  readonly id = 'fal'
  readonly name = 'fal'
  private readonly http: ProviderHttp
  private readonly catalogs = new Map<MediaKind, Cached<ModelInfo[]>>()
  private readonly endpoints = new Map<string, Cached<Endpoint>>()
  constructor(private readonly fetcher: typeof fetch = fetch) { this.http = new ProviderHttp(this.name, fetcher, key => ({ Authorization: `Key ${key}` })) }

  /** Prices need a key and cost nothing to read. */
  check(key: string): Promise<KeyVerdict> { return this.http.check(`${PLATFORM}/models/pricing?endpoint_id=fal-ai/flux/dev`, key) }

  private cached<K, T>(cache: Map<K, Cached<T>>, key: K, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key)
    if (hit && hit.until > Date.now()) return hit.value
    const value = load()
    cache.set(key, { until: Date.now() + CATALOG_TTL, value })
    value.catch(() => cache.delete(key))
    return value
  }

  models(kind: MediaKind, key: string | undefined): Promise<ModelInfo[]> {
    return this.cached(this.catalogs, kind, async () => {
      const seen = new Set<string>()
      const pages = await Promise.all(CATEGORIES[kind].map(async category => {
        const { models } = await this.http.json<{ models?: Listed[] }>(`${PLATFORM}/models?category=${category}&limit=100`, key)
        if (!Array.isArray(models)) throw new ProviderError('fal returned an unreadable model list', 502)
        return models.flatMap(({ endpoint_id: id, metadata }): ModelInfo[] => {
          if (!id || !MODEL.test(id) || !metadata?.display_name || metadata.status === 'deprecated' || seen.has(id)) return []
          seen.add(id)
          return [{ provider: this.id, id, name: metadata.display_name, kind, controls: { input: category.split('-to-')[0] } }]
        })
      }))
      return pages.flat()
    })
  }

  /** An endpoint as fal publishes it: its input, and what its result carries. */
  private endpoint(id: string, key: string): Promise<Endpoint> {
    return this.cached(this.endpoints, id, async () => {
      let described: { endpoint_id?: string; openapi?: OpenApi } | undefined
      try {
        const { models } = await this.http.json<{ models?: { endpoint_id?: string; openapi?: OpenApi }[] }>(`${PLATFORM}/models?endpoint_id=${encodeURIComponent(id)}&expand=openapi-3.0`, key)
        described = models?.find(model => model.endpoint_id === id)
      } catch (error) {
        if (error instanceof ProviderError && error.status === 404) throw new Error(`Unknown fal model ${id}; call generation_models`)
        throw error
      }
      const operations = Object.entries(described?.openapi?.paths ?? {})
      const input = operations.map(([, path]) => path.post?.requestBody?.content?.['application/json']?.schema).find(Boolean)
      const output = operations.filter(([path]) => /\/requests\/\{request_id\}$/.test(path)).map(([, path]) => path.get?.responses?.['200']?.content?.['application/json']?.schema).find(Boolean)
      const definitions = described?.openapi?.components?.schemas ?? {}
      const result = output?.$ref ? definitions[output.$ref.split('/').pop()!] : output
      const makes = kindOf(Object.keys(result?.properties ?? {}))
      if (!input || !makes) throw new Error(`fal does not describe ${id}'s input and result; choose another model`)
      return new Endpoint(id, makes, input, definitions)
    })
  }

  async prepare(request: MediaRequest, key: string): Promise<Prepared> {
    const id = request.input.model
    if (!id) throw new Error('fal needs an exact model id; call generation_models')
    if (!MODEL.test(id) || id.split('/').includes('..')) throw new Error(`Unknown fal model ${id}; call generation_models`)
    const endpoint = await this.endpoint(id, key)
    if (endpoint.makes !== request.kind) throw new Error(`${id} makes ${noun[endpoint.makes]}, not ${noun[request.kind]}; call generation_models`)
    return { model: id, body: endpoint.body(request) }
  }

  /** Queued with fal's fallback to "equivalent" models turned off: the model named is the one used. */
  async submit(_kind: MediaKind, prepared: Prepared, key: string): Promise<ProviderUpdate> {
    const { response_url } = await this.http.json<{ response_url?: string }>(`${QUEUE}/${prepared.model}`, key, prepared.body, { 'x-app-fal-disable-fallback': 'true' })
    return { status: 'running', taskId: this.task(response_url) }
  }

  /** The request's address in fal's queue. Only an address there may receive the key. */
  private task(address: string | undefined): string {
    const url = URL.canParse(address ?? '') ? new URL(address!) : undefined
    const path = url?.pathname.slice(1)
    if (!url || url.origin !== QUEUE || url.search || url.hash || url.username || !path || !TASK.test(path)) throw new ProviderError('fal accepted the request without a valid request address', 502)
    return path
  }

  async poll(taskId: string, key: string): Promise<ProviderUpdate> {
    if (!TASK.test(taskId)) throw new ProviderError('fal returned an unexpected request address', 502)
    const state = await this.http.json<{ status?: string; error?: string }>(`${QUEUE}/${taskId}/status`, key)
    if (state.status === 'IN_QUEUE' || state.status === 'IN_PROGRESS') return { status: 'running' }
    if (state.status !== 'COMPLETED') throw new ProviderError(`fal reported the request as ${state.status ?? 'unknown'}`, 502)
    if (state.error) return { status: 'failed', error: `fal: ${state.error}` }
    let result: Record<string, unknown>
    try { result = await this.http.json<Record<string, unknown>>(`${QUEUE}/${taskId}`, key) }
    catch (error) {
      // A refused result is the request's final answer; a refused key may be reconnected.
      if (error instanceof ProviderError && error.refused && error.status !== 401 && error.status !== 403) return { status: 'failed', error: error.message }
      throw error
    }
    const outputs = resultFiles(result)
    return outputs.length ? { status: 'succeeded', outputs } : { status: 'failed', error: 'fal finished the request without a file' }
  }

  /** Results are public files on fal's CDN; they carry no key. */
  open(url: string): Promise<Response> {
    return this.fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
  }
}
