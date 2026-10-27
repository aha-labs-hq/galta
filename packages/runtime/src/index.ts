import type { ConversationItem, ProjectId, RuntimeContext } from '@galta/domain'
export type { ConversationItem } from '@galta/domain'
export { NativeMessageDecoder, encodeNativeMessages } from './transport'
export { COMPANION_PROTOCOL, REQUIRED_CAPABILITIES, assessCompanion, type CompanionHealth, type SetupStatus } from './lifecycle'
export { CODEX_EMBEDDED_CONFIG, CODEX_EMBEDDED_ARGS, CODEX_EXECUTION_POLICY, assertCodexEmbeddedConfig } from './codexConfig'
export { CodexAgentRuntime, additionalContext, conversationItem, type CodexJsonRpcNotification, type CodexRpcClient } from './codex'
export { CodexMetadata, type GeneratedNames } from './codexMetadata'

import type { BrowserContext, CanvasMessage, ExecutionContext } from '@galta/canvas'
export type AgentRunState = 'idle' | 'preparing' | 'streaming' | 'completed' | 'stopped' | 'failed'
export type AgentInput = {
  projectId: ProjectId; branchId: string
  canvas?: CanvasMessage
  browser?: BrowserContext
  execution: ExecutionContext
  instruction: string; runtime: RuntimeContext
}
/** Provider-reported context usage; absence means the provider did not report it. */
export type ContextPressure = { tokens: number; window: number }
export type AgentUpdate = { state: AgentRunState; text?: string; item?: ConversationItem; context?: ContextPressure }
export type AgentHost = {
  request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}
export type AgentRunHandle<Update extends AgentUpdate = AgentUpdate> = { runId: string; updates: AsyncIterable<Update> }
export interface AgentRuntime<Input extends AgentInput = AgentInput, Update extends AgentUpdate = AgentUpdate> {
  readonly id: string
  readonly capabilities: { persistentSessions: boolean; forkAtTurn: boolean; contextUsage: boolean; steering?: boolean }
  start(input: Input, host: AgentHost): Promise<AgentRunHandle<Update>>
  steer?(runId: string, instruction: string): Promise<void>
  stop(runId: string): Promise<void>
}
export type { CodexAgentInput, CodexAgentUpdate } from './codex'
