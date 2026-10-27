// Local review fixture, omitted from all extension build entry points. Mounts
// the real CanvasApp and seeds sample artwork only on this fresh local origin.
import { createRoot } from 'react-dom/client'
import { convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { FileId } from '@excalidraw/excalidraw/element/types'
import { asProjectId } from '@galta/domain'
import { CanvasApp } from '../canvas/App'
import { createInitialWorkspace, workspaceRepository } from '../canvas/workspace'
const glass = new URL('../../../../tests/fixtures/reference-glass.png', import.meta.url).href
const citrus = new URL('../../../../tests/fixtures/reference-citrus.png', import.meta.url).href
const reference = new URL('../../../../tests/fixtures/reference.svg', import.meta.url).href

const samples = [
  ['Morning light', glass], ['Spring afternoon', citrus],
  ['Stone and silence', reference], ['Glass studies', glass],
  ['Colour notes', citrus], ['A quiet entrance', reference],
  ['Untitled canvas', undefined],
] as const

if (!(await workspaceRepository.list()).length) {
  const now = Date.now()
  for (const [index, [title, url]] of samples.entries()) {
    const workspace = createInitialWorkspace(asProjectId(`picker-sample-${index}`), now - index * 86_400_000)
    workspace.project.title = title
    const files: Record<string, { id: string; mimeType: string; blob: Blob; created: number }> = {}
    let elements: ReturnType<typeof convertToExcalidrawElements> = []
    let preview: string | undefined
    if (url) {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Sample artwork failed: ${response.status}`)
      const blob = await response.blob()
      preview = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
      })
      const image = new Image()
      image.src = preview
      await image.decode()
      const fileId = `sample-image-${index}` as FileId
      files[fileId] = { id: fileId, mimeType: blob.type, blob, created: now }
      const width = 240, height = width * image.naturalHeight / image.naturalWidth
      elements = convertToExcalidrawElements([{ type: 'image', x: 0, y: 0, width, height, fileId, status: 'saved' }])
    }
    const snapshot = {
      engine: 'excalidraw', version: 1, document: { elements, files },
      view: { scrollX: 180, scrollY: 160, zoom: 1 },
    }
    await workspaceRepository.create({ ...workspace, snapshots: { [workspace.project.headCommitId]: snapshot } })
    if (preview) await workspaceRepository.preview(workspace.project.id, workspace.project.headCommitId, preview)
  }
}

createRoot(document.getElementById('root')!).render(<CanvasApp />)
