import { isAbsoluteArtifactPath } from './artifactPaths'
import { z } from 'zod'

export const CREATIVE_TEXT_COLORS = ['black', 'grey', 'white', 'red', 'blue', 'green', 'yellow', 'orange', 'violet'] as const
const ARROWHEADS = [null, 'arrow', 'bar', 'dot', 'triangle', 'circle', 'circle_outline', 'triangle_outline', 'diamond', 'diamond_outline', 'crowfoot_one', 'crowfoot_many', 'crowfoot_one_or_many'] as const
const hexColor = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const colorSchema = z.union([z.string().regex(hexColor), z.enum(['transparent', ...CREATIVE_TEXT_COLORS])])
  .describe('CSS hex or a supported colour name.')
const identitySchema = z.string().min(1).max(200).regex(/\S/)
const creationIdSchema = identitySchema.describe('Optional new unique element id. Later operations in this batch can use it as elementId.')
const targetSchema = identitySchema.describe('Required target: copy an element id from a read or successful write, or use an earlier creation id in this batch. Do not use the creation-only id field here.')
const endpointSchema = z.union([identitySchema, z.null()]).describe('Target element id; null detaches; omitted leaves unchanged.')
const textSchema = z.string().max(4000)
const positiveSchema = z.number().gt(0)
/** Excalidraw draws a brush stroke with a pen 4.25 × strokeWidth wide
 * (`freeDrawPath.js`), while shapes and lines draw strokeWidth itself. An agent
 * that assumes pixels draws brush strokes four times too heavy. */
export const STROKE_WIDTH_DESCRIPTION = 'Line weight. Shapes, lines and arrows draw about strokeWidth px; a brush (freedraw) draws a pen about 4.25 × strokeWidth px wide (0.5 ≈ 2 px, 1 ≈ 4 px), so fine brush linework needs 0.3 to 1.'
export const POINTS_DESCRIPTION = 'Path coordinates relative to x/y, required for freedraw creation. The first point becomes the native origin without moving the drawing; width/height are derived. A brush curve needs a point every few px; a handful of points draws a coarse polyline. Read back geometry before subsequent edits.'
const nativePropsSchema = z.strictObject({
  width: z.number().min(0), height: z.number().min(0), strokeColor: colorSchema, backgroundColor: colorSchema,
  fillStyle: z.enum(['solid', 'hachure', 'cross-hatch', 'zigzag']), strokeWidth: positiveSchema.describe(STROKE_WIDTH_DESCRIPTION),
  strokeStyle: z.enum(['solid', 'dashed', 'dotted']), roughness: z.union([z.literal(0), z.literal(1), z.literal(2)]), opacity: z.number().min(0).max(100),
  points: z.array(z.tuple([z.number(), z.number()])).min(2).describe(POINTS_DESCRIPTION),
  pressures: z.array(z.number().min(0).max(1)).describe('With simulatePressure:false, provide one pressure for every point, including when replacing points.'),
  simulatePressure: z.boolean().describe('Defaults to true for new brush strokes. Set false to use explicit pressures.'),
  text: textSchema, originalText: textSchema, fontSize: positiveSchema, lineHeight: positiveSchema, autoResize: z.boolean(),
  fontFamily: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(6), z.literal(7), z.literal(8), z.literal(9)]),
  textAlign: z.enum(['left', 'center', 'right']), verticalAlign: z.enum(['top', 'middle', 'bottom']),
  roundness: z.union([z.null(), z.strictObject({ type: z.union([z.literal(1), z.literal(2), z.literal(3)]), value: z.number().optional() })]),
  startArrowhead: z.union([z.null(), z.enum(ARROWHEADS.filter((value): value is Exclude<typeof value, null> => value !== null))]), endArrowhead: z.union([z.null(), z.enum(ARROWHEADS.filter((value): value is Exclude<typeof value, null> => value !== null))]), locked: z.boolean(), name: textSchema,
  groupIds: z.array(identitySchema).describe('Native group IDs, innermost first. Share an ID to group elements; [] ungroups. Put the same ID directly on every member of one deliverable so it can be selected and moved as a unit; nesting is for genuine subunits, and a grouped move expands one level only. Grouping does not bind text or arrow endpoints.'),
  link: z.union([z.string().regex(/^https?:\/\/\S+$/), z.null()]).describe('HTTP(S) source or reference URL; null clears it.')
}).partial().describe('Native style and geometry. groupIds organize reusable units. Use bind_arrow/bind_text for relationships. Resize paths with points. An empty text update removes that text and cleans its bindings.')
/** A page's, image's or video's own words. Galta shows the title as a quiet
 * header above it (a titled page also sits in a browser bar) and the caption
 * below it, so a deliverable is named on the object instead of in loose text. */
