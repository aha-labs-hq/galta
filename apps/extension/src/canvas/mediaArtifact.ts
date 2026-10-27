import { newElementWith } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, FileId } from '@excalidraw/excalidraw/element/types'
import { managedArtifactReference, videoFile, type CanvasArtifacts, type CanvasAssets, type CanvasToolScope } from '@galta/canvas'
import type { ToolScene } from './toolScene'
import { createImageElement, imageDimensions, imageFile } from './imageImport'
import { createVideoElement, prepareVideo, videoData } from './video'

/** Prepared bytes have no document effect. The native operation planner owns
 * their placement, identity, relationships and final atomic commit. */
export async function prepareMediaArtifact(path: string, artifacts: CanvasArtifacts, scope: CanvasToolScope, viewport: ToolScene['viewport']) {
  const provenance = { executionId: scope.executionId, provenance: scope.provenance, generatedPath: managedArtifactReference(path, scope.cwd) }
  let element: ExcalidrawElement, files: CanvasAssets, width: number, height: number
  const kind = videoFile(path) ? 'video' as const : 'image' as const
  if (kind === 'video') {
    if (!artifacts.readVideo) throw new Error('This canvas connection does not support video imports. Update the Galta bridge.')
    const prepared = await prepareVideo(await artifacts.readVideo(path, scope), path.split(/[\\/]/).at(-1)!, scope.signal)
    width = prepared.video.width; height = prepared.video.height
    files = prepared.files
    element = createVideoElement(prepared.video, { x: 0, y: 0, width, height }, provenance)
  } else {
    const artifact = await artifacts.readImage(path, scope)
    const size = await imageDimensions(artifact.dataUrl, scope.signal), file = imageFile(artifact.dataUrl)
    width = size.w; height = size.h; files = { [file.id]: file }
    element = createImageElement({ file, width, height, provenance }, { x: width / 2, y: height / 2 })
  }
  scope.signal.throwIfAborted()
  const scale = Math.min(1, 520 / width, 520 / height, viewport.width * .6 / width, viewport.height * .6 / height)
  return { kind, element, files, width, height, defaultWidth: width * scale, defaultHeight: height * scale, center: viewport.center }
}
export type PreparedMediaArtifact = Awaited<ReturnType<typeof prepareMediaArtifact>>

export function replaceMediaElement(old: ExcalidrawElement, media: PreparedMediaArtifact): ExcalidrawElement {
  const customData = { ...old.customData, ...media.element.customData }
  if (media.kind === 'image' && old.type === 'image') {
    return newElementWith(old, { fileId: (media.element as typeof old).fileId as FileId, crop: null, status: 'saved', customData })
  }
  if (media.kind === 'video' && videoData(old)) return newElementWith(old, { customData })
  throw new Error('Media replacement requires an existing object of the same kind.')
}
