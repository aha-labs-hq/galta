import { normalizeAsset, videoData, type CanvasAsset, type CanvasChanges, type CanvasMessageContext } from '@galta/canvas'
import type { ExcalidrawElement, ExcalidrawImageElement } from '@excalidraw/excalidraw/element/types'
import type { CanvasScene } from './scene'

export type SubmittedImage = { element: ExcalidrawImageElement; file: CanvasAsset }
export type SubmittedVideo = { element: ExcalidrawElement; file: CanvasAsset }
export type SubmittedHtml = { element: ExcalidrawElement; html: string }
export type SubmittedContext = { selection: readonly string[]; viewport: CanvasMessageContext['viewport']; images: readonly SubmittedImage[]; videos: readonly SubmittedVideo[]; html: readonly SubmittedHtml[]; changes?: CanvasChanges }

export function captureSubmittedContext(scene: CanvasScene): SubmittedContext {
  const images = scene.selected.flatMap((element): SubmittedImage[] => {
    if (element.type !== 'image') return []
    const file = element.fileId ? scene.assets[element.fileId] : undefined
    if (!file) throw new Error('A submitted image has no readable data. The request was not started.')
    return [{ element, file: normalizeAsset(file) }]
  })
  const videos = scene.selected.flatMap((element): SubmittedVideo[] => {
    const video = videoData(element)
    if (!video) return []
    const file = scene.assets[video.fileId]
    if (!file) throw new Error('A submitted video has no readable data. The request was not started.')
    return [{ element, file: normalizeAsset(file) }]
  })
  const html = scene.selected.flatMap((element): SubmittedHtml[] => {
    const document = element.customData?.htmlDocument
    return typeof document?.html === 'string' ? [{ element, html: document.html }] : []
  })
  const { x, y, width, height, zoom } = scene.surface
  return structuredClone({ selection: scene.selectedIds, viewport: { x, y, width, height, zoom }, images, videos, html })
}
