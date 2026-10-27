import { test, expect } from 'bun:test'
import { Window } from 'happy-dom'
import { readImageDrop, httpUrl } from '../apps/extension/src/canvas/referenceDrop.ts'
import { createInitialWorkspace, initializeWorkspaceSnapshot, commitWorkspaceSnapshot, stageAgentSnapshot, activateCanvasSnapshot, defaultRuntime } from '../apps/extension/src/canvas/workspace.ts'
import { captureSubmittedContext } from '../apps/extension/src/canvas/context.ts'

const window = new Window({ url: 'https://example.test' })
globalThis.DOMParser = window.DOMParser
const payload = (values) => ({ getData: (type) => values[type] ?? '' })

test('late root initialization cannot replace another window\'s committed snapshot', () => {
  const initial = createInitialWorkspace(), root = initial.project.headCommitId
  const artwork = { document: { elements: [{ id: 'other-window-artwork' }] } }
  const latest = commitWorkspaceSnapshot(initial, root, artwork, 'user')
  const head = latest.project.headCommitId, empty = { document: { elements: [] } }
  const initialized = initializeWorkspaceSnapshot(latest, root, empty)
  expect(initialized.project.headCommitId).toBe(head)
  expect(initialized.snapshots[head]).toEqual(artwork)
  expect(initialized.snapshots[root]).toEqual(empty)
  expect(initializeWorkspaceSnapshot(initialized, root, artwork)).toBe(initialized)
  expect(() => initializeWorkspaceSnapshot(initialized, 'missing-root', empty)).toThrow('unavailable')
})

test('submission freezes selection, image bytes and viewport metadata without rendering pixels', async () => {
  const element = { id: 'selected', type: 'image', fileId: 'file', x: 0, y: 0, width: 10, height: 10 }
  const file = { id: 'file', dataURL: 'data:image/png;base64,AA==' }
  const editor = { selectedIds: ['selected'], selected: [element], elements: [element, { id: 'offscreen' }], visibleElements: [element], assets: { file }, surface: { x: 0, y: 0, width: 100, height: 100, zoom: 1 }, preview() { throw new Error('Must not render') } }
  const submitted = captureSubmittedContext(editor)
  editor.selectedIds.length = 0; element.width = 50; file.dataURL = 'changed'; editor.surface.x = 1000
  expect(submitted.selection).toEqual(['selected'])
  expect(submitted.images[0].element.width).toBe(10)
  expect([...new Uint8Array(await submitted.images[0].file.blob.arrayBuffer())]).toEqual([0])
  expect(submitted.viewport.x).toBe(0)
})

test('native image payload wins over a Pinterest page link and preserves provenance', () => {
  expect(readImageDrop(payload({
    'application/x-galta-reference': JSON.stringify({ url: 'https://i.pinimg.com/reference.jpg', sourceUrl: 'https://www.pinterest.com/pin/123/' }),
    'text/uri-list': 'https://www.pinterest.com/pin/123/'
  }))).toEqual({ url: 'https://i.pinimg.com/reference.jpg', sourceUrl: 'https://www.pinterest.com/pin/123/' })
})

test('standard HTML image drag imports the image rather than its wrapping page URL', () => {
  expect(readImageDrop(payload({
    'text/html': '<a href="https://gallery.test/work"><img src="https://cdn.test/image?size=2&amp;format=webp"></a>',
    'text/uri-list': 'https://gallery.test/work'
  }))).toEqual({ url: 'https://cdn.test/image?size=2&format=webp', sourceUrl: 'https://gallery.test/work' })
})

test('video drops retain their kind even when the source URL has no extension', () => {
  expect(readImageDrop(payload({
    'text/html': '<a href="https://gallery.test/work"><video><source src="https://cdn.test/play?id=1"></video></a>'
  }))).toEqual({ url: 'https://cdn.test/play?id=1', sourceUrl: 'https://gallery.test/work', kind: 'video' })
  expect(readImageDrop(payload({
    'application/x-galta-reference': JSON.stringify({ url: 'https://cdn.test/play?id=1', kind: 'video' })
  }))).toEqual({ url: 'https://cdn.test/play?id=1', sourceUrl: undefined, kind: 'video' })
})

test('URI lists handle comments and CRLF; invalid schemes and empty drops do not import', () => {
  expect(readImageDrop(payload({ 'text/uri-list': '# dragged image\r\n\r\nhttps://cdn.test/pic.png\r\n' }))).toEqual({ url: 'https://cdn.test/pic.png' })
  expect(readImageDrop(payload({ 'text/plain': 'javascript:alert(1)' }))).toBeNull()
  expect(readImageDrop(payload({}))).toBeNull()
  expect(httpUrl('file:///private/image.png')).toBeUndefined()
  expect(httpUrl('https://cdn.test/pic.png')).toBe('https://cdn.test/pic.png')
})

test('staged agent candidates preserve the active canvas and remain reachable until activated', () => {
  let current = createInitialWorkspace()
  const root = current.project.headCommitId
  current = initializeWorkspaceSnapshot(current, root, { document: { elements: [] } })
  const before = { document: { elements: [{ id: 'user-drawing' }] } }, candidate = { document: { elements: [...before.document.elements, { id: 'agent-result' }] } }
  const staged = stageAgentSnapshot(current, root, before, candidate, defaultRuntime)
  expect(staged.workspace.snapshots[staged.workspace.project.headCommitId]).toEqual(before)
  expect(staged.workspace.project.commits[staged.candidateId].parentId).toBe(staged.baseId)
  expect(staged.workspace.project.commits[staged.baseId].source).toBe('user')
  expect(staged.workspace.project.commits[staged.candidateId].runtime).toEqual(defaultRuntime)
  const project = staged.workspace.project
  expect(project.headCommitId).toBe(staged.baseId)
  expect(project.commits[staged.baseId].parentId).toBe(root)
  expect(project.branches[project.activeBranchId].headCommitId).toBe(staged.baseId)
  expect(project.branches[project.commits[staged.candidateId].branchId].headCommitId).toBe(staged.candidateId)
  expect(staged.workspace.snapshots[staged.candidateId]).toEqual(candidate)
  const activated = activateCanvasSnapshot(staged.workspace, staged.candidateId, { scrollX: 10, scrollY: 20, zoom: 1.25 })
  expect(activated.project.headCommitId).toBe(staged.candidateId)
  expect(activated.snapshots).toEqual(staged.workspace.snapshots)
  expect(activated.canvasView).toEqual({ commitId: staged.candidateId, scrollX: 10, scrollY: 20, zoom: 1.25 })
  expect(activated.project.activeBranchId).toBe(project.commits[staged.candidateId].branchId)
  expect(activated.project.branches[project.activeBranchId].headCommitId).toBe(staged.baseId)
})
