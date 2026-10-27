export type ImageReference = { url: string; sourceUrl?: string | undefined; file?: File; kind?: 'image' | 'video' }
export const REFERENCE_MIME = 'application/x-galta-reference'

export function httpUrl(value: string | undefined | null): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value.trim())
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch { return undefined }
}

/** Read synchronously: the browser revokes DataTransfer after the drop event. */
export function readImageDrop(data: Pick<DataTransfer, 'getData'>): ImageReference | null {
  const custom = data.getData(REFERENCE_MIME)
  if (custom) {
    try {
      const payload = JSON.parse(custom) as ImageReference
      const url = httpUrl(payload.url)
      if (url) return { url, sourceUrl: httpUrl(payload.sourceUrl), ...(payload.kind === 'video' ? { kind: 'video' as const } : {}) }
    } catch {
      const url = httpUrl(custom)
      if (url) return { url }
    }
  }
  const html = data.getData('text/html')
  if (html) {
    const document = new DOMParser().parseFromString(html, 'text/html')
    const media = document.querySelector('video[src], video source[src], img[src]')
    const url = httpUrl(media?.getAttribute('src'))
    if (url) return { url, sourceUrl: httpUrl(document.querySelector('a')?.getAttribute('href')), ...(media?.tagName === 'IMG' ? {} : { kind: 'video' as const }) }
  }
  const candidates = data.getData('text/uri-list').split(/\r?\n/).filter((line) => !line.startsWith('#'))
  candidates.push(data.getData('text/plain'))
  const url = candidates.map(httpUrl).find(Boolean)
  return url ? { url } : null
}
