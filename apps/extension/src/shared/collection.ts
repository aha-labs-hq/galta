/** A reference collected from a source webpage.
 *
 * The collection owns the source URL, not a second copy of the image bytes.
 * Canvas import is the single authority for downloading, decoding and saving
 * media. This keeps the browser-side collection small and means a thumbnail
 * never silently becomes a second asset store.
 */
export type CollectionItem = {
  id: string
  mediaUrl: string
  sourceUrl?: string
  pageUrl?: string
  title?: string
  pageTitle?: string
  collectedAt: number
}

export type CollectionItemInput = Omit<CollectionItem, 'id' | 'collectedAt'> & {
  id?: string
  collectedAt?: number
}

export const COLLECTION_STORAGE_KEY = 'galta.collection.v1'
/**
 * A collection is a lightweight reference index, not an image archive. One
 * thousand URL records stays below chrome.storage.local's normal quota while
 * making the library useful for sustained visual research.
 */
export const COLLECTION_LIMIT = 1000

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined
  } catch { return undefined }
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const next = value.trim().replace(/\s+/g, ' ')
  return next ? next.slice(0, limit) : undefined
}

/** Normalize untrusted storage/message data at the one collection boundary. */
export function normalizeCollection(value: unknown): CollectionItem[] {
  if (!Array.isArray(value)) return []
  const unique = new Map<string, CollectionItem>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const mediaUrl = httpUrl(item.mediaUrl)
    const collectedAt = typeof item.collectedAt === 'number' && Number.isFinite(item.collectedAt) ? item.collectedAt : 0
    if (!mediaUrl || collectedAt <= 0) continue
    const sourceUrl = httpUrl(item.sourceUrl)
    const pageUrl = httpUrl(item.pageUrl)
    const title = text(item.title, 160)
    const pageTitle = text(item.pageTitle, 160)
    const normalized: CollectionItem = {
      id: text(item.id, 120) ?? crypto.randomUUID(),
      mediaUrl,
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(pageUrl ? { pageUrl } : {}),
      ...(title ? { title } : {}),
      ...(pageTitle ? { pageTitle } : {}),
      collectedAt,
    }
    const previous = unique.get(mediaUrl)
    if (!previous || normalized.collectedAt > previous.collectedAt) unique.set(mediaUrl, normalized)
  }
  return [...unique.values()].sort((a, b) => b.collectedAt - a.collectedAt).slice(0, COLLECTION_LIMIT)
}

/** Add or refresh one URL, with newest-first ordering and deterministic dedupe. */
export function addCollectionItem(existing: readonly CollectionItem[], input: CollectionItemInput, now = Date.now(), id = crypto.randomUUID()): CollectionItem[] {
  const mediaUrl = httpUrl(input.mediaUrl)
  if (!mediaUrl) throw new Error('A collected reference needs an HTTP(S) media URL.')
  const sourceUrl = httpUrl(input.sourceUrl)
  const pageUrl = httpUrl(input.pageUrl)
  const title = text(input.title, 160), pageTitle = text(input.pageTitle, 160)
  const previous = existing.find(item => item.mediaUrl === mediaUrl)
  const next: CollectionItem = {
    id: previous?.id ?? text(input.id, 120) ?? id,
    mediaUrl,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(pageUrl ? { pageUrl } : {}),
    ...(title ? { title } : {}),
    ...(pageTitle ? { pageTitle } : {}),
    collectedAt: now,
  }
  return [next, ...existing.filter(item => item.mediaUrl !== mediaUrl)].slice(0, COLLECTION_LIMIT)
}

export function removeCollectionItem(existing: readonly CollectionItem[], id: string): CollectionItem[] {
  return existing.filter(item => item.id !== id)
}