export const OBJECT_TITLE_MAX = 120
export const OBJECT_CAPTION_MAX = 280
export const OBJECT_TITLE_DESCRIPTION = 'Pages, images and videos only: the name shown in a quiet header above it; a titled page is framed as a browser window. Name a deliverable here instead of drawing title text. An empty string clears it.'
export const OBJECT_CAPTION_DESCRIPTION = 'Pages, images and videos only: one short line shown below it. An empty string clears it.'
const artifactPropsSchema = nativePropsSchema.extend({
  htmlPath: z.string().describe('Absolute .html artifact path in the creative workspace.'),
  mediaPath: z.string().describe('Absolute image/video artifact path in the creative workspace. Replacing media preserves identity, geometry and grouping unless explicitly changed.'),
  title: z.string().max(OBJECT_TITLE_MAX).describe(OBJECT_TITLE_DESCRIPTION),
  caption: z.string().max(OBJECT_CAPTION_MAX).describe(OBJECT_CAPTION_DESCRIPTION)
}).partial()
const coordinates = { x: z.number(), y: z.number() }
const slotSchema = identitySchema.describe('A place held by canvas_reserve. A new element takes its box, media fitted in proportion, instead of x, y, width and height; an update keeps its geometry. The place ends when the edit commits.')
const slotted = { x: z.number().optional(), y: z.number().optional(), slot: slotSchema.optional() }
const creationFields = { id: creationIdSchema.optional(), rotation: z.number().describe('Rotation in radians.').optional() }
const createTextSchema = z.strictObject({ type: z.literal('create_text'), ...creationFields, ...coordinates, text: textSchema.min(1).regex(/\S/), color: colorSchema.optional(), size: z.enum(['s', 'm', 'l']).optional(), props: nativePropsSchema.optional() })
const nativeElementTypes = ['rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'frame'] as const
const nativeElementSchema = z.strictObject({ type: z.literal('create_element'), ...creationFields, elementType: z.enum(nativeElementTypes), ...slotted, props: nativePropsSchema.optional() })
const freeDrawSchema = z.strictObject({ type: z.literal('create_element'), ...creationFields, elementType: z.literal('freedraw'), ...coordinates, props: nativePropsSchema.extend({ points: z.array(z.tuple([z.number(), z.number()])).min(2) }) })
const htmlElementSchema = z.strictObject({ type: z.literal('create_element'), ...creationFields, elementType: z.literal('html'), ...slotted, props: artifactPropsSchema.required({ htmlPath: true }) })
const mediaBase = { type: z.literal('create_element'), ...creationFields, elementType: z.enum(['image', 'video'] as const), slot: slotSchema.optional(), props: artifactPropsSchema.required({ mediaPath: true }) }
const mediaWithCoordinatesSchema = z.strictObject({ ...mediaBase, ...coordinates })
const mediaCenteredSchema = z.strictObject(mediaBase)
const mediaElementSchema = z.union([
  mediaWithCoordinatesSchema,
  mediaCenteredSchema
])
const createElementSchema = z.union([nativeElementSchema, freeDrawSchema, htmlElementSchema, mediaElementSchema])
const updateElementSchema = z.strictObject({ type: z.literal('update_element'), elementId: targetSchema, x: z.number().optional(), y: z.number().optional(), slot: slotSchema.optional(), props: artifactPropsSchema.optional(), rotation: z.number().describe('Rotation in radians.').optional() })
const moveSchema = z.strictObject({ type: z.literal('move'), elementId: targetSchema, ...coordinates, scope: z.enum(['element', 'group']).describe('element (default) includes bound text/frame children; group also moves the native group. x/y set the target element position.').optional() })
const deleteSchema = z.strictObject({ type: z.literal('delete'), elementId: targetSchema })
const bindArrowStartSchema = z.strictObject({ type: z.literal('bind_arrow'), elementId: targetSchema, start: endpointSchema, end: endpointSchema.optional() })
const bindArrowEndSchema = z.strictObject({ type: z.literal('bind_arrow'), elementId: targetSchema, start: endpointSchema.optional(), end: endpointSchema })
const bindArrowSchema = z.union([bindArrowStartSchema, bindArrowEndSchema])
const bindTextSchema = z.strictObject({ type: z.literal('bind_text'), elementId: targetSchema, containerId: z.union([identitySchema, z.null()]).describe('Required rectangle, ellipse, diamond or arrow id; null detaches. One bound text per container; use groups for freely positioned text blocks.') })
// Keep the delivered operation union flat. The host's schema converter handles
// one union level reliably; the named per-verb schemas above remain the parser
// and discovery source for runtime error messages.
const canvasOperationSchema = z.union([createTextSchema, nativeElementSchema, freeDrawSchema, htmlElementSchema, mediaWithCoordinatesSchema, mediaCenteredSchema, updateElementSchema, moveSchema, deleteSchema, bindArrowStartSchema, bindArrowEndSchema, bindTextSchema])
function normalizeJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonSchema)
  if (!value || typeof value !== 'object') return value
  const normalized = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeJsonSchema(entry)])) as Record<string, any>
  // The Codex host accepts draft-07 enum literals consistently across nested
  // unions; use that representation for generated operation branches.
  if (Object.hasOwn(normalized, 'const') && !Object.hasOwn(normalized, 'enum')) {
    normalized.enum = [normalized.const]
    delete normalized.const
  }
  // Some host schema converters expect scalar property types to be expressed
  // directly. Zod emits a union of numeric literals for these fields; the
  // equivalent draft-07 enum is smaller and retains the same constraints.
  if (Array.isArray(normalized.anyOf) && normalized.anyOf.length > 0 && normalized.anyOf.every((branch: any) => branch && typeof branch === 'object' && typeof branch.type === 'string' && Array.isArray(branch.enum) && Object.keys(branch).every(key => key === 'type' || key === 'enum'))) {
    const types = new Set(normalized.anyOf.map((branch: any) => branch.type))
    if (types.size === 1) {
      normalized.type = [...types][0]
      normalized.enum = normalized.anyOf.flatMap((branch: any) => branch.enum)
      delete normalized.anyOf
    }
  }
  if (Array.isArray(normalized.anyOf) && normalized.anyOf.length === 2) {
    const nullable = normalized.anyOf.find((branch: any) => branch?.type === 'null')
    const value = normalized.anyOf.find((branch: any) => branch?.type && branch.type !== 'null')
    if (nullable && value && Object.keys(nullable).length === 1 && typeof value.type === 'string') {
      const { type, ...constraints } = value
      normalized.type = [type, 'null']
      Object.assign(normalized, constraints)
      if (Array.isArray(constraints.enum)) normalized.enum = [...constraints.enum, null]
      delete normalized.anyOf
    }
  }
  // Host probe marker.
  return normalized
}
const jsonSchema = (schema: z.ZodType) => { const { $schema: _, ...value } = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' }); return normalizeJsonSchema(value) as Record<string, any> }
const nativePropsJson = jsonSchema(nativePropsSchema)
export const CANVAS_PROP_SCHEMA = (nativePropsJson.properties ?? {}) as Record<string, Record<string, unknown>>
export const CANVAS_WRITABLE_PROPS = Object.keys(CANVAS_PROP_SCHEMA)
const PROPS = new Set<string>(CANVAS_WRITABLE_PROPS)
function color(value: unknown): boolean { return typeof value === 'string' && (hexColor.test(value) || ['transparent', ...CREATIVE_TEXT_COLORS].includes(value as typeof CREATIVE_TEXT_COLORS[number])) }
function id(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && value.length <= 200 }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }

