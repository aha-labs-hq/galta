import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { validateHtml, validateVideo, assetBlob, isVideoLink, MAX_VIDEO_BYTES, normalizeAssets, type CanvasAssets } from '@galta/canvas'
import { videoData } from './video'
import { HTML_EMBED_LINK } from './htmlEmbed'
import { validateFreeDraw, type BrushValidation } from './freeDraw'

export type SceneSnapshot = {
  engine: 'excalidraw'; version: 1
  document: { elements: readonly ExcalidrawElement[]; files: CanvasAssets }
  view: { scrollX: number; scrollY: number; zoom: number }
}

export function validateSnapshot(value: unknown, checked?: BrushValidation): SceneSnapshot {
  const s = value as SceneSnapshot
  if (s?.engine !== 'excalidraw' || s.version !== 1 || !Array.isArray(s.document?.elements) || !s.document.files || !s.view) throw new Error('Unsupported canvas snapshot. The saved workspace has not been changed.')
  const ids = new Set<string>()
  for (const el of s.document.elements) {
    if (!el?.id || ids.has(el.id) || !['rectangle', 'ellipse', 'diamond', 'line', 'arrow', 'freedraw', 'text', 'image', 'frame', 'magicframe', 'embeddable', 'iframe'].includes(el.type)) throw new Error('Invalid or duplicate canvas element')
    ids.add(el.id)
    if (![el.x, el.y, el.width, el.height, el.angle].every(Number.isFinite) || el.width < 0 || el.height < 0) throw new Error('Invalid canvas geometry')
    if (el.type === 'freedraw') validateFreeDraw(el, checked)
    const requireAsset = (id: string | null, kind: 'image' | 'video') => {
      const file = id ? s.document.files[id] : undefined
      if (!file || file.id !== id || !file.mimeType.startsWith(`${kind}/`)) throw new Error(`Missing ${kind} data for ${el.id}`)
      const blob = assetBlob(file)
      if (!blob.size || kind === 'video' && blob.size > MAX_VIDEO_BYTES) throw new Error(`Invalid ${kind} source for ${el.id}`)
    }
    if (!el.isDeleted && el.type === 'image') requireAsset(el.fileId, 'image')
    if (el.type === 'embeddable' && isVideoLink(el.link)) {
      const video = videoData(el)
      validateVideo(video)
      if (!el.isDeleted) { requireAsset(video.fileId, 'video'); requireAsset(video.posterId, 'image') }
    }
    if (el.type === 'embeddable' && el.link === HTML_EMBED_LINK) validateHtml(el.customData?.htmlDocument?.html)
  }
  if (![s.view.scrollX, s.view.scrollY, s.view.zoom].every(Number.isFinite) || s.view.zoom <= 0) throw new Error('Invalid canvas viewport')
  return s
}
export function sceneDocument(elements: readonly ExcalidrawElement[], files: CanvasAssets): SceneSnapshot['document'] {
  const used = new Set(elements.flatMap(el => { const video = videoData(el); return video ? [video.fileId, video.posterId] : el.type === 'image' && el.fileId ? [el.fileId] : [] }))
  return { elements, files: normalizeAssets(Object.fromEntries(Object.entries(files).filter(([id]) => used.has(id)))) }
}
