import type { ToolDefinition } from '../execution'
import { z } from 'zod'

/**
 * Media generation: the first capability. The canvas is Galta's core; a
 * capability is a producer the agent calls on. It makes files and never
 * changes a canvas; canvas tools place what it makes.
 *
 * A capability costs context only while it can be used: its tools are listed
 * only for connected providers, each description is one line, and the craft
 * and model detail arrive on demand through generation_models.
 */

/** What a generation produces. Speech is spoken text, not music or sound. */
export const MEDIA_KINDS = ['image', 'video', 'speech'] as const
export type MediaKind = typeof MEDIA_KINDS[number]

/** Where the user connects a provider, as Galta's messages name it. */
export const GENERATION_SETTINGS = "Generation in Galta's Settings"

/** Providers the user connects with their own account under Generation in
 * Galta's Settings dialog. Each provider bills the user directly; Galta holds
 * no shared account and no key reaches a
 * canvas, conversation, export or tool result. A key is pasted as one line;
 * keyHint names its form when the provider shows it in parts. */
export const MEDIA_PROVIDERS = [
  { id: 'byteplus', name: 'BytePlus', kinds: ['image', 'video'], keyUrl: 'https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey' },
  { id: 'openrouter', name: 'OpenRouter', kinds: ['image', 'video', 'speech'], keyUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'fal', name: 'fal', kinds: ['image', 'video', 'speech'], keyUrl: 'https://fal.ai/dashboard/keys' },
  { id: 'higgsfield', name: 'Higgsfield', kinds: ['image', 'video'], keyUrl: 'https://open.higgsfield.ai/api-keys', keyHint: 'Paste key ID:secret' }
] as const satisfies readonly { id: string; name: string; kinds: readonly MediaKind[]; keyUrl: string; keyHint?: string }[]
export type MediaProviderId = typeof MEDIA_PROVIDERS[number]['id']
/** The providers that make a kind, or all of them. */
const providerIds = (kind?: MediaKind) => MEDIA_PROVIDERS.filter(provider => !kind || (provider.kinds as readonly MediaKind[]).includes(kind)).map(provider => provider.id) as [MediaProviderId, ...MediaProviderId[]]

/** Galta's pages and the native runtime speak only these messages. A key
 * travels inward once, to be checked and stored; nothing returns it. */
export type MediaProviderState = { id: MediaProviderId; connected: boolean }
export type MediaSettingsRequest =
  | { action: 'status' }
  | { action: 'connect'; provider: MediaProviderId; key: string }
  | { action: 'disconnect'; provider: MediaProviderId }
export type MediaSettingsResponse = { ok: true; providers: MediaProviderState[] } | { ok: false; error: string; providers?: MediaProviderState[] }

export const MEDIA_WAIT_SECONDS = 20
export const MEDIA_REFERENCE_BYTES = 10 * 1024 * 1024
export const MEDIA_EMBEDDED_BYTES = 32 * 1024 * 1024

const requestId = z.string().regex(/^[\w-]{8,128}$/)
  .describe('New unique id per generation; reuse only to retry the same request.')
const model = z.string().trim().min(1).max(200).regex(/^[\w./:-]+$/)
  .describe('Exact id from generation_models.')
const image = z.string().min(1).max(14_000_000)
  .describe('Absolute path, HTTPS URL or data URL of a PNG, JPEG or WebP.')
const remote = z.string().min(1).max(3000).describe('HTTPS URL or asset:// reference.')
const seed = z.number().int().min(0).max(2_147_483_647)