const operationSchemas = { create_text: createTextSchema, create_element: createElementSchema, update_element: updateElementSchema, move: moveSchema, delete: deleteSchema, bind_arrow: bindArrowSchema, bind_text: bindTextSchema } as const
export const CANVAS_OPERATION_DEFINITIONS = Object.fromEntries(Object.entries(operationSchemas).map(([name, schema]) => [name, jsonSchema(schema)])) as Record<string, { properties: Record<string, unknown>; required?: string[] }>
// The MCP host accepts this deliberately shallow draft-07 projection. Zod is
// authoritative for parsing and the generated per-verb definitions above;
// this projection only avoids nested union shapes that the current Code Mode
// converter cannot expose as a useful operation union.
const hostProps = {
  width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 }, strokeColor: { type: 'string' }, backgroundColor: { type: 'string' },
  fillStyle: { enum: ['solid', 'hachure', 'cross-hatch', 'zigzag'] }, strokeWidth: { type: 'number', exclusiveMinimum: 0, description: STROKE_WIDTH_DESCRIPTION }, strokeStyle: { enum: ['solid', 'dashed', 'dotted'] },
  roughness: { enum: [0, 1, 2] }, opacity: { type: 'number', minimum: 0, maximum: 100 }, points: { type: 'array', minItems: 2, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } }, description: POINTS_DESCRIPTION },
  pressures: { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 } }, simulatePressure: { type: 'boolean' }, text: { type: 'string', maxLength: 4000 }, originalText: { type: 'string', maxLength: 4000 },
  fontSize: { type: 'number', exclusiveMinimum: 0 }, lineHeight: { type: 'number', exclusiveMinimum: 0 }, autoResize: { type: 'boolean' }, fontFamily: { enum: [1, 2, 3, 5, 6, 7, 8, 9] },
  textAlign: { enum: ['left', 'center', 'right'] }, verticalAlign: { enum: ['top', 'middle', 'bottom'] }, roundness: { anyOf: [{ type: 'null' }, { type: 'object', properties: { type: { enum: [1, 2, 3] }, value: { type: 'number' } }, required: ['type'], additionalProperties: false }] },
  startArrowhead: { enum: ARROWHEADS }, endArrowhead: { enum: ARROWHEADS }, locked: { type: 'boolean' }, name: { type: 'string', maxLength: 4000 }, groupIds: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 }, description: 'Native group IDs, innermost first. Share an ID to group elements; [] ungroups. Put the same ID directly on every member of one deliverable so it can be selected and moved as a unit; nesting is for genuine subunits, and a grouped move expands one level only.' }, link: { type: ['string', 'null'], pattern: '^https?://\\S+$' }
} as const
const hostIdentity = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } as const
const hostTarget = { ...hostIdentity, description: 'Required target: copy an element id from a read or successful write, or use an earlier creation id in this batch. Do not use the creation-only id field here.' } as const
const hostCreationId = { ...hostIdentity, description: 'Optional new unique element id. Later operations in this batch can use it as elementId.' } as const
const hostSlot = { ...hostIdentity, description: slotSchema.description } as const
const hostPropsSchema = { type: 'object', additionalProperties: false, properties: hostProps, description: 'Native style and geometry. groupIds organize reusable units. Use bind_arrow/bind_text for relationships. Resize paths with points. An empty text update removes that text and cleans its bindings.' } as const
const hostArtifactProps = { ...hostPropsSchema, properties: { ...hostProps, htmlPath: { type: 'string', description: 'Absolute .html artifact path in the creative workspace.' }, mediaPath: { type: 'string', description: 'Absolute image/video artifact path in the creative workspace.' },
  title: { type: 'string', maxLength: OBJECT_TITLE_MAX, description: OBJECT_TITLE_DESCRIPTION }, caption: { type: 'string', maxLength: OBJECT_CAPTION_MAX, description: OBJECT_CAPTION_DESCRIPTION } } } as const
