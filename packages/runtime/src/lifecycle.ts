/** Browser, companion and MCP versions evolve independently across this seam. */
export const COMPANION_PROTOCOL = 1
export const REQUIRED_CAPABILITIES = ['canvas/1', 'codex/1', 'mcp/1'] as const

export type CompanionHealth = {
  /** Stable installed launcher, provided by the registered native host. */
  mcpCommand?: string
  protocol: number
  version: string
  releaseId: string
  channel: 'development' | 'beta' | 'stable'
  capabilities: string[]
  runtime: { available: boolean; version?: string; error?: string }
}

/** Every detail is a sentence for the user: what is wrong and the step that fixes it. */
export type SetupStatus =
  /** This browser has no Galta for Mac registration. */
  | { state: 'absent'; detail: string }
  /** Galta for Mac is registered but could not answer, or reported a problem it found. */
  | { state: 'unavailable'; detail: string }
  | { state: 'incompatible'; detail: string }
  | { state: 'runtime-unavailable'; health: CompanionHealth; detail: string }
  | { state: 'ready'; health: CompanionHealth }

/** Do not interpret a reachable host, malformed reply or newer major as ready. */
export function assessCompanion(value: unknown): SetupStatus {
  const h = value as (Partial<CompanionHealth> & { error?: unknown }) | null
  // The host found a problem on this Mac and names the step that fixes it.
  if (h && h.protocol === undefined && typeof h.error === 'string' && h.error.length > 0 && h.error.length <= 400) return { state: 'unavailable', detail: h.error }
  if (!h || h.protocol !== COMPANION_PROTOCOL || typeof h.version !== 'string' || typeof h.releaseId !== 'string'
    || !['development', 'beta', 'stable'].includes(h.channel ?? '') || !Array.isArray(h.capabilities)
    || (h.mcpCommand !== undefined && (typeof h.mcpCommand !== 'string' || !h.mcpCommand.startsWith('/') || /[\r\n\0]/.test(h.mcpCommand)))
    || !REQUIRED_CAPABILITIES.every(c => h.capabilities!.includes(c)) || typeof h.runtime?.available !== 'boolean') {
    return { state: 'incompatible', detail: 'The extension and Mac app need compatible updates. Update Galta in the browser and on this Mac, then check again.' }
  }
  const health = h as CompanionHealth
  return health.runtime.available ? { state: 'ready', health }
    : { state: 'runtime-unavailable', health, detail: 'Galta for Mac’s AI runtime couldn’t start. Open Galta on your Mac for the next step.' }
}