const inputs = {
  generation_models: z.strictObject({
    provider: z.enum(providerIds()).optional(),
    kind: z.enum(MEDIA_KINDS).optional(),
    query: z.string().max(100).optional().describe('Name or id contains.'),
    limit: z.number().int().min(1).max(100).default(25)
  }),
  generate_image: z.strictObject({
    provider: z.enum(providerIds('image')).optional(),
    model: model.optional(),
    prompt: z.string().trim().min(1).max(16_000),
    references: z.array(image).max(10).default([]).describe('Images to edit or follow, most important first.'),
    ratio: z.string().max(20).optional().describe('Such as 16:9.'),
    size: z.string().max(40).optional().describe('Tier such as 2K, or WIDTHxHEIGHT.'),
    quality: z.enum(['auto', 'low', 'medium', 'high']).optional(),
    format: z.enum(['png', 'jpeg', 'webp']).optional(),
    background: z.enum(['auto', 'transparent', 'opaque']).optional(),
    count: z.number().int().min(1).max(4).optional(),
    seed: seed.optional(),
    requestId
  }),
  generate_video: z.strictObject({
    provider: z.enum(providerIds('video')).optional(),
    model: model.optional(),
    prompt: z.string().trim().min(1).max(16_000),
    firstFrame: image.optional(),
    lastFrame: image.optional().describe('Needs firstFrame.'),
    references: z.array(image).max(10).default([]).describe('Not with frames.'),
    referenceAudio: z.array(remote).max(3).default([]),
    referenceVideo: z.array(remote).max(3).default([]),
    task: z.enum(['reference', 'edit', 'extend']).optional(),
    ratio: z.string().max(20).optional(),
    resolution: z.string().max(20).optional(),
    duration: z.number().int().min(-1).max(120).optional().describe('Seconds; -1 lets the model choose.'),
    audio: z.boolean().optional().describe('With sound.'),
    seed: seed.optional(),
    requestId
  }).refine(input => !input.lastFrame || input.firstFrame, { message: 'lastFrame requires firstFrame', path: ['lastFrame'] }),
  generate_speech: z.strictObject({
    provider: z.enum(providerIds('speech')).optional(),
    model,
    text: z.string().trim().min(1).max(16_000).describe('The exact words.'),
    voice: z.string().trim().min(1).max(200),
    requestId
  }),
  generation_get: z.strictObject({
    id: z.uuid(),
    waitSeconds: z.number().int().min(0).max(110).default(MEDIA_WAIT_SECONDS).describe('A video takes minutes: wait long rather than often.'),
    preview: z.boolean().optional().describe('Also return finished images as pictures; costs image tokens.')
  }),
  generation_list: z.strictObject({ limit: z.number().int().min(1).max(50).default(20) })
}
export type MediaToolName = keyof typeof inputs
export type MediaToolInput<Name extends MediaToolName> = z.output<typeof inputs[Name]>

export function parseMediaInput<Name extends MediaToolName>(name: Name, input: unknown): MediaToolInput<Name> {
  const result = inputs[name].safeParse(input)
  if (!result.success) throw new Error(result.error.issues.map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '))
  return result.data as MediaToolInput<Name>
}

function inputSchema(schema: z.ZodType): ToolDefinition['inputSchema'] {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' })
  return { type: 'object', ...json }
}

const media = { resource: 'media', exclusive: false } as const
const paid = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const
const saved = 'Files go to the workspace outputs; place them with canvas_place or canvas_edit. A stopped call still finishes: check generation_list before generating again.'

/** Generation runs in the native runtime with the user's own provider
 * account. It creates files and never changes a canvas by itself. */
export const MEDIA_TOOLS = [
  { name: 'generation_models', annotations: { readOnlyHint: true, openWorldHint: true }, execution: media, inputSchema: inputSchema(inputs.generation_models),
    description: 'Models of the providers the user connected: what each is best at and its controls. Pass the kind you are about to make; the answer also says how to prompt for it. Read-only and free.' },
  { name: 'generate_image', annotations: paid, execution: media, inputSchema: inputSchema(inputs.generate_image),
    description: `Generate or edit an image with the user's connected provider, which bills the user. Read generation_models for images first. Waits up to ${MEDIA_WAIT_SECONDS} s, then returns the saved files or a running job for generation_get. ${saved}` },
  { name: 'generate_video', annotations: paid, execution: media, inputSchema: inputSchema(inputs.generate_video),
    description: `Start a video with the user's connected provider, which bills the user. Read generation_models for video first. Returns once the provider has the task; wait with generation_get. ${saved}` },
  { name: 'generate_speech', annotations: paid, execution: media, inputSchema: inputSchema(inputs.generate_speech),
    description: `Speak the exact text with a speech model and voice from generation_models. ${saved}` },
  { name: 'generation_get', annotations: { readOnlyHint: true, openWorldHint: true }, execution: media, inputSchema: inputSchema(inputs.generation_get),
    description: 'Wait for a generation and return its saved files. Resumes tasks and downloads without paying again. running is not finished; interrupted means it may have been accepted and was not resent.' },
  { name: 'generation_list', annotations: { readOnlyHint: true, openWorldHint: false }, execution: media, inputSchema: inputSchema(inputs.generation_list),
    description: 'Recent generations, newest first, with status and saved files.' }
] as const satisfies readonly (ToolDefinition & { name: MediaToolName })[]
export const MEDIA_TOOL_NAMES: readonly string[] = MEDIA_TOOLS.map(tool => tool.name)
export const isMediaTool = (name: string): name is MediaToolName => MEDIA_TOOL_NAMES.includes(name)
