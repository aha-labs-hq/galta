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
  /** Galta's own runtime: the installed release's executables. */
  runtime: { available: boolean; version?: string; error?: string }
  /** Absent from Mac apps that bundled Codex (0.1.4 and earlier); their
   * runtime check covered it. */
  codex?: CodexAvailability
}

/** What a Codex download fetches: the official package Galta was tested with. */
export type CodexDownload = { version: string; bytes: number }

/** Chat in Galta runs on Codex: the user's own when it is new enough,
 * otherwise a copy Galta downloads only when the user asks (`codex/download`).
 * Canvas access and external agents never depend on it. */
export type CodexAvailability =
  | { state: 'ready'; version: string; source: 'yours' | 'galta' | 'override' }
  | { state: 'missing'; download: CodexDownload }
  /** The newest Codex found is older than Galta supports: the user's own, or
   * Galta's copy after a newer Galta raised the pinned version. */
  | { state: 'outdated'; version: string; source: 'yours' | 'galta'; minimum: string; download: CodexDownload }
  | { state: 'downloading'; received: number; download: CodexDownload }
  | { state: 'failed'; error: string; download: CodexDownload }
  /** Not sent by Galta for Mac: how this extension reads a `codex` it does not
   * understand, from a newer Mac app. Chat asks for an extension update; the
   * canvas and external agents are unaffected. */
  | { state: 'unrecognized' }

function validCodex(value: unknown): value is Exclude<CodexAvailability, { state: 'unrecognized' }> {
  const c = value as Record<string, unknown> | null, text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 400
  if (!c || typeof c !== 'object') return false
  if (c.state === 'ready') return text(c.version) && ['yours', 'galta', 'override'].includes(c.source as string)
  const download = c.download as Record<string, unknown> | undefined
  if (!text(download?.version) || !Number.isSafeInteger(download?.bytes)) return false
  return c.state === 'missing' || c.state === 'outdated' && text(c.version) && text(c.minimum) && ['yours', 'galta'].includes(c.source as string)
    || c.state === 'downloading' && Number.isSafeInteger(c.received) || c.state === 'failed' && text(c.error)
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
  // Only Chat needs Codex, so a Codex report this extension cannot read never
  // makes the Mac app incompatible.
  const health = (h.codex === undefined || validCodex(h.codex) ? h : { ...h, codex: { state: 'unrecognized' } }) as CompanionHealth
  return health.runtime.available ? { state: 'ready', health }
    : { state: 'runtime-unavailable', health, detail: 'Galta for Mac’s runtime couldn’t start. Open Galta on your Mac for the next step.' }
}
