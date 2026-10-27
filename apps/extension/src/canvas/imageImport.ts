import { readResponseBlob, sourceImageFormat, type CanvasAsset } from '@galta/canvas'
import { newElementWith, restoreElements } from '@excalidraw/excalidraw'
import type { BinaryFileData, DataURL } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement, FileId } from '@excalidraw/excalidraw/element/types'
import type { CanvasScene } from './scene'
import { blobDataUrl } from './imageData'
import type { ImageReference } from './referenceDrop'

export function imageDimensions(url: string, signal?: AbortSignal): Promise<{ w: number; h: number }> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const image = new Image()
    const finish = (error?: Error) => {
      clearTimeout(timeout); image.onload = image.onerror = null
      signal?.removeEventListener('abort', abort)
      if (error) { image.src = ''; reject(error) }
      else if (image.naturalWidth && image.naturalHeight) resolve({ w: image.naturalWidth, h: image.naturalHeight })
      else reject(new Error('This image has no readable dimensions.'))
    }
    const abort = () => finish(signal!.reason)
    const timeout = window.setTimeout(() => finish(new Error('The image took too long to load.')), 12_000)
    signal?.addEventListener('abort', abort, { once: true })
    image.decoding = 'async'
    image.onload = () => finish(); image.onerror = () => finish(new Error('This image could not be decoded.')); image.src = url
  })
}
export async function imageBytes(url: string, signal?: AbortSignal): Promise<string> {
  if (url.startsWith('data:image/')) return url
  const parsed = new URL(url)
  if (!['http:', 'https:', 'blob:'].includes(parsed.protocol)) throw new Error('Unsupported image URL')
  const timeout = AbortSignal.timeout(15_000)
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  if (!response.ok) throw new Error(`Unable to download image (${response.status})`)
  const blob = await readResponseBlob(response, 32_000_000, 'Choose an image under 32 MB.')
  if (!blob.type.startsWith('image/') || blob.size > 32_000_000) throw new Error('Choose an image under 32 MB.')
  return blobDataUrl(blob)
}
export type PreparedImage = { file: CanvasAsset; width: number; height: number; sourceUrl?: string; provenance?: Record<string, unknown> }
export async function prepareImage(scene: CanvasScene, reference: ImageReference, signal?: AbortSignal): Promise<PreparedImage> {
  const viewport = scene.viewport
  signal?.throwIfAborted()
  let blob: Blob = reference.file!
  if (!blob) {
    const response = await fetch(reference.url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`Unable to download image (${response.status})`)
    blob = await readResponseBlob(response, 32_000_000, 'Choose an image under 32 MB.')
  }
  if (!sourceImageFormat(blob.type)) throw new Error(`Unsupported image source type: ${blob.type || 'unknown'}.`)
  if (!blob.size || blob.size > 32_000_000) throw new Error('Choose an image under 32 MB.')
  const url = URL.createObjectURL(blob)
  let size: { w: number; h: number }
  try { size = await imageDimensions(url, signal) } finally { URL.revokeObjectURL(url) }
  signal?.throwIfAborted()
  const scale = Math.min(1, 420 / size.w, 420 / size.h, viewport.width * .65 / size.w, viewport.height * .65 / size.h)
  return { file: { id: crypto.randomUUID(), blob, mimeType: blob.type, created: Date.now() }, width: size.w * scale, height: size.h * scale, ...(reference.sourceUrl ? { sourceUrl: reference.sourceUrl } : {}) }
}
export function imageFile(dataURL: string): BinaryFileData {
  if (!/^data:image\/[\w.+-]+;base64,/.test(dataURL)) throw new Error('An inline image is required')
  return { id: crypto.randomUUID() as FileId, dataURL: dataURL as DataURL, mimeType: dataURL.slice(5, dataURL.indexOf(';')) as BinaryFileData['mimeType'], created: Date.now() }
}
export function placeImage(scene: CanvasScene, image: PreparedImage, point: { x: number; y: number }): string[] {
  const element = createImageElement(image, point)
  scene.replace([...scene.elements, element], { ...scene.assets, [image.file.id]: image.file }, true, { selectedElementIds: { [element.id]: true } })
  return [element.id]
}

export function createImageElement(image: PreparedImage, point: { x: number; y: number }): ExcalidrawElement {
  const id = crypto.randomUUID()
  const elements = restoreElements([{ id, type: 'image', x: point.x - image.width / 2, y: point.y - image.height / 2, width: image.width, height: image.height, fileId: image.file.id, status: 'saved', scale: [1, 1], customData: { ...(image.sourceUrl ? { sourceUrl: image.sourceUrl } : {}), ...image.provenance } } as unknown as ExcalidrawElement], null)
  if (elements.length !== 1) throw new Error('Invalid image element')
  return elements[0]!
}

export type ImageReplacement = { id: string; versionNonce: number; restorationVersion: number }

export function replaceImage(scene: CanvasScene, image: PreparedImage, target: ImageReplacement): void {
  const old = scene.elements.find(el => el.id === target.id)
  if (scene.restorationVersion !== target.restorationVersion || old?.type !== 'image' || old.versionNonce !== target.versionNonce) {
    throw new Error('The image or canvas version changed. Select the image again to replace it.')
  }
  // Fit the full replacement inside the former bounds without stretching it.
  const scale = Math.min(old.width / image.width, old.height / image.height)
  const width = image.width * scale, height = image.height * scale
  const { sourceUrl: _source, generatedPath: _path, threadId: _thread, turnId: _turn, executionId: _execution, provenance: _provenance, ...metadata } = old.customData ?? {}
  const replacement = newElementWith(old, {
    x: old.x + (old.width - width) / 2, y: old.y + (old.height - height) / 2,
    width, height, fileId: image.file.id as FileId, crop: null, status: 'saved',
    customData: { ...metadata, ...(image.sourceUrl ? { sourceUrl: image.sourceUrl } : {}), ...image.provenance }
  })
  scene.replace(scene.elements.map(el => el.id === old.id ? replacement : el), { ...scene.assets, [image.file.id]: image.file })
}
