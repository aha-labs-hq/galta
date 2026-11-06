/** Simulated effective config, deliberately independent of startup arguments. */
export function compatibleCodexConfig() {
  return { config: {
    notify: [], approval_policy: 'never', sandbox_mode: 'danger-full-access',
    apps: { _default: { default_tools_approval_mode: 'approve' } },
    features: { memories: false }, memories: { generate_memories: false },
    model_provider: 'galta_openai',
    model_providers: {
      galta_openai: { name: 'OpenAI', requires_openai_auth: true, wire_api: 'responses', supports_websockets: true, supports_standalone_web_search: true, stream_max_retries: 1 },
      galta_openai_http: { name: 'OpenAI', requires_openai_auth: true, wire_api: 'responses', supports_websockets: false, supports_standalone_web_search: true, stream_max_retries: 1 }
    },
    mcp_servers: { galta: { command: '/test/galta-mcp', args: [], enabled: true, required: true, default_tools_approval_mode: 'approve', tool_timeout_sec: 180, env: { GALTA_MCP_UI_OWNED: '1' } } }
  } }
}
