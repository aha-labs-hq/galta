import type { MediaKind } from '../../../packages/canvas/src/capabilities/media'
import type { MediaRequest, ProviderOutput } from './provider'

/** JSON Schema as model inputs and results are written in it; only these keywords are read. */
export type JsonSchema = {
  type?: string | string[]; enum?: unknown[]; const?: unknown; $ref?: string
  anyOf?: JsonSchema[]; oneOf?: JsonSchema[]; allOf?: JsonSchema[]
  minimum?: number; maximum?: number; minItems?: number; maxItems?: number
  items?: JsonSchema; properties?: Record<string, JsonSchema>; required?: string[]
  [keyword: string]: unknown
}

type Encode = (value: any, field: string) => unknown[]
type Control = { fields: readonly string[]; encode?: Encode }

/** fal's named sizes, by the ratio each one is. */
const SIZES: Record<string, string> = { '1:1': 'square_hd', '4:3': 'landscape_4_3', '3:4': 'portrait_4_3', '16:9': 'landscape_16_9', '9:16': 'portrait_16_9' }
const TASKS: Record<string, string[]> = { reference: ['reference'], edit: ['edit', 'editing'], extend: ['extend', 'extension'] }
/** One item can go where a model takes a single file. */
const list: Encode = (values: string[]) => values.length === 1 ? [values, values[0]] : [values]

/**
 * Where each of Galta's controls goes. Models name the same control
 * differently (image_url, start_image_url, first_frame_url), so each lists the
 * names in use; the endpoint's schema says which one it has, and an encoding
 * says how a value is written there (5, "5" or "5s").
 */
const CONTROLS: { [Kind in MediaKind]: Record<string, Control> } = {
  image: {
    references: { fields: ['image_urls', 'reference_image_urls', 'image_url', 'image_reference_url'], encode: list },
    ratio: { fields: ['aspect_ratio', 'image_size'], encode: (ratio: string, field) => field !== 'image_size' ? [ratio] : SIZES[ratio] ? [SIZES[ratio]] : [] },
    size: { fields: ['resolution', 'image_size'], encode: (size: string, field) => {
      const pixels = /^(\d+)x(\d+)$/.exec(size)
      return field !== 'image_size' ? [size] : pixels ? [{ width: Number(pixels[1]), height: Number(pixels[2]) }] : []
    } },
    quality: { fields: ['quality'] },
    format: { fields: ['output_format'], encode: (format: string) => format === 'jpeg' ? ['jpeg', 'jpg'] : [format] },
    background: { fields: ['background'] },
    count: { fields: ['num_images', 'batch_size'] },
    seed: { fields: ['seed'] }
  },
  video: {
    firstFrame: { fields: ['image_url', 'start_image_url', 'first_frame_url'] },
    lastFrame: { fields: ['end_image_url', 'last_image_url', 'tail_image_url', 'last_frame_url'] },
    references: { fields: ['image_urls', 'reference_image_urls'] },
    referenceVideo: { fields: ['video_url', 'video_urls', 'reference_video_urls'], encode: list },
    referenceAudio: { fields: ['audio_url', 'audio_urls', 'reference_audio_urls'], encode: list },
    task: { fields: ['task'], encode: (task: string) => TASKS[task] ?? [] },
    ratio: { fields: ['aspect_ratio'] },
    resolution: { fields: ['resolution'] },
    duration: { fields: ['duration'], encode: (seconds: number) => seconds === -1 ? ['auto'] : [seconds, String(seconds), `${seconds}s`] },
    audio: { fields: ['generate_audio', 'audio', 'sound'], encode: (on: boolean) => [on, on ? 'on' : 'off'] },
    seed: { fields: ['seed'] }
  },
  speech: {
    text: { fields: ['text', 'prompt', 'gen_text'] },
    voice: { fields: ['voice', 'voice_id', 'voice_setting.voice_id'] }
  }
}

/** Where results carry each kind's files, in the order they are looked for. */
const OUTPUTS: readonly (readonly [MediaKind, readonly string[]])[] = [
  ['video', ['video', 'videos']],
  ['image', ['images', 'image']],
  ['speech', ['audio', 'audio_url', 'audio_file']]
]

/** The kind of file a result with these fields carries. */
export function kindOf(fields: readonly string[]): MediaKind | undefined {
  return OUTPUTS.find(([, names]) => names.some(name => fields.includes(name)))?.[0]
}

