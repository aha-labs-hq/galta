import { EMBEDDED_MCP_ENV, EMBEDDED_TOOL_TIMEOUT_SECONDS } from '@galta/canvas'

/** Galta owns the embedded process's notifications and execution policy.
 * CLI overrides leave the user's desktop configuration untouched.
 */
export const CODEX_EXECUTION_POLICY = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  sandboxPolicy: { type: 'dangerFullAccess' }
} as const

export const CODEX_EMBEDDED_CONFIG = {
  notify: [],
  approval_policy: CODEX_EXECUTION_POLICY.approvalPolicy,
  sandbox_mode: CODEX_EXECUTION_POLICY.sandbox,
  'apps._default.default_tools_approval_mode': 'approve',
  // Codex memory is one store per CODEX_HOME, shared with the user's coding
  // sessions. Galta neither loads it into creative conversations nor runs its
  // consolidation pipeline, and marks its own threads as excluded from mining.
  'features.memories': false,
  'memories.generate_memories': false
} as const

// These values are strings, string arrays and booleans, whose JSON is also valid TOML.
export const CODEX_EMBEDDED_ARGS = Object.entries(CODEX_EMBEDDED_CONFIG)
  .flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])

/** Verify the effective app-server config, not merely the requested CLI flag.
 * Unknown config keys can be ignored, and an installed bridge can be stale.
 */
export function assertCodexEmbeddedConfig(response: unknown): void {
  const value = response as { config?: {
    notify?: unknown
    approval_policy?: unknown
    sandbox_mode?: unknown
    apps?: { _default?: { default_tools_approval_mode?: unknown } }
    features?: { memories?: unknown }
    memories?: { generate_memories?: unknown }
    mcp_servers?: { galta?: { command?: unknown; args?: unknown; enabled?: unknown; required?: unknown; default_tools_approval_mode?: unknown; tool_timeout_sec?: unknown; env?: Record<string, unknown> } }
  } } | null
  const config = value?.config
  const mcp = config?.mcp_servers?.galta
  if (typeof mcp?.command !== 'string' || !mcp.command || !Array.isArray(mcp.args) || mcp.args.length || mcp.enabled !== true || mcp.required !== true || mcp.default_tools_approval_mode !== 'approve') {
    throw new Error('This Codex connection does not provide the unified Galta MCP. Rebuild the Galta bridge and reconnect.')
  }
  if (mcp.tool_timeout_sec !== EMBEDDED_TOOL_TIMEOUT_SECONDS) {
    throw new Error('This Codex connection gives Galta tools too little time to wait for generations. Update the local runtime and reconnect.')
  }
  if (mcp.env?.[EMBEDDED_MCP_ENV] !== '1') {
    throw new Error('This Codex connection does not bind Galta tools to each UI execution. Update the local runtime and reconnect.')
  }
  if (!Array.isArray(config?.notify) || config.notify.length !== 0) {
    throw new Error('This Codex connection still enables external desktop notifications. Rebuild the Galta bridge and reconnect.')
  }
  if (config.approval_policy !== CODEX_EXECUTION_POLICY.approvalPolicy ||
      config.sandbox_mode !== CODEX_EXECUTION_POLICY.sandbox ||
      config.apps?._default?.default_tools_approval_mode !== CODEX_EMBEDDED_CONFIG['apps._default.default_tools_approval_mode']) {
    throw new Error('This Codex connection does not apply Galta’s execution policy. Rebuild the Galta bridge and reconnect.')
  }
  if (config.features?.memories !== false || config.memories?.generate_memories !== false) {
    throw new Error('This Codex connection still shares Codex memory with Galta. Rebuild the Galta bridge and reconnect.')
  }
}
