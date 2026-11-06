import { EMBEDDED_MCP_ENV, EMBEDDED_TOOL_TIMEOUT_SECONDS } from '@galta/canvas'

/** Galta owns the embedded process's notifications and execution policy.
 * CLI overrides leave the user's desktop configuration untouched.
 */
export const CODEX_EXECUTION_POLICY = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  sandboxPolicy: { type: 'dangerFullAccess' }
} as const

// A named configuration of the same OpenAI service and Codex-owned sign-in.
// Built-in provider IDs cannot be overridden. Keep endpoint and credentials
// unset: Codex resolves both from the account, as it does for built-in OpenAI.
export const CODEX_OPENAI_PROVIDER = 'galta_openai'
export const CODEX_OPENAI_HTTP_PROVIDER = 'galta_openai_http'
export const CODEX_OPENAI_TRANSPORT = {
  name: 'OpenAI',
  requires_openai_auth: true,
  wire_api: 'responses',
  supports_websockets: true,
  supports_standalone_web_search: true,
  // A persistent oversized WS message cannot heal by being sent five more
  // times. Allow one transient retry, then Codex changes transport within the
  // same turn. This also bounds SSE stream retries; HTTP request retries and
  // Retry-After remain Codex defaults. Galta never restarts the user turn.
  stream_max_retries: 1
} as const

export const CODEX_EMBEDDED_CONFIG = {
  notify: [],
  approval_policy: CODEX_EXECUTION_POLICY.approvalPolicy,
  sandbox_mode: CODEX_EXECUTION_POLICY.sandbox,
  'apps._default.default_tools_approval_mode': 'approve',
  // Login is owned by this private home, including on systems with a keyring.
  cli_auth_credentials_store: 'file',
  // Creative conversations do not participate in Codex memory consolidation.
  'features.memories': false,
  'memories.generate_memories': false
} as const

/** Per-thread settings for Galta conversations. The private state home keeps
 * login and history separate from the desktop. These switches remove coding
 * skill catalogues and redundant permissions, collaboration-mode and app
 * instructions from canvas conversations without changing other Codex sessions.
 *
 * Every switch here acts after the request's shared prefix. Codex keys its
 * prompt cache per thread, so a thread's first request hits the cache only for
 * a prefix that is common across Codex: the tool block and the base prompt.
 * Declaring Galta's tools up front or replacing the base prompt made that
 * prefix Galta's own, and first requests went from 12,160 cached tokens to
 * none. Feature switches that change the tool block (plugins, apps, goals) are
 * left alone for the same reason. Structured user input is the deliberate
 * exception: the canvas must be able to answer a real question in Default mode.
 *
 * Deliberately absent: a per-thread `mcp_servers` table replaces the
 * process's server table, which removes the galta server itself. The global
 * AGENTS.md and the multi-agent role have no per-thread switch in
 * 0.162.0-alpha.17.2. */
export const CODEX_THREAD_CONFIG = {
  'features.default_mode_request_user_input': true,
  'skills.include_instructions': false,
  include_permissions_instructions: false,
  include_collaboration_mode_instructions: false,
  include_apps_instructions: false
} as const

// These scalar values and string arrays use JSON syntax that is also valid TOML.
export const CODEX_EMBEDDED_ARGS = Object.entries({
  ...CODEX_EMBEDDED_CONFIG,
  model_provider: CODEX_OPENAI_PROVIDER,
  ...Object.fromEntries([CODEX_OPENAI_PROVIDER, CODEX_OPENAI_HTTP_PROVIDER].flatMap(id =>
    Object.entries({ ...CODEX_OPENAI_TRANSPORT, supports_websockets: id === CODEX_OPENAI_PROVIDER }).map(([key, value]) => [`model_providers.${id}.${key}`, value])))
})
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
    model_provider?: unknown
    model_providers?: Record<string, Record<string, unknown>>
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
  for (const id of [CODEX_OPENAI_PROVIDER, CODEX_OPENAI_HTTP_PROVIDER]) {
    const provider = config.model_providers?.[id]
    const expected = { ...CODEX_OPENAI_TRANSPORT, supports_websockets: id === CODEX_OPENAI_PROVIDER }
    if (config.model_provider !== CODEX_OPENAI_PROVIDER || !provider ||
        Object.entries(expected).some(([key, value]) => provider[key] !== value) ||
        ['base_url', 'env_key', 'experimental_bearer_token', 'model_catalog_url'].some(key => provider[key] != null)) {
      throw new Error('This Codex connection does not apply Galta’s model transport policy. Update Galta for Mac and reconnect.')
    }
  }
}