/** The files in a finished result: a URL, a { url } or a list of either. */
export function resultFiles(result: Record<string, unknown>): ProviderOutput[] {
  const urls = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(urls)
    : typeof value === 'string' ? [value]
    : value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string' ? [(value as { url: string }).url] : []
  for (const [, names] of OUTPUTS) {
    const found = names.flatMap(name => urls(result[name]))
    if (found.length) return found.map(url => ({ url }))
  }
  return []
}

const types = (schema: JsonSchema) => schema.type !== undefined ? [schema.type].flat() : schema.properties ? ['object'] : schema.items ? ['array'] : []
const allowedValues = (schema: JsonSchema) => schema.enum ?? ('const' in schema ? [schema.const] : undefined)

/**
 * A model endpoint that publishes its input as JSON Schema (fal and
 * Higgsfield), and the one mapping from Galta's controls onto it. Every value
 * is checked against the schema before anything is paid for; a control the
 * model does not take is refused, never dropped.
 */
export class Endpoint {
  constructor(readonly id: string, readonly makes: MediaKind, private readonly input: JsonSchema, private readonly definitions: Record<string, JsonSchema> = {}) {}

  /** A schema's alternatives without null, through references and unions. */
  private alternatives(schema: JsonSchema | undefined, depth = 0): JsonSchema[] {
    if (!schema || depth > 10) return []
    if (schema.$ref) return this.alternatives(this.definitions[schema.$ref.split('/').pop()!], depth + 1)
    // allOf is followed only as a wrapper ({ allOf: [{ $ref }] }); beside a schema's own content it adds constraints this does not read.
    const wrapper = schema.allOf?.length === 1 && !schema.type && !schema.properties && !allowedValues(schema)
    const branches = schema.anyOf ?? schema.oneOf ?? (wrapper ? schema.allOf : undefined)
    if (branches) return branches.flatMap(branch => this.alternatives(branch, depth + 1))
    return types(schema).includes('null') && types(schema).length === 1 ? [] : [schema]
  }

  /** A field, dotted for one inside another (voice_setting.voice_id). */
  private field(path: string): JsonSchema[] | undefined {
    let schemas = this.alternatives(this.input)
    for (const name of path.split('.')) {
      schemas = schemas.flatMap(schema => this.alternatives(schema.properties?.[name]))
      if (!schemas.length) return undefined
    }
    return schemas
  }

  private get required(): string[] { return this.alternatives(this.input).flatMap(schema => schema.required ?? []) }

