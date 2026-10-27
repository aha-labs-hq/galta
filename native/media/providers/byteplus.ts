import type { MediaKind } from '../../../packages/canvas/src/capabilities/media'
import { ProviderError, ProviderHttp, type KeyVerdict, type MediaProvider, type MediaRequest, type ModelInfo, type Prepared, type ProviderUpdate } from './provider'

const API = 'https://ark.ap-southeast.bytepluses.com/api/v3'
const IMAGE_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'] as const
const VIDEO_RATIOS = [...IMAGE_RATIOS, 'adaptive'] as const

type ImageModel = { id: string; name: string; kind: 'image'; sizes: readonly string[]; defaultSize: string }
type VideoModel = { id: string; name: string; kind: 'video'; durations: readonly [number, number]; automatic: boolean; resolutions: readonly string[]; references: number; tasks: boolean }

/** The official ModelArk models this adapter has request shapes for. */
const MODELS: readonly (ImageModel | VideoModel)[] = [
  { id: 'dola-seedream-5-0-pro-260628', name: 'Seedream 5 Pro', kind: 'image', sizes: ['1K', '2K'], defaultSize: '2K' },
  { id: 'seedream-5-0-260128', name: 'Seedream 5', kind: 'image', sizes: ['2K', '3K'], defaultSize: '2K' },
  { id: 'dreamina-seedance-2-5-260628', name: 'Seedance 2.5', kind: 'video', durations: [4, 30], automatic: true, resolutions: ['480p', '720p', '1080p'], references: 10, tasks: true },
  { id: 'dreamina-seedance-2-0-260128', name: 'Seedance 2', kind: 'video', durations: [4, 15], automatic: false, resolutions: ['480p', '720p', '1080p', '4k'], references: 9, tasks: false },
  { id: 'dreamina-seedance-2-0-fast-260128', name: 'Seedance 2 Fast', kind: 'video', durations: [4, 15], automatic: false, resolutions: ['480p', '720p'], references: 9, tasks: false },
  { id: 'dreamina-seedance-2-0-mini-260615', name: 'Seedance 2 Mini', kind: 'video', durations: [4, 15], automatic: false, resolutions: ['480p', '720p'], references: 9, tasks: false }
]
const DEFAULTS = { image: MODELS[0]!.id, video: MODELS[2]!.id }

// Seedream 5 takes pixel sizes; these are its documented sizes per tier.
const PIXELS: Record<string, Record<string, string>> = {
  '2K': { '1:1': '2048x2048', '4:3': '2304x1728', '3:4': '1728x2304', '16:9': '2848x1600', '9:16': '1600x2848', '3:2': '2496x1664', '2:3': '1664x2496', '21:9': '3136x1344' },
  '3K': { '1:1': '3072x3072', '4:3': '3456x2592', '3:4': '2592x3456', '16:9': '4096x2304', '9:16': '2304x4096', '3:2': '3744x2496', '2:3': '2496x3744', '21:9': '4704x2016' }
}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback
  if (!allowed.includes(value as T)) throw new Error(`${name} must be one of ${allowed.join(', ')} for this model`)
  return value as T
}
function unsupported(input: Record<string, unknown>, names: string[]) {
  const used = names.filter(name => input[name] !== undefined)
  if (used.length) throw new Error(`BytePlus does not support ${used.join(', ')}; omit ${used.length === 1 ? 'it' : 'them'}`)
}

export class BytePlus implements MediaProvider {
  readonly id = 'byteplus'
  readonly name = 'BytePlus'
  private readonly http: ProviderHttp
  constructor(private readonly fetcher: typeof fetch = fetch) { this.http = new ProviderHttp(this.name, fetcher) }

  check(key: string): Promise<KeyVerdict> { return this.http.check(`${API}/models`, key) }

  async models(kind: MediaKind): Promise<ModelInfo[]> {
    return MODELS.filter(model => model.kind === kind).map(model => ({
      provider: this.id, id: model.id, name: model.name, kind: model.kind,
      controls: model.kind === 'image'
        ? { ratio: IMAGE_RATIOS, size: model.sizes, references: 10, default: model.id === DEFAULTS.image }
        : { ratio: VIDEO_RATIOS, resolution: model.resolutions, duration: model.automatic ? [...model.durations, 'or -1'] : model.durations, audio: true, firstFrame: true, lastFrame: true, references: model.references, referenceAudio: 3, referenceVideo: 3, task: model.tasks, default: model.id === DEFAULTS.video }
    }))
  }

  async prepare(request: MediaRequest): Promise<Prepared> {
    if (request.kind === 'speech') throw new Error('BytePlus has no speech models here; use OpenRouter')
    const id = request.input.model ?? DEFAULTS[request.kind]
    const model = MODELS.find(candidate => candidate.id === id && candidate.kind === request.kind)
    if (!model) throw new Error(`Unknown BytePlus ${request.kind} model ${id}; call generation_models`)
    return request.kind === 'image' ? this.image(model as ImageModel, request.input) : this.video(model as VideoModel, request.input)
  }

