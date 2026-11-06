import { stat } from 'node:fs/promises'
import { CODEX_OPENAI_PROVIDER, CODEX_OPENAI_HTTP_PROVIDER } from '../../../packages/runtime/src/codexConfig'

// The observed peer limit is about 16 MiB. Public thread items are a projection,
// not the exact model request, so reserve half for instructions, hidden provider
// fields and the current turn. Unknown/very long histories use HTTP as well.
const WS_CONTEXT_BUDGET = 8 * 1024 * 1024
const PAGE_LIMIT = 32
const MAX_PAGES = 64
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '')
export type ModelTransport = { modelProvider: string; reason: 'websocket' | 'large-context' | 'unmeasured-context' }

/** Select a transport, never a different model/account or a shortened history.
 * Only public app-server projections are read, entirely inside the native host.
 * No images, transcript text or filesystem paths cross back to the browser.
 */
export async function modelTransport(
  params: { threadId?: string; inputBytes: number },
  request: (method: string, params: unknown) => Promise<unknown>,
  imageSize: (path: string) => Promise<number> = async path => (await stat(path)).size
): Promise<ModelTransport> {
  if (!params || !Number.isSafeInteger(params.inputBytes) || params.inputBytes < 0 || params.inputBytes > 64 * 1024 * 1024 ||
      params.threadId !== undefined && (typeof params.threadId !== 'string' || !/^[\w-]{1,100}$/.test(params.threadId))) throw new Error('Invalid model transport request')
  const http = (reason: 'large-context' | 'unmeasured-context'): ModelTransport => ({ modelProvider: CODEX_OPENAI_HTTP_PROVIDER, reason })
  let size = params.inputBytes
  if (size >= WS_CONTEXT_BUDGET) return http('large-context')
  if (!params.threadId) return { modelProvider: CODEX_OPENAI_PROVIDER, reason: 'websocket' }
  let cursor: string | undefined
  const started = Date.now()
  const seen = new Set<string>()
  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() - started >= 2_000) return http('unmeasured-context')
    let result: any
    try { result = await request('thread/items/list', { threadId: params.threadId, cursor, limit: PAGE_LIMIT, sortDirection: 'desc' }) }
    // An older host may not expose paginated history. HTTP is safe without
    // guessing its context; the subsequent resume still owns any missing or
    // occupied-thread error. This read never starts, forks or retries a turn.
    catch { return http('unmeasured-context') }
    if (!Array.isArray(result?.data)) return http('unmeasured-context')
    for (const entry of result.data) {
      const item = entry?.item
      if (!item || typeof item.type !== 'string') return http('unmeasured-context')
      size += bytes(item)
      // view_image's public receipt contains a path while its model history
      // contains pixels. Count the base64 upper bound without reading the file.
      if (item.type === 'imageView') {
        if (typeof item.path !== 'string') return http('unmeasured-context')
        try {
          const length = await imageSize(item.path)
          if (!Number.isSafeInteger(length) || length < 0) return http('unmeasured-context')
          size += 4 * Math.ceil(length / 3)
        } catch { return http('unmeasured-context') }
      }
      if (size >= WS_CONTEXT_BUDGET) return http('large-context')
    }
    if (result.nextCursor == null) return { modelProvider: CODEX_OPENAI_PROVIDER, reason: 'websocket' }
    if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor)) return http('unmeasured-context')
    seen.add(result.nextCursor); cursor = result.nextCursor
  }
  return http('unmeasured-context')
}
