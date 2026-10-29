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

/** Per-thread settings for Galta conversations. The embedded process shares
 * the user's CODEX_HOME for sign-in, and with it their coding setup. Measured
 * on 2026-10-27, these switches remove what a canvas never uses: the skills
 * catalogue (about 25k characters on the owner's Mac) and the permissions,
 * collaboration-mode and apps blocks. They apply to Galta's threads only; the
 * user's files and other Codex sessions are untouched.
 *
 * Every switch here acts after the request's shared prefix. Codex keys its
 * prompt cache per thread, so a thread's first request hits the cache only for
 * a prefix that is common across Codex: the tool block and the base prompt.
 * Declaring Galta's tools up front or replacing the base prompt made that
 * prefix Galta's own, and first requests went from 12,160 cached tokens to
 * none. Feature switches that change the tool block (plugins, apps, goals) are
 * left alone for the same reason.
 *
 * Deliberately absent: a per-thread `mcp_servers` table replaces the
 * process's server table, which removes the galta server itself. The global
 * AGENTS.md and the multi-agent role have no per-thread switch in
 * 0.162.0-alpha.17.2. */
export const CODEX_THREAD_CONFIG = {
  'skills.include_instructions': false,
  include_permissions_instructions: false,
  include_collaboration_mode_instructions: false,
  include_apps_instructions: false
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