  private image(model: ImageModel, input: Extract<MediaRequest, { kind: 'image' }>['input']): Prepared {
    unsupported(input, ['quality', 'format', 'background', 'count', 'seed'])
    const size = oneOf('size', input.size, model.sizes, model.defaultSize)
    const ratio = input.ratio === undefined ? undefined : oneOf('ratio', input.ratio, IMAGE_RATIOS, '1:1')
    const body: Record<string, unknown> = { model: model.id, prompt: input.prompt, watermark: false, response_format: 'url' }
    if (model.id === DEFAULTS.image) {
      // Seedream 5 Pro takes a tier, not a ratio; the ratio travels in words.
      body.size = size
      if (ratio) body.prompt = `${input.prompt}\n\nUse a ${ratio} aspect ratio.`
      body.optimize_prompt_options = { thinking: 'disabled' }
    } else body.size = PIXELS[size]![ratio ?? '1:1']
    if (input.references.length) body.image = input.references.length === 1 ? input.references[0] : input.references
    return { model: model.id, body }
  }

  private video(model: VideoModel, input: Extract<MediaRequest, { kind: 'video' }>['input']): Prepared {
    const ratio = oneOf('ratio', input.ratio, VIDEO_RATIOS, '16:9')
    const resolution = oneOf('resolution', input.resolution, model.resolutions, '720p')
    const duration = input.duration ?? 5
    const [shortest, longest] = model.durations
    if (!(duration === -1 && model.automatic) && (duration < shortest || duration > longest)) throw new Error(`duration must be ${shortest}–${longest} seconds${model.automatic ? ' or -1' : ''} for ${model.name}`)
    const omni = input.references.length + input.referenceAudio.length + input.referenceVideo.length
    if (input.firstFrame && omni) throw new Error('Frames cannot be combined with references')
    if (input.references.length > model.references) throw new Error(`${model.name} accepts at most ${model.references} reference images`)
    if (!model.tasks && input.referenceAudio.length && !input.references.length && !input.referenceVideo.length) throw new Error(`${model.name} needs an image or video reference with referenceAudio`)
    if (input.task && !model.tasks) throw new Error('task requires Seedance 2.5')
    if ((input.task === 'edit' || input.task === 'extend') && (!input.referenceVideo.length || ratio !== 'adaptive')) throw new Error(`${input.task} needs referenceVideo and ratio adaptive`)
    if (input.task === 'edit' && duration !== -1) throw new Error('edit needs duration -1')
    for (const url of [...input.referenceAudio, ...input.referenceVideo]) {
      if (!/^asset:\/\/[\w./-]+$/.test(url) && !url.startsWith('https://')) throw new Error('referenceAudio and referenceVideo must be HTTPS URLs or asset:// references')
    }
    const content: Record<string, unknown>[] = [{ type: 'text', text: input.prompt }]
    if (input.firstFrame) content.push({ type: 'image_url', image_url: { url: input.firstFrame }, role: 'first_frame' })
    if (input.lastFrame) content.push({ type: 'image_url', image_url: { url: input.lastFrame }, role: 'last_frame' })
    for (const url of input.references) content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
    for (const url of input.referenceAudio) content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
    for (const url of input.referenceVideo) content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
    const body: Record<string, unknown> = { model: model.id, content, ratio, resolution, duration, generate_audio: input.audio ?? true, watermark: false }
    if (input.seed !== undefined) body.seed = input.seed
    if (model.tasks && (input.task || omni)) body.omni_reference_task_type = input.task ?? 'reference'
    return { model: model.id, body }
  }

  async submit(kind: MediaKind, prepared: Prepared, key: string): Promise<ProviderUpdate> {
    if (kind === 'image') {
      const result = await this.http.json<{ data?: { url?: string; b64_json?: string }[]; error?: { message?: string } }>(`${API}/images/generations`, key, prepared.body)
      if (result.error || !result.data?.length) throw new ProviderError(`BytePlus returned no image${result.error?.message ? `: ${result.error.message}` : ''}`, 422)
      return { status: 'succeeded', outputs: result.data.map(item => {
        if (item.url) return { url: item.url }
        if (item.b64_json) return { bytes: Buffer.from(item.b64_json, 'base64') }
        throw new ProviderError('BytePlus returned an image without content', 502)
      }) }
    }
    const result = await this.http.json<{ id?: string }>(`${API}/contents/generations/tasks`, key, prepared.body)
    if (!result.id) throw new ProviderError('BytePlus accepted the video without a task id', 502)
    return { status: 'running', taskId: result.id }
  }

  async poll(taskId: string, key: string): Promise<ProviderUpdate> {
    const result = await this.http.json<{ status?: string; progress?: number; content?: { video_url?: string }; error?: { message?: string }; message?: string }>(`${API}/contents/generations/tasks/${encodeURIComponent(taskId)}`, key)
    const status = result.status?.toLowerCase() ?? ''
    if (['succeeded', 'completed'].includes(status)) {
      if (!result.content?.video_url) throw new ProviderError('BytePlus finished the video without a file', 502)
      return { status: 'succeeded', outputs: [{ url: result.content.video_url }] }
    }
    if (['failed', 'error', 'expired', 'cancelled', 'canceled'].includes(status)) return { status: 'failed', error: result.error?.message ?? result.message ?? `BytePlus video ${status}` }
    return { status: 'running', ...(typeof result.progress === 'number' ? { progress: result.progress } : {}) }
  }

  /** Output URLs are presigned storage links; they carry no key. */
  open(url: string): Promise<Response> {
    return this.fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
  }
}
