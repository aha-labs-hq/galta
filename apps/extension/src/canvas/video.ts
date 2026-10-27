import { CaptureUpdateAction, newElementWith, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, FileId } from '@excalidraw/excalidraw/element/types'
import type { BinaryFiles } from '@excalidraw/excalidraw/types'
import { MAX_VIDEO_BYTES, VIDEO_LINK, videoData, validateVideo, type CanvasVideo, type CanvasAssets, AssetURLs, assetBlob } from '@galta/canvas'
import type { CanvasScene } from './scene'
import type { ImageReplacement } from './imageImport'

export { videoData } from '@galta/canvas'

/** A video's length as people read it: 0:05, 12:40, 1:02:03. */
export function formatDuration(duration: number) {
  const seconds = Math.floor(duration)
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function activateVideo(scene: CanvasScene, element: ExcalidrawElement) {
  scene.api.updateScene({ appState: { selectedElementIds: { [element.id]: true }, activeEmbeddable: { element: element as import('@excalidraw/excalidraw/element/types').ExcalidrawEmbeddableElement, state: 'active' } }, captureUpdate: CaptureUpdateAction.NEVER })
}

export function replaceVideo(scene: CanvasScene, prepared: Awaited<ReturnType<typeof prepareVideo>>, target: ImageReplacement) {
  const old = scene.elements.find(el => el.id === target.id)
  if (scene.restorationVersion !== target.restorationVersion || !old || !videoData(old) || old.versionNonce !== target.versionNonce) throw new Error('The video or canvas version changed. Select the video again to replace it.')
  const { sourceUrl: _source, generatedPath: _path, threadId: _thread, turnId: _turn, executionId: _execution, provenance: _provenance, ...metadata } = old.customData ?? {}
  const next = newElementWith(old, { customData: { ...metadata, video: prepared.video } })
  scene.replace(scene.elements.map(el => el.id === old.id ? next : el), { ...scene.assets, ...prepared.files })
}

/** Decode once at import. Reject unreadable codecs before any document edit,
 * and always release the decoder and temporary URL, including cancellation. */
export async function prepareVideo(blob: Blob, name: string, signal?: AbortSignal): Promise<{ video: CanvasVideo; files: CanvasAssets }> {
  signal?.throwIfAborted()
  if (!blob.size || blob.size > MAX_VIDEO_BYTES) throw new Error('Choose a video under 128 MB.')
  const mimeType = blob.type.startsWith('video/') ? blob.type : (/\.webm$/i.test(name) ? 'video/webm' : /\.mov$/i.test(name) ? 'video/quicktime' : /\.ogv$/i.test(name) ? 'video/ogg' : 'video/mp4')
  const source = blob.type === mimeType ? blob : blob.slice(0, blob.size, mimeType)
  const decoder = document.createElement('video'), url = URL.createObjectURL(source)
  decoder.muted = true; decoder.playsInline = true; decoder.preload = 'auto'
  try {
    await new Promise<void>((resolve, reject) => {
      const done = (error?: unknown) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort)
        decoder.onloadeddata = decoder.onerror = null
        error ? reject(error) : resolve()
      }
      const abort = () => done(signal!.reason)
      const timer = setTimeout(() => done(new Error('This video took too long to decode.')), 15_000)
      signal?.addEventListener('abort', abort, { once: true })
      decoder.onloadeddata = () => done()
      decoder.onerror = () => done(new Error('This video could not be decoded. Use MP4 (H.264) or WebM.'))
      decoder.src = url
    })
    signal?.throwIfAborted()
    const width = decoder.videoWidth, height = decoder.videoHeight, duration = decoder.duration
    if (!width || !height || !Number.isFinite(duration) || duration <= 0) throw new Error('This video has no readable frames or duration.')
    const scale = Math.min(1, 1280 / Math.max(width, height)), poster = document.createElement('canvas')
    poster.width = Math.max(1, Math.round(width * scale)); poster.height = Math.max(1, Math.round(height * scale))
    poster.getContext('2d')!.drawImage(decoder, 0, 0, poster.width, poster.height)
    const posterBlob = await new Promise<Blob>((resolve, reject) => poster.toBlob(blob => blob ? resolve(blob) : reject(new Error('Unable to create video poster')), 'image/jpeg', .85))
    const fileId = crypto.randomUUID(), posterId = crypto.randomUUID(), created = Date.now()
    const video: CanvasVideo = { version: 1, fileId, posterId, name: name.slice(0, 512), width, height, duration }
    signal?.throwIfAborted(); validateVideo(video)
    return { video, files: {
      [fileId]: { id: fileId, mimeType, created, blob: source },
      [posterId]: { id: posterId, mimeType: 'image/jpeg', created, blob: posterBlob }
    } }
  } finally { decoder.pause(); decoder.removeAttribute('src'); decoder.load(); URL.revokeObjectURL(url) }
}

export function createVideoElement(video: CanvasVideo, bounds: { x: number; y: number; width: number; height: number }, provenance: Record<string, unknown> = {}): ExcalidrawElement {
  validateVideo(video)
  return restoreElements([{ type: 'embeddable', id: crypto.randomUUID(), ...bounds, link: VIDEO_LINK,
    strokeWidth: 0, strokeColor: 'transparent', backgroundColor: 'transparent', roughness: 0,
    customData: { ...provenance, video } } as unknown as ExcalidrawElement], null)[0]!
}

/** All bitmap consumers use the saved poster, never a live playback frame.
 * This is an export projection only; the editable element remains a video. */
export function withVideoPosters(elements: readonly ExcalidrawElement[], files: BinaryFiles) {
  return { files, elements: elements.map(element => {
    const video = videoData(element)
    if (!video) return element
    return { ...element, type: 'image', fileId: video.posterId as FileId, status: 'saved', scale: [1, 1], crop: null, customData: {} } as ExcalidrawElement
  }) }
}

/** Excalidraw receives only image files. Video bytes never reach its decoder. */
export function editorFiles(files: CanvasAssets, urls: AssetURLs): BinaryFiles {
  return Object.fromEntries(Object.entries(files).filter(([, file]) => file.mimeType.startsWith('image/')).map(([id, file]) =>
    [id, { ...file, blob: assetBlob(file), dataURL: urls.url(file) }])) as unknown as BinaryFiles
}
