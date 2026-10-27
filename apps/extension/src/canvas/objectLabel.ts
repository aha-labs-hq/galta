import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { htmlDocument } from './htmlEmbed'
import { videoData } from './video'

/** The objects that carry their own words: a page, an image or a video. */
export type LabelledKind = 'page' | 'image' | 'video'
export type ObjectLabel = { title?: string; caption?: string }

export function labelledKind(element: ExcalidrawElement): LabelledKind | undefined {
  if (htmlDocument(element)) return 'page'
  if (videoData(element)) return 'video'
  return element.type === 'image' ? 'image' : undefined
}

/** A labelled object's title and caption, kept in its customData so they
 * travel with it through history, copies and exports of the document. */
export function objectLabel(element: ExcalidrawElement): ObjectLabel {
  if (!labelledKind(element)) return {}
  const { title, caption } = element.customData ?? {}
  return { ...(typeof title === 'string' && title ? { title } : {}), ...(typeof caption === 'string' && caption ? { caption } : {}) }
}

/** The customData after a title or caption change; blank text removes it. */
export function labelled(customData: ExcalidrawElement['customData'], change: { title?: unknown; caption?: unknown }): Record<string, unknown> {
  const next: Record<string, unknown> = { ...customData }
  for (const key of ['title', 'caption'] as const) {
    const value = change[key]
    if (value === undefined) continue
    const text = String(value).trim()
    if (text) next[key] = text
    else delete next[key]
  }
  return next
}
