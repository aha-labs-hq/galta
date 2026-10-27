import { normalizeAssets, portableAsset, type CanvasAssets } from '@galta/canvas'
import { exportWorkspace, importWorkspace, WorkspaceImportError } from '@galta/storage'
import { CanvasFileError } from './canvasFileError'
import type { MediaTransfer } from './portableMedia'
import type { SceneSnapshot } from './scene'

const encodeAssets = async (files: CanvasAssets): Promise<CanvasAssets> => Object.fromEntries(await Promise.all(Object.entries(files).map(async ([id, file]) => [id, await portableAsset(file)])))

self.onmessage = async (event: MessageEvent<MediaTransfer>) => {
  try {
    const request = event.data
    if (request.kind === 'assets') { self.postMessage({ files: normalizeAssets(request.files) }); return }
    if (request.kind === 'import') {
      let input: unknown
      try { input = JSON.parse(await request.file.text()) }
      catch (cause) { throw new CanvasFileError('unreadable', { cause }) }
      try {
        const workspace = importWorkspace(input as Parameters<typeof importWorkspace>[0])
        for (const value of Object.values(workspace.snapshots)) {
          const snapshot = value as SceneSnapshot
          if (snapshot?.engine === 'excalidraw' && snapshot.document?.files) snapshot.document.files = normalizeAssets(snapshot.document.files)
        }
        self.postMessage({ workspace }); return
      } catch (cause) {
        throw new CanvasFileError(cause instanceof WorkspaceImportError && cause.reason !== 'assets' ? cause.reason : 'contents', { cause })
      }
    }
    let value: unknown
    if (request.kind === 'workspace') value = await exportWorkspace(request.workspace)
    else {
      const files = await encodeAssets(request.document.files)
      value = { type: 'excalidraw/clipboard', elements: request.document.elements, files }
    }
    self.postMessage({ blob: new Blob([JSON.stringify(value)], { type: request.kind === 'workspace' ? 'application/json' : 'text/plain' }) })
  } catch (error) {
    self.postMessage({ error: error instanceof CanvasFileError ? { reason: error.reason } : { message: error instanceof Error ? error.message : String(error) } })
  }
}
