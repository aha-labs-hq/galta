/** Simulated effective config, deliberately independent of startup arguments. */
export function compatibleCodexConfig() {
  return { config: {
    notify: [], approval_policy: 'never', sandbox_mode: 'danger-full-access',
    apps: { _default: { default_tools_approval_mode: 'approve' } },
    features: { memories: false }, memories: { generate_memories: false },
    mcp_servers: { galta: { command: '/test/galta-mcp', args: [], enabled: true, required: true, default_tools_approval_mode: 'approve', tool_timeout_sec: 180, env: { GALTA_MCP_UI_OWNED: '1' } } }
  } }
}
