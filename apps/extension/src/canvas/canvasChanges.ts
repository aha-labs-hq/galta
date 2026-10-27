import { asCommitId, type Commit } from '@galta/domain'
import type { CanvasChange, CanvasChanges } from '@galta/canvas'
import type { WorkspaceBundle } from '@galta/storage'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { SceneSnapshot } from './sceneSnapshot'
import { documentEquals } from './documentEquality'

function content(element: ExcalidrawElement) {
  // Pointer progress and revision counters are engine bookkeeping. Restoring a
  // native document also normalizes absent bindings to an empty collection.
  const { version: _version, versionNonce: _nonce, updated: _updated, lastCommittedPoint: _point, boundElements, ...value } = element as ExcalidrawElement & { lastCommittedPoint?: unknown }
  return { ...value, boundElements: boundElements ?? [] }
}

/** Compare saved documents, not mouse events or elapsed time. A prior submitted
 * version is the baseline; authorship comes only from intervening commits. */
export function canvasChanges(workspace: WorkspaceBundle, currentId: string, since: string | null): CanvasChanges {
  if (!since) return { since, status: 'initial', elements: [] }
  const path: Commit[] = [], visited = new Set<string>()
  let id: string | null = currentId
  while (id && id !== since) {
    if (visited.has(id)) throw new Error(`Canvas history contains a cycle at ${id}`)
    visited.add(id)
    const commit: Commit | undefined = workspace.project.commits[asCommitId(id)]
    if (!commit) throw new Error(`Canvas history is missing version ${id}`)
    path.push(commit); id = commit.parentId
  }
  if (id !== since) return { since, status: 'unrelated-history', elements: [] }
  const elements = (id: string) => {
    const snapshot = workspace.snapshots[id] as SceneSnapshot | undefined
    if (!snapshot?.document?.elements) throw new Error(`Canvas history is missing document ${id}`)
    return new Map(snapshot.document.elements.filter(element => !element.isDeleted).map(element => [element.id, content(element)]))
  }
  const before = elements(since), after = elements(currentId)
  const changes = new Map<string, CanvasChange>()
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (documentEquals(before.get(id), after.get(id))) continue
    changes.set(id, { id, change: !before.has(id) ? 'created' : !after.has(id) ? 'deleted' : 'updated', sources: [] })
  }
  if (!changes.size) return { since, status: 'compared', elements: [] }
  let previous = before
  for (const commit of path.reverse()) {
    const next = elements(commit.id)
    for (const change of changes.values()) {
      if (!documentEquals(previous.get(change.id), next.get(change.id)) && !change.sources.includes(commit.source)) change.sources.push(commit.source)
    }
    previous = next
  }
  return { since, status: 'compared', elements: [...changes.values()] }
}
