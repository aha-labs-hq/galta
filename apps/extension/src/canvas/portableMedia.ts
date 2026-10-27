import type { WorkspaceBundle } from '@galta/storage'
import type { CanvasAssets } from '@galta/canvas'
import type { SceneSnapshot } from './scene'
import { CanvasFileError, type CanvasFileFailure } from './canvasFileError'

export type MediaExport = { kind: 'workspace'; workspace: WorkspaceBundle } | { kind: 'clipboard'; document: SceneSnapshot['document'] }
export type MediaTransfer = MediaExport | { kind: 'import'; file: Blob } | { kind: 'assets'; files: CanvasAssets }
type Result = { blob?: Blob; workspace?: WorkspaceBundle; files?: CanvasAssets; error?: { reason?: CanvasFileFailure; message?: string } }

/** Encoding and JSON serialization can hold hundreds of MB. One short-lived
 * worker owns that work; the UI transfers only immutable Blob handles. */
function transfer(request: MediaTransfer): Promise<Result> {
  return new Promise((resolve, reject) => {
    const failure = (cause: unknown) => request.kind === 'import' ? new CanvasFileError('processing', { cause })
      : new Error('Galta couldn’t prepare this media. Try again. Your saved work is preserved.', { cause })
    let worker: Worker
    try { worker = new Worker(new URL('./portableMedia.worker.ts', import.meta.url), { type: 'module' }) }
    catch (cause) { reject(failure(cause)); return }
    const fail = (message: string) => { worker.terminate(); reject(failure(new Error(message))) }
    worker.onmessage = event => {
      worker.terminate()
      const result = event.data as Result
      if (result.error) reject(result.error.reason ? new CanvasFileError(result.error.reason) : failure(new Error(result.error.message)))
      else resolve(result)
    }
    worker.onerror = event => { event.preventDefault(); fail(event.message || 'Unable to export media') }
    worker.onmessageerror = () => fail('Unable to receive media export')
    try { worker.postMessage(request) } catch (error) { fail(String(error)) }
  })
}

export async function portableMedia(request: MediaExport): Promise<Blob> {
  const result = await transfer(request)
  if (!(result.blob instanceof Blob)) throw new Error('Unable to export media')
  return result.blob
}

export async function readPortableWorkspace(file: Blob): Promise<WorkspaceBundle> {
  const result = await transfer({ kind: 'import', file })
  if (!result.workspace) throw new Error('Unable to read this canvas')
  return result.workspace
}

export async function readPortableAssets(files: CanvasAssets): Promise<CanvasAssets> {
  const result = await transfer({ kind: 'assets', files })
  if (!result.files) throw new Error('Unable to read media sources')
  return result.files
}
