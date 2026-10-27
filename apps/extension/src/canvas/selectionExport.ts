import { exportToBlob } from '@excalidraw/excalidraw'
import { assetBlob, sourceImageFormat } from '@galta/canvas'
import { withPosters } from './htmlPoster'
import { htmlDocument } from './htmlEmbed'
import { videoData } from './video'
import type { CanvasScene } from './scene'

export async function exportSelection(scene: CanvasScene): Promise<Blob> {
  const ids = new Set(scene.selectedIds)
  const elements = structuredClone(scene.elements.filter(el => ids.has(el.id) || el.type === 'text' && el.containerId && ids.has(el.containerId)))
  if (!elements.length) throw new Error('Select artwork to export.')
  const appState = { ...scene.api.getAppState(), exportBackground: false, exportWithDarkMode: false }
  return exportToBlob({
    ...await withPosters(elements, scene.files), mimeType: 'image/png', exportPadding: 0,
    appState,
    maxWidthOrHeight: 4096
  })
}

/** Capture the requested selection before any asynchronous rendering starts. */
export async function selectionFile(scene: CanvasScene, format: 'png' | 'original' | 'html'): Promise<{ blob: Blob; name: string }> {
  if (format === 'png') return { blob: await exportSelection(scene), name: 'galta-selection.png' }
  const element = scene.selected.length === 1 ? scene.selected[0] : undefined
  if (!element) throw new Error('Select one object to download its file.')
  if (format === 'html') {
    const document = htmlDocument(element)
    if (!document) throw new Error('The selected object is not a webpage.')
    return { blob: new Blob([document.html], { type: 'text/html;charset=utf-8' }), name: 'galta-page.html' }
  }
  const video = videoData(element), id = video?.fileId ?? (element.type === 'image' ? element.fileId : null)
  const file = id ? scene.asset(id) : undefined
  if (!file) throw new Error('The original file is unavailable.')
  if (video) return { blob: assetBlob(file), name: video.name || 'galta-video' }
  const imageFormat = sourceImageFormat(file.mimeType)
  if (!imageFormat) throw new Error(`Unsupported image source type: ${file.mimeType}.`)
  return { blob: assetBlob(file), name: `galta-image.${imageFormat.type}` }
}