const hostOperationDefinitions = {
  create_text: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: ['create_text'] }, id: hostCreationId, x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string', minLength: 1, maxLength: 4000, pattern: '\\S' }, color: { type: 'string' }, size: { type: 'string', enum: ['s', 'm', 'l'] }, props: hostPropsSchema, rotation: { type: 'number', description: 'Rotation in radians.' } }, required: ['type', 'text', 'x', 'y'] },
  create_element: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: ['create_element'] }, id: hostCreationId, elementType: { type: 'string', enum: ['rectangle', 'ellipse', 'diamond', 'freedraw', 'arrow', 'line', 'frame', 'html', 'image', 'video'] }, x: { type: 'number' }, y: { type: 'number' }, slot: hostSlot, props: hostArtifactProps, rotation: { type: 'number', description: 'Rotation in radians.' } }, required: ['type', 'elementType'] },
  update_element: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: ['update_element'] }, elementId: hostTarget, x: { type: 'number' }, y: { type: 'number' }, slot: hostSlot, props: hostArtifactProps, rotation: { type: 'number', description: 'Rotation in radians.' } }, required: ['type', 'elementId'] },
  move: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: ['move'] }, elementId: hostTarget, x: { type: 'number' }, y: { type: 'number' }, scope: { type: 'string', enum: ['element', 'group'] } }, required: ['type', 'elementId', 'x', 'y'] },
  delete: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: ['delete'] }, elementId: hostTarget }, required: ['type', 'elementId'] },
  bind_arrow: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: ['bind_arrow'] }, elementId: hostTarget, start: { ...hostIdentity, type: ['string', 'null'] }, end: { ...hostIdentity, type: ['string', 'null'] } }, required: ['type', 'elementId'], not: { properties: { start: false, end: false } } },
  bind_text: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: ['bind_text'] }, elementId: hostTarget, containerId: { ...hostIdentity, type: ['string', 'null'] } }, required: ['type', 'elementId', 'containerId'] }
} as const
const hostDefinitions = Object.entries(hostOperationDefinitions)
const hostPropBranches = hostDefinitions.filter(([, definition]) => Object.hasOwn(definition.properties, 'props')).map(([, definition]) => {
  const properties = definition.properties as Record<string, any>
  const propsDefinition = properties.props as Record<string, any>
  const extras = Object.fromEntries(Object.entries(propsDefinition.properties ?? {}).filter(([key]) => !Object.hasOwn(hostProps, key)))
  return { ...definition, properties: { ...definition.properties, props: { propertyNames: { enum: Object.keys(propsDefinition.properties ?? {}) }, ...(Object.keys(extras).length ? { type: 'object', properties: extras } : {}) } } }
})
const hostInvalidCreateCases = [
  { properties: { type: { enum: ['create_element'] }, elementType: { enum: ['rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'frame'] } }, required: ['type', 'elementType'], not: { anyOf: [{ required: ['x', 'y'] }, { required: ['slot'] }] } },
  { properties: { type: { enum: ['create_element'] }, elementType: { enum: ['freedraw', 'html'] } }, required: ['type', 'elementType'], not: { required: ['props'] } },
  { properties: { type: { enum: ['create_element'] }, elementType: { enum: ['image', 'video'] } }, required: ['type', 'elementType'], not: { required: ['props'] } },
  { properties: { type: { enum: ['create_element'] }, elementType: { enum: ['image', 'video'] } }, required: ['type', 'elementType', 'x', 'props'], not: { required: ['y'] } },
  { properties: { type: { enum: ['create_element'] }, elementType: { enum: ['image', 'video'] } }, required: ['type', 'elementType', 'y', 'props'], not: { required: ['x'] } }
] as const
export const CANVAS_OPERATION_SCHEMA = { anyOf: [
  { allOf: [{ type: 'object', properties: { props: { type: 'object', properties: hostProps, description: hostPropsSchema.description } } }, { anyOf: hostPropBranches }] },
  ...hostDefinitions.filter(([, definition]) => !Object.hasOwn(definition.properties, 'props')).map(([, definition]) => definition)
], not: { anyOf: hostInvalidCreateCases } } as const
// The public wire schema is the strict source of truth. Runtime adapters keep
// this structural type intentionally broad because planning adds fields while
// narrowing by the operation verb; the parser above is the boundary that
// guarantees the actual input.
type Creation = { id?: string; x?: number; y?: number; slot?: string; props?: Record<string, unknown>; rotation?: number }
export type CanvasOperation =
  | (Creation & { type: 'create_text'; x: number; y: number; text: string; color?: string; size?: 's' | 'm' | 'l' })
  | (Creation & { type: 'create_element'; elementType: string })
  | { type: 'move'; elementId: string; x: number; y: number; scope?: 'element' | 'group' }
  | { type: 'delete'; elementId: string }
  | { type: 'update_element'; elementId: string; x?: number; y?: number; slot?: string; props?: Record<string, unknown>; rotation?: number }
  | { type: 'bind_arrow'; elementId: string; start?: string | null; end?: string | null }
  | { type: 'bind_text'; elementId: string; containerId: string | null }

function validateProperties(props: Record<string, unknown>, artifactKey: string | undefined, zeroDimension: boolean) {
  for (const [key, value] of Object.entries(props)) {
    if (key === artifactKey) continue
    // Which objects carry words is decided against the target in the planner.
    if (key === 'title' || key === 'caption') {
      if (typeof value !== 'string' || value.length > (key === 'title' ? OBJECT_TITLE_MAX : OBJECT_CAPTION_MAX)) throw new Error(`Invalid ${key}`)
      continue
    }
    if (!PROPS.has(key)) throw new Error(`Unsupported Excalidraw property: ${key}`)
    const rule = CANVAS_PROP_SCHEMA[key as keyof typeof CANVAS_PROP_SCHEMA] as { enum?: readonly unknown[]; type?: string | readonly string[] }
    if (rule.enum && !rule.enum.includes(value)) throw new Error(`Invalid ${key}`)
    if (rule.type === 'number' && !finite(value)) throw new Error(`Invalid ${key}`)
    if (rule.type === 'boolean' && typeof value !== 'boolean') throw new Error(`Invalid ${key}`)
    if (rule.type === 'string' && typeof value !== 'string') throw new Error(`Invalid ${key}`)
    if (['width', 'height', 'strokeWidth', 'fontSize', 'lineHeight'].includes(key) && (!finite(value) || (zeroDimension && ['width', 'height'].includes(key) ? value < 0 : value <= 0))) throw new Error(`Invalid ${key}`)
    if (['strokeColor', 'backgroundColor'].includes(key) && !color(value)) throw new Error(`Invalid ${key}`)
    if (key === 'opacity' && (!finite(value) || value < 0 || value > 100)) throw new Error('Invalid opacity')
    if (key === 'points' && (!Array.isArray(value) || value.length < 2 || !value.every(p => Array.isArray(p) && p.length === 2 && p.every(finite)))) throw new Error('Invalid points')
    if (key === 'pressures' && (!Array.isArray(value) || !value.every(p => finite(p) && p >= 0 && p <= 1))) throw new Error('Invalid pressures')
    if (['text', 'originalText', 'name'].includes(key) && (typeof value !== 'string' || value.length > 4000)) throw new Error(`Invalid ${key}`)
    if (key === 'groupIds' && (!Array.isArray(value) || !value.every(id) || new Set(value).size !== value.length)) throw new Error('Invalid groupIds')
    if (key === 'link' && value !== null && (typeof value !== 'string' || !/^https?:\/\/\S+$/.test(value))) throw new Error('link must be an HTTP(S) URL or null')
    if (key === 'roundness' && value !== null) {
      const round = value as { type?: number; value?: number }
      if (!round || typeof round !== 'object' || Array.isArray(round) || ![1, 2, 3].includes(round.type!) || (round.value !== undefined && !finite(round.value)) || Object.keys(round).some(key => key !== 'type' && key !== 'value')) throw new Error('Invalid roundness')
    }
  }
}

function schemaFields(schema: Record<string, any>): string[] {
  const fields = new Set<string>()
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const object = value as Record<string, unknown>
    if (object.properties && typeof object.properties === 'object') Object.keys(object.properties as object).forEach(key => fields.add(key))
    for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(object[key])) (object[key] as unknown[]).forEach(visit)
  }
  visit(schema)
  return [...fields]
}

function operationSchemaError(candidate: unknown, issues: readonly z.core.$ZodIssue[]): Error {
  const type = candidate && typeof candidate === 'object' && !Array.isArray(candidate) && typeof (candidate as Record<string, unknown>).type === 'string' ? (candidate as Record<string, unknown>).type as string : undefined
  const first = issues[0]
  if (first?.code === 'unrecognized_keys') {
    const allowed = type && CANVAS_OPERATION_DEFINITIONS[type] ? schemaFields(CANVAS_OPERATION_DEFINITIONS[type]) : Object.keys(operationSchemas)
    return new Error(`Unexpected field ${first.keys[0]} for ${type ?? 'operation'}. Allowed fields: ${allowed.join(', ')}.`)
  }
  const path = first?.path?.map(String).join('.')
  if (first?.code === 'invalid_type' && first.message.endsWith('received undefined') && path) {
    return new Error(`Missing ${path}.${path === 'elementId' ? ' Copy the target element id into elementId; id is only for creating an element.' : ''}`)
  }
  return new Error(path ? `Invalid ${path}: ${first?.message ?? 'input'}` : first?.message ?? 'Invalid operation')
}

export function validateCanvasOperations(operations: ReadonlyArray<CanvasOperation>, startIndex = 0): void {
  if (operations.length < 1) throw new Error('An edit must contain at least one canvas operation.')
  for (const [index, operation] of operations.entries()) {
    try { validateOperation(operation) } catch (error) {
      const type = operation && typeof operation === 'object' && !Array.isArray(operation) && typeof (operation as Record<string, unknown>).type === 'string' ? ` (${(operation as Record<string, unknown>).type})` : ''
      throw new Error(`operations[${startIndex + index}]${type}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function validateOperation(input: unknown): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected an operation object.')
  const candidate = input as Record<string, unknown>
  const type = typeof candidate.type === 'string' ? candidate.type : undefined
  const definition = type && Object.hasOwn(CANVAS_OPERATION_DEFINITIONS, type) ? CANVAS_OPERATION_DEFINITIONS[type] : undefined
  if (!definition) throw new Error(`Unknown type. Use one of: ${Object.keys(CANVAS_OPERATION_DEFINITIONS).join(', ')}.`)
  if (type === 'bind_arrow' && candidate.start === undefined && candidate.end === undefined) throw new Error('bind_arrow requires start or end')
  if (candidate.slot !== undefined && (type === 'create_text' || (type === 'create_element' && ['arrow', 'line', 'freedraw'].includes(candidate.elementType as string)))) throw new Error('A slot holds a shape, frame, page, image or video; place text, lines and strokes by coordinates')
  const parsed = operationSchemas[type as keyof typeof operationSchemas].safeParse(input)
  if (!parsed.success) throw operationSchemaError(input, parsed.error.issues)
  const operation = parsed.data as Record<string, any>
  const required = definition.required ?? []
  for (const key of required) if ((operation as Record<string, unknown>)[key] === undefined) {
    throw new Error(`Missing ${key}.${key === 'elementId' ? ' Copy the target element id into elementId; id is only for creating an element.' : ''}`)
  }
  if ('elementId' in operation && !id(operation.elementId)) throw new Error('elementId must be a nonblank element id of at most 200 characters. Copy id from a read or successful creation.')
  switch (operation.type) {
    case 'bind_arrow':
      if (operation.start === undefined && operation.end === undefined) throw new Error('bind_arrow requires start or end')
      for (const endpoint of [operation.start, operation.end]) if (endpoint !== undefined && endpoint !== null && !id(endpoint)) throw new Error('Invalid arrow target')
      return
    case 'bind_text':
      if (operation.containerId !== null && !id(operation.containerId)) throw new Error('Invalid text container')
      return
    case 'move':
      if (!finite(operation.x) || !finite(operation.y)) throw new Error('Invalid move coordinates')
      if (operation.scope !== undefined && !['element', 'group'].includes(operation.scope)) throw new Error('Invalid move scope')
      return
    case 'delete': return
    case 'create_text': case 'create_element': case 'update_element': break
  }
  if (operation.slot !== undefined) {
    if (!id(operation.slot)) throw new Error('Invalid slot')
    if (operation.x !== undefined || operation.y !== undefined || operation.props?.width !== undefined || operation.props?.height !== undefined) throw new Error('A slot sets the geometry; omit x, y, width and height')
  }
  if (operation.type !== 'update_element') {
    if (operation.id !== undefined && !id(operation.id)) throw new Error('Invalid creation id')
    const media = operation.type === 'create_element' && ['image', 'video'].includes(operation.elementType)
    if (!media && operation.slot === undefined && (!finite(operation.x) || !finite(operation.y))) throw new Error('Invalid creation coordinates')
    if (media && (operation.x === undefined) !== (operation.y === undefined)) throw new Error('Media x and y must be supplied together')
  }
  for (const field of ['x', 'y', 'rotation'] as const) if (operation[field] !== undefined && !finite(operation[field])) throw new Error(`Invalid ${field}`)
  if (operation.type === 'create_text') {
    if (typeof operation.text !== 'string' || !operation.text.trim() || operation.text.length > 4000) throw new Error('Invalid text')
    if (operation.color !== undefined && !color(operation.color)) throw new Error('Unsupported text color')
    if (operation.size !== undefined && !['s', 'm', 'l'].includes(operation.size)) throw new Error('Unsupported text size')
  }
  if (operation.type === 'create_element' && !['rectangle', 'ellipse', 'diamond', 'freedraw', 'arrow', 'frame', 'line', 'html', 'image', 'video'].includes(operation.elementType)) throw new Error('Invalid Excalidraw shape creation')
  if (operation.props !== undefined && (!operation.props || typeof operation.props !== 'object' || Array.isArray(operation.props))) throw new Error('Invalid shape properties')
  const props = operation.props ?? {}
  if (operation.type === 'create_element' && operation.elementType === 'freedraw' && props.points === undefined) throw new Error('Freedraw creation requires points')
  if (props.text !== undefined && props.originalText !== undefined && props.text !== props.originalText) throw new Error('text and originalText must agree; use text to change the content')
  if (operation.type === 'create_text' && [props.text, props.originalText].some(value => value !== undefined && value !== operation.text)) throw new Error('Creation text properties must agree with text')
  const html = operation.type === 'create_element' ? operation.elementType === 'html' : operation.type === 'update_element' && Object.hasOwn(props, 'htmlPath')
  if (html && (typeof props.htmlPath !== 'string' || !isAbsoluteArtifactPath(props.htmlPath) || !/\.html?$/i.test(props.htmlPath))) throw new Error('An absolute .html artifact path is required')
  const media = operation.type === 'create_element' ? ['image', 'video'].includes(operation.elementType) : operation.type === 'update_element' && Object.hasOwn(props, 'mediaPath')
  if (media && (typeof props.mediaPath !== 'string' || !isAbsoluteArtifactPath(props.mediaPath))) throw new Error('An absolute media artifact path is required')
  if (media && html) throw new Error('Choose one artifact kind per operation')
  // Update dimensions need the target type, checked in the scene planner.
  validateProperties(props, html ? 'htmlPath' : media ? 'mediaPath' : undefined, operation.type === 'update_element' || (operation.type === 'create_element' && ['line', 'arrow', 'freedraw'].includes(operation.elementType)))
}
