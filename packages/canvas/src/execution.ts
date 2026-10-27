/** The UI owns an embedded execution; external MCP clients acquire their own. */
export type ExecutionContext = { id: string; cwd: string }
export const EMBEDDED_MCP_ENV = 'GALTA_MCP_UI_OWNED'
/** Galta registers its embedded MCP server with this tool timeout, so a call there may block nearly that long. */
export const EMBEDDED_TOOL_TIMEOUT_SECONDS = 180

/** Shared-state exclusion is separate from MCP approval hints: exports create
 * files but only observe the canvas; webpage reads replace snapshot refs;
 * generation runs natively and shares no canvas or webpage state. */
export type ToolExecution = { resource: 'canvas' | 'browser' | 'media'; exclusive: boolean }
export type ToolDefinition = {
  name: string
  description: string
  inputSchema: Readonly<Record<string, unknown>>
  outputSchema?: Readonly<Record<string, unknown>>
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean }
  execution: ToolExecution
}
export const executionIdSchema = {
  type: 'string',
  minLength: 1,
  description: 'The exact id in the current execution application context. The UI owns this lease; never invent an id or reuse one from an earlier turn.'
} as const