  /** The value as this field takes it (an enum's own spelling), or undefined if it does not fit. */
  private conform(schemas: JsonSchema[], value: unknown): { value: unknown } | undefined {
    for (const schema of schemas) {
      const values = allowedValues(schema)
      if (values) {
        const match = values.find(allowed => allowed === value || (typeof allowed === 'string' && typeof value === 'string' && allowed.toLowerCase() === value.toLowerCase()))
        if (match !== undefined) return { value: match }
        continue
      }
      const kinds = types(schema)
      const inRange = (number: number) => number >= (schema.minimum ?? -Infinity) && number <= (schema.maximum ?? Infinity)
      if (!kinds.length
        || (kinds.includes('string') && typeof value === 'string')
        || (kinds.includes('boolean') && typeof value === 'boolean')
        || (kinds.includes('integer') && Number.isInteger(value) && inRange(value as number))
        || (kinds.includes('number') && typeof value === 'number' && Number.isFinite(value) && inRange(value))
        || (kinds.includes('object') && typeof value === 'object' && value !== null && !Array.isArray(value))
        || (kinds.includes('array') && Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity)
          && value.every(item => !schema.items || this.conform(this.alternatives(schema.items), item)))) return { value }
    }
    return undefined
  }

  /** What a field allows, in words. */
  private expected(schemas: JsonSchema[], value: unknown): string {
    const values = schemas.flatMap(schema => allowedValues(schema) ?? [])
    if (values.length) return `must be one of ${values.join(', ')}`
    const array = schemas.find(schema => types(schema).includes('array'))
    if (Array.isArray(value)) return array ? `takes ${array.minItems ? `${array.minItems} to ` : 'at most '}${array.maxItems ?? 'any number'}` : 'takes only one'
    const range = schemas.find(schema => schema.minimum !== undefined || schema.maximum !== undefined)
    if (range) return `must be from ${range.minimum ?? 'any'} to ${range.maximum ?? 'any'}`
    return `must be ${schemas.flatMap(types).join(' or ')}`
  }

  /** What the endpoint allows for each of Galta's controls it takes, in Galta's terms; required ones say so. */
  controls(): Record<string, unknown> {
    const required = this.required, summary: Record<string, unknown> = {}
    for (const [control, { fields }] of Object.entries(CONTROLS[this.makes])) {
      const field = fields.find(name => this.field(name))
      if (field) summary[control] = required.includes(field) ? 'required' : this.allows(control, field)
    }
    return summary
  }

  private allows(control: string, field: string): unknown {
    const schemas = this.field(field)!
    const values = schemas.flatMap(schema => allowedValues(schema) ?? [])
    if (control === 'audio') return true
    if (control === 'task') return Object.keys(TASKS).filter(task => TASKS[task]!.some(value => this.conform(schemas, value)))
    if (field === 'image_size') return control === 'ratio' ? Object.keys(SIZES).filter(ratio => this.conform(schemas, SIZES[ratio])) : 'WIDTHxHEIGHT'
    if (control === 'duration' && values.length) return values.map(value => value === 'auto' ? -1 : Number.parseInt(String(value)))
    if (control === 'format') return values.map(value => value === 'jpg' ? 'jpeg' : value)
    if (values.length) return values
    const array = schemas.find(schema => types(schema).includes('array'))
    if (array) return array.maxItems ?? true
    const range = schemas.find(schema => schema.minimum !== undefined || schema.maximum !== undefined)
    return range ? [range.minimum, range.maximum] : true
  }

  /** The request body for this endpoint, every control checked against its schema. */
  body(request: MediaRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {}
    const write = (path: string, value: unknown) => {
      const names = path.split('.'), last = names.pop()!
      let target = body
      for (const name of names) target = (target[name] ??= {}) as Record<string, unknown>
      target[last] = value
    }
    const input = request.input as Record<string, unknown>
    const controls = CONTROLS[request.kind]
    const required = this.required
    for (const [control, { fields, encode = (value: unknown) => [value] }] of Object.entries(controls)) {
      const value = input[control]
      if (value === undefined || (Array.isArray(value) && !value.length)) continue
      if ([value].flat().some(item => typeof item === 'string' && item.startsWith('asset://'))) throw new Error(`${control}: asset:// references are BytePlus's; pass HTTPS URLs`)
      // A field the model requires is filled first.
      const present = fields.filter(name => this.field(name)).sort((a, b) => Number(required.includes(b)) - Number(required.includes(a)))
      if (!present.length) throw new Error(`${this.id} does not take ${control}; see generation_models`)
      const placed = present.some(field => {
        if (field.split('.')[0]! in body) return false
        const fitting = encode(value, field).map(encoded => this.conform(this.field(field)!, encoded)).find(Boolean)
        if (fitting) write(field, fitting.value)
        return Boolean(fitting)
      })
      if (placed) continue
      if (control === 'ratio' && present[0] === 'image_size') throw new Error(`ratio must be one of ${(this.allows('ratio', 'image_size') as string[]).join(', ')} for this model`)
      if (control === 'size' && present.includes('image_size') && body.image_size !== undefined) throw new Error('Give ratio or an exact size, not both, for this model')
      throw new Error(`${control} ${this.expected(this.field(present[0]!)!, value)} for this model`)
    }
    // Words go to a model that takes them; one that takes none (background removal, upscaling) is asked without.
    if (request.kind !== 'speech' && this.field('prompt')) body.prompt = request.input.prompt
    // Some speech models answer inline unless asked for a file.
    const format = request.kind === 'speech' && this.field('output_format')
    if (format && this.conform(format, 'url')) body.output_format = 'url'
    const missing = required.filter(name => body[name] === undefined)
    if (missing.length) {
      const named = missing.map(name => Object.entries(controls).find(([, { fields }]) => fields.includes(name))?.[0])
      throw new Error(named.every(Boolean)
        ? `${this.id} needs ${named.join(' and ')}`
        : `${this.id} needs ${missing.filter((_, index) => !named[index]).join(', ')}, which Galta cannot set; choose another model`)
    }
    return body
  }
}
