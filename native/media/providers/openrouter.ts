import type { MediaKind } from '../../../packages/canvas/src/capabilities/media'
import { ProviderError, ProviderHttp, type KeyVerdict, type MediaProvider, type MediaRequest, type ModelInfo, type Prepared, type ProviderUpdate } from './provider'

const API = 'https://openrouter.ai/api/v1'
const CATALOG_TTL = 5 * 60_000

type Capability = { type: 'enum'; values: unknown[] } | { type: 'range'; min?: number; max?: number } | { type: 'boolean' }
type Model = {
  id: string; name: string
  architecture?: { output_modalities?: string[] }
  supported_parameters?: Record<string, Capability> | string[]
  supported_durations?: number[]; supported_resolutions?: string[]; supported_aspect_ratios?: string[]
  supported_voices?: string[]
  pricing?: unknown; pricing_skus?: unknown
}
const CATALOG: Record<MediaKind, string> = { image: '/images/models', video: '/videos/models', speech: '/models?output_modalities=speech' }
const reference = (url: string) => ({ type: 'image_url', image_url: { url } })

/** Check a control against what the catalog documents for the model. A
 * control the catalog does not describe is left to the provider, whose
 * refusal (4xx) charges nothing. */
function documented(name: string, value: unknown, allowed: readonly unknown[] | undefined) {
  if (allowed?.length && !allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(', ')} for this model`)
}

export class OpenRouter implements MediaProvider {
  readonly id = 'openrouter'
  readonly name = 'OpenRouter'
  private readonly http: ProviderHttp
  private readonly catalogs = new Map<MediaKind, { until: number; models: Promise<Model[]> }>()
  constructor(private readonly fetcher: typeof fetch = fetch) { this.http = new ProviderHttp(this.name, fetcher) }

  check(key: string): Promise<KeyVerdict> { return this.http.check(`${API}/key`, key) }

  private catalog(kind: MediaKind, key: string | undefined): Promise<Model[]> {
    const cached = this.catalogs.get(kind)
    if (cached && cached.until > Date.now()) return cached.models
    const models = this.http.json<{ data?: Model[] }>(`${API}${CATALOG[kind]}`, key).then(({ data }) => {
      if (!Array.isArray(data)) throw new ProviderError('OpenRouter returned an unreadable model list', 502)
      const output = kind === 'speech' ? 'speech' : kind
      return data.filter(model => typeof model.id === 'string' && typeof model.name === 'string'
        && (kind === 'video' || model.architecture?.output_modalities?.includes(output)))
    })
    this.catalogs.set(kind, { until: Date.now() + CATALOG_TTL, models })
    models.catch(() => this.catalogs.delete(kind))
    return models
  }

  async models(kind: MediaKind, key: string | undefined): Promise<ModelInfo[]> {
    return (await this.catalog(kind, key)).map(model => ({
      provider: this.id, id: model.id, name: model.name, kind,
      controls: kind === 'image' ? { parameters: model.supported_parameters ?? {} }
        : kind === 'video' ? { duration: model.supported_durations, resolution: model.supported_resolutions, ratio: model.supported_aspect_ratios }
        : { voices: model.supported_voices },
      ...(model.pricing ?? model.pricing_skus ? { pricing: model.pricing ?? model.pricing_skus } : {})
    }))
  }

  async prepare(request: MediaRequest, key: string): Promise<Prepared> {
    const id = request.input.model
    if (!id) throw new Error('OpenRouter needs an exact model id; call generation_models')
    const model = (await this.catalog(request.kind, key)).find(candidate => candidate.id === id)
    if (!model) throw new Error(`OpenRouter model ${id} cannot generate ${request.kind}; call generation_models`)
    if (request.kind === 'speech') {
      documented('voice', request.input.voice, model.supported_voices)
      return { model: id, body: { model: id, input: request.input.text, voice: request.input.voice, response_format: 'mp3' } }
    }
    if (request.kind === 'image') {
      const input = request.input
      const capabilities = Array.isArray(model.supported_parameters) ? {} : model.supported_parameters ?? {}
      // A tier such as 2K is the model's resolution; WIDTHxHEIGHT is an exact size.
      const size = input.size === undefined ? {} : /^\d+x\d+$/.test(input.size) ? { size: input.size } : { resolution: input.size }
      const fields: Record<string, unknown> = { aspect_ratio: input.ratio, ...size, quality: input.quality, output_format: input.format, background: input.background, n: input.count, seed: input.seed, input_references: input.references.length || undefined }
      const body: Record<string, unknown> = { model: id, prompt: input.prompt }
      for (const [name, value] of Object.entries(fields)) {
        if (value === undefined) continue
        const capability = capabilities[name]
        if (!capability) throw new Error(`${model.name} does not support ${name === 'input_references' ? 'reference images' : name}; see generation_models`)
        if (capability.type === 'enum') documented(name, value, capability.values)
        if (capability.type === 'range' && typeof value === 'number' && (value < (capability.min ?? -Infinity) || value > (capability.max ?? Infinity))) throw new Error(`${name === 'input_references' ? 'reference images' : name} must be between ${capability.min} and ${capability.max}`)
        if (name !== 'input_references') body[name] = value
      }
      if (input.references.length) body.input_references = input.references.map(reference)
      return { model: id, body }
    }
    const input = request.input
    if (input.referenceAudio.length || input.referenceVideo.length || input.task) throw new Error('OpenRouter video takes images and frames only; use BytePlus for audio, video references or tasks')
    if (input.firstFrame && input.references.length) throw new Error('Frames cannot be combined with references')
    const body: Record<string, unknown> = { model: id, prompt: input.prompt }
    if (input.duration !== undefined) { documented('duration', input.duration, model.supported_durations); body.duration = input.duration }
    if (input.resolution !== undefined) { documented('resolution', input.resolution, model.supported_resolutions); body.resolution = input.resolution }
    if (input.ratio !== undefined) { documented('ratio', input.ratio, model.supported_aspect_ratios); body.aspect_ratio = input.ratio }
    if (input.audio !== undefined) body.generate_audio = input.audio
    if (input.seed !== undefined) body.seed = input.seed
    const frames = [...input.firstFrame ? [{ ...reference(input.firstFrame), frame_type: 'first_frame' }] : [], ...input.lastFrame ? [{ ...reference(input.lastFrame), frame_type: 'last_frame' }] : []]
    if (frames.length) body.frame_images = frames
    if (input.references.length) body.input_references = input.references.map(reference)
    return { model: id, body }
  }

  async submit(kind: MediaKind, prepared: Prepared, key: string): Promise<ProviderUpdate> {
    if (kind === 'speech') {
      const response = await this.http.request(`${API}/audio/speech`, key, prepared.body)
      if (!response.ok) throw new ProviderError(`OpenRouter answered ${response.status} without audio`, 502)
      return { status: 'succeeded', outputs: [{ bytes: new Uint8Array(await response.arrayBuffer()) }] }
    }
    if (kind === 'video') {
      const result = await this.http.json<{ id?: string }>(`${API}/videos`, key, prepared.body)
      if (!result.id || !/^[\w-]+$/.test(result.id)) throw new ProviderError('OpenRouter accepted the video without a valid job id', 502)
      return { status: 'running', taskId: result.id }
    }
    const result = await this.http.json<{ data?: { b64_json?: string }[] }>(`${API}/images`, key, prepared.body)
    if (!result.data?.length) throw new ProviderError('OpenRouter returned no image', 422)
    return { status: 'succeeded', outputs: result.data.map(item => {
      if (!item.b64_json) throw new ProviderError('OpenRouter returned an image without content', 502)
      return { bytes: Buffer.from(item.b64_json, 'base64') }
    }) }
  }

  async poll(taskId: string, key: string): Promise<ProviderUpdate> {
    const result = await this.http.json<{ status?: string; error?: string; unsigned_urls?: string[] }>(`${API}/videos/${encodeURIComponent(taskId)}`, key)
    if (result.status === 'failed') return { status: 'failed', error: result.error ?? 'OpenRouter could not make the video' }
    if (result.status !== 'completed') return { status: 'running' }
    if (!result.unsigned_urls?.length) throw new ProviderError('OpenRouter finished the video without a file', 502)
    return { status: 'succeeded', outputs: result.unsigned_urls.map(url => ({ url: this.content(url, taskId).href })) }
  }

  /** Video content needs the key, so only OpenRouter's own content endpoint
   * for this job may receive it. A redirect to storage is followed without it. */
  private content(source: string, taskId?: string): URL {
    const url = new URL(source)
    const match = url.origin === new URL(API).origin && /^\/api\/v1\/videos\/([\w-]+)\/content$/.exec(url.pathname)
    if (!match || (taskId && match[1] !== taskId) || url.username || url.password || url.hash || [...url.searchParams.keys()].some(name => name !== 'index')) {
      throw new ProviderError('OpenRouter returned an unexpected content address', 502)
    }
    return url
  }

  async open(source: string, key: string): Promise<Response> {
    const url = this.content(source)
    const response = await this.http.request(url.href, key)
    const location = response.headers.get('location')
    if (response.ok || !location) return response
    await response.body?.cancel()
    return this.fetcher(new URL(location, url), { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
  }
}
