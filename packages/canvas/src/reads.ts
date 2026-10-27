/** Shared read limits and descriptions: constraints must survive hosts that
 * render numeric schemas as TypeScript `number`. */
export const CANVAS_PAGE_DEFAULT = 32
export const CANVAS_PAGE_MAX = 64
export const CANVAS_PAGE_CHARACTERS = 12_000
export const CANVAS_KINDS = ['text', 'image', 'video', 'html', 'geo', 'arrow', 'line', 'draw', 'frame', 'unknown'] as const
export type CreativeShapeKind = typeof CANVAS_KINDS[number]

export const CANVAS_IDS_SCHEMA = { type: 'array', minItems: 1, maxItems: CANVAS_PAGE_MAX, uniqueItems: true, items: { type: 'string', minLength: 1 }, description: `Between 1 and ${CANVAS_PAGE_MAX} unique element IDs from a read or successful write, in requested order. Missing IDs fail.` } as const
export const CANVAS_PAGE_SCHEMA = {
  offset: { type: 'integer', minimum: 0, description: 'Non-negative page offset; omit for the first page. Prefer passing the returned next arguments for continuation.' },
  limit: { type: 'integer', minimum: 1, maximum: CANVAS_PAGE_MAX, description: `Integer from 1 to ${CANVAS_PAGE_MAX}; omit for the default ${CANVAS_PAGE_DEFAULT}. This is a page size, not a total-result limit. Text budgets can shorten pages; follow next until null.` },
  revision: { type: 'string', description: 'Revision from the first page, required for continuation. A changed document fails; start a fresh query.' }
} as const
export const CANVAS_QUERY_SCHEMA = {
  query: { type: 'string', minLength: 1, maxLength: 4000, description: 'Find a case-insensitive literal substring in full authored text (originalText), a name, or the title or caption of a page, image or video, unaffected by automatic wrapping. Explicit line breaks are preserved; not a regex. Canvas scope only; combines with kind and groupId. Empty matches return an empty page.' },
  kind: { type: 'string', enum: CANVAS_KINDS, description: 'Filter by the kind returned in element records: geo includes rectangle/ellipse/diamond, draw means native brush work. Canvas scope only.' },
  groupId: { type: 'string', minLength: 1, maxLength: 200, description: 'List all members of this native group, including nested members. Copy a groupIds entry from a read. Canvas scope only.' }
} as const

/** A continuation is a complete next request, not a second cursor store. The
 * caller keeps its executionId; the bridge owns that binding independently. */
export function canvasReadContinuation(input: Record<string, unknown>, nextOffset: number | null, revision: string): Record<string, unknown> | null {
  return nextOffset === null ? null : { ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), offset: nextOffset, revision }
}

export function validateCanvasReadPage(input: Record<string, unknown>): void {
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > CANVAS_PAGE_MAX)) {
    throw new Error(`limit must be an integer from 1 to ${CANVAS_PAGE_MAX}. Omit limit for ${CANVAS_PAGE_DEFAULT} records per page; pass the returned next arguments to continue. A larger canvas does not require a larger limit.`)
  }
  if (input.offset !== undefined && (!Number.isInteger(input.offset) || Number(input.offset) < 0)) throw new Error('offset must be a non-negative integer. Start with no offset, then pass the returned next arguments.')
}

export function validateCanvasQuery(input: Record<string, unknown>): void {
  const filters = Object.keys(CANVAS_QUERY_SCHEMA).filter(key => input[key] !== undefined)
  if (!filters.length) return
  if (input.ids !== undefined || input.scope !== undefined && input.scope !== 'canvas') throw new Error('query, kind and groupId search the canvas only. Omit scope/ids or use scope canvas; other scopes preserve their complete observed sets.')
  if (input.query !== undefined && (typeof input.query !== 'string' || !input.query.length || input.query.length > 4000)) throw new Error('query must contain 1 to 4000 characters. Omit query to list all matching elements.')
  if (input.kind !== undefined && !CANVAS_KINDS.includes(input.kind as CreativeShapeKind)) throw new Error(`kind must be one of: ${CANVAS_KINDS.join(', ')}.`)
  if (input.groupId !== undefined && (typeof input.groupId !== 'string' || !input.groupId.trim() || input.groupId.length > 200)) throw new Error('groupId must be a nonblank native group id of at most 200 characters, copied from groupIds.')
}
