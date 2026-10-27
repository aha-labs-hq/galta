import type { ToolDefinition } from '../../packages/canvas/src/execution'
import type { ToolResult } from '../../packages/canvas/src/index'

/**
 * A producer the agent calls on through the Galta MCP. The canvas is the core;
 * a capability makes files or data and never changes a canvas itself, so the
 * canvas tools stay the only way work reaches the user's document.
 *
 * A capability lists tools only while it can be used, so one that is not
 * connected costs the agent no context, and it reports when that changes.
 * Its detail (craft, catalogues) belongs in its tool results, on demand.
 */
/** What the server knows about one call: where its files belong, when the
 * caller has given up, and how long the caller lets a call block. */
export type CallScope = { workspace: string | undefined; signal: AbortSignal; maxWaitSeconds: number }

export interface Capability {
  /** The tools the agent can use now; none while the capability is unavailable. */
  tools(): Promise<readonly ToolDefinition[]>
  owns(name: string): boolean
  /** Calls that write files into the bound execution's workspace. */
  writesFiles(name: string): boolean
  call(name: string, args: unknown, scope: CallScope): Promise<ToolResult>
  /** Calls `changed` whenever tools() would answer differently; returns a stop function. */
  watch(changed: () => void): () => void
}
