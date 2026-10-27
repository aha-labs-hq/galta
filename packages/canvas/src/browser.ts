import type { ToolDefinition } from './execution'
import { z } from 'zod'

const snapshotId = z.string().min(1).describe('Opaque snapshotId returned by browser_inspect. It expires after the page changes or another inspect.')
const ref = z.string().min(1).describe('Visible control ref returned by browser_inspect; it is scoped to that snapshot.')
const observation = { snapshotId }
const SCROLL_MAX = 4000
const FILL_MAX = 10000
const delta = z.number().min(-SCROLL_MAX).max(SCROLL_MAX).describe(`Scroll distance in CSS pixels, limited to +/-${SCROLL_MAX}. Use deltaX and/or deltaY.`)
// Keep the lexical constraint model-visible; URL parsing below checks the
// authority and port without rewriting the caller's value.
const httpUrl = z.string().regex(/^https?:\/\/[^@\s\\/?#]+(?:[/?#][^\s\\]*)?$/)
  .describe('Absolute HTTP(S) URL without credentials, whitespace or backslashes.')
const scroll = { ...observation, action: z.literal('scroll'), ref: ref.optional() }

/** One schema per action owns types, validation and discovery. The scroll
 * alternatives express a required delta in JSON Schema too; refine() cannot. */
const actions = {
  click: z.strictObject({ ...observation, action: z.literal('click'), ref }),
  fill: z.strictObject({ ...observation, action: z.literal('fill'), ref, text: z.string().max(FILL_MAX).describe(`Replacement text, at most ${FILL_MAX} characters; an empty string clears the control.`) }),
  select: z.strictObject({ ...observation, action: z.literal('select'), ref, text: z.string().describe('Exact option value from browser_inspect.') }),
  scroll: z.union([
    z.strictObject({ ...scroll, deltaX: delta, deltaY: delta.optional() }),
    z.strictObject({ ...scroll, deltaX: delta.optional(), deltaY: delta })
  ]),
  navigate: z.strictObject({ ...observation, action: z.literal('navigate'), url: httpUrl })
}
const captures = {
  viewport: z.strictObject({ snapshotId: snapshotId.optional() }),
  target: z.strictObject({ ...observation, ref })
}
const inputs = {
  browser_inspect: z.strictObject({}),
  browser_capture: z.union(Object.values(captures)),
  browser_act: z.union(Object.values(actions))
}
const browserInspectOutput = { type: 'object', properties: { documentId: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' }, snapshotId: { type: 'string' }, text: { type: 'string' }, elements: { type: 'array' }, truncated: { type: 'boolean' } }, required: ['documentId', 'url', 'title', 'snapshotId', 'text', 'elements', 'truncated'], additionalProperties: true } as const
const browserCaptureOutput = { type: 'object', properties: { source: { const: 'webpage' }, documentId: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' }, viewport: { type: 'object' } }, required: ['source', 'documentId', 'url', 'title', 'viewport'], additionalProperties: true } as const
const browserActionOutput = { type: 'object', properties: { dispatched: { enum: ['click', 'fill', 'select', 'scroll', 'navigate'] }, verification: { type: 'string' }, url: { type: 'string' } }, required: ['dispatched', 'verification'], additionalProperties: true } as const
export type BrowserAction = z.infer<typeof inputs.browser_act>
export type BrowserToolName = keyof typeof inputs

function inputSchema(schema: z.ZodType): ToolDefinition['inputSchema'] {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { target: 'draft-7' })
  return { type: 'object', ...json }
}

// Report the closest alternative, including all equally close ones, so a
// missing scroll delta names deltaX/deltaY instead of unrelated click fields.
function inputIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.flatMap(issue => {
    if (issue.code !== 'invalid_union') return [`${issue.path.join('.') || 'arguments'}: ${issue.message}`]
    const alternatives = issue.errors.map(inputIssues)
    const minimum = Math.min(...alternatives.map(errors => errors.length))
    return [...new Set(alternatives.filter(errors => errors.length === minimum).flat())]
  })
}
function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input)
  if (!result.success) throw new Error(inputIssues(result.error.issues).join('; '))
  return result.data
}
export function parseBrowserAction(input: unknown): BrowserAction {
  const action = input && typeof input === 'object' && 'action' in input ? input.action : undefined
  if (typeof action !== 'string' || !Object.hasOwn(actions, action)) throw new Error(`action must be one of: ${Object.keys(actions).join(', ')}`)
  const parsed = parse(actions[action as keyof typeof actions], input)
  if (parsed.action === 'navigate') {
    try {
      const url = new URL(parsed.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
    } catch {
      throw new Error('navigate requires an absolute HTTP(S) URL without credentials')
    }
  }
  return parsed
}
export function validateBrowserInput(tool: string, input: unknown): void {
  if (!Object.hasOwn(inputs, tool)) throw new Error(`Unknown browser tool: ${tool}`)
  if (tool === 'browser_act') parseBrowserAction(input)
  else if (tool === 'browser_capture') {
    const targeted = input && typeof input === 'object' && 'ref' in input
    parse(targeted ? captures.target : captures.viewport, input)
  }
  else parse(inputs[tool as BrowserToolName], input)
}

export const BROWSER_TOOLS = [
  { name: 'browser_inspect', annotations: { readOnlyHint: true, openWorldHint: true }, execution: { resource: 'browser', exclusive: true }, outputSchema: browserInspectOutput, description: 'Read the bound source webpage: title, URL, text from blocks intersecting the viewport, and refs for visible images and controls. This is a DOM observation, not proof of pixel visibility or full-page coverage. Returns a fresh snapshot ID; truncated and field-level flags disclose omitted content. Does not change the page. Closed tabs and unavailable site access fail explicitly.', inputSchema: inputSchema(inputs.browser_inspect) },
  { name: 'browser_capture', annotations: { readOnlyHint: true, openWorldHint: true }, execution: { resource: 'browser', exclusive: true }, outputSchema: browserCaptureOutput, description: 'Capture actual pixels of the bound source tab. It must be the active tab in its original window. Supply a ref and snapshotId from browser_inspect to crop to a visible image/control, or omit ref for the viewport. An optional snapshotId checks that the observation is still current. Returns JPEG and source identity. Never returns the canvas or another tab.', inputSchema: inputSchema(inputs.browser_capture) },
  { name: 'browser_act', annotations: { readOnlyHint: false, openWorldHint: true }, execution: { resource: 'browser', exclusive: true }, outputSchema: browserActionOutput, description: `Perform one authorized action on the bound source page. Every action variant declares its required arguments: click(ref), fill(ref,text), select(ref,text), scroll(deltaX and/or deltaY, optional ref), or navigate(url). All use snapshotId from browser_inspect. Scroll distances are limited to +/-${SCROLL_MAX} CSS pixels. DOM click/input events are synthetic: sites requiring trusted input, browser dialogs and cross-origin frames are unsupported. Capture or inspect again to verify the actual outcome; dispatch alone is not success. Actions are not automatically retried or undone.`, inputSchema: inputSchema(inputs.browser_act) }
] as const satisfies readonly ToolDefinition[]
export const BROWSER_TOOL_NAMES: readonly string[] = BROWSER_TOOLS.map(tool => tool.name)
export type BrowserContext = { available: false; reason: string } | { available: true; page: unknown }
