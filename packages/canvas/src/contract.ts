import { CANVAS_TOOLS } from './tools'
import { BROWSER_TOOLS } from './browser'
import { MEDIA_TOOLS } from './capabilities/media'
import { executionIdSchema, type ToolDefinition } from './execution'

/** Embedded callers use the lease supplied with their turn. External MCP
 * clients retain their explicit connect/disconnect protocol. */
export function embeddedTool(tool: ToolDefinition): ToolDefinition {
  return { ...tool, inputSchema: { ...tool.inputSchema,
    properties: { ...(tool.inputSchema.properties as Record<string, unknown>), executionId: executionIdSchema },
    required: [...((tool.inputSchema.required as string[] | undefined) ?? []), 'executionId']
  } }
}

// Derive compatibility from the executable surface, not independently bumped
// extension and app versions. Tool descriptions are not part of the contract.
let contract: Promise<string> | undefined
export function galtaToolContract(): Promise<string> {
  return contract ??= (async () => {
    const surface = [...CANVAS_TOOLS, ...BROWSER_TOOLS, ...MEDIA_TOOLS].map(embeddedTool).map(({ name, inputSchema, outputSchema, execution }) => ({ name, inputSchema, outputSchema, execution }))
    const bytes = new TextEncoder().encode(JSON.stringify(surface))
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  })()
}

export async function assertGaltaToolContract(actual: unknown): Promise<void> {
  const expected = await galtaToolContract()
  if (actual !== expected) throw new Error(`Galta's extension and local runtime have incompatible tools (expected ${expected.slice(0, 12)}, received ${typeof actual === 'string' ? actual.slice(0, 12) : 'unversioned'}). Update Galta for Mac, connect the browser, then reload the Galta extension and its open canvases before sending again.`)
}
