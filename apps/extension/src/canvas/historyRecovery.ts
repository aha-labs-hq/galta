import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { videoData, type CanvasAssets } from '@galta/canvas'
import type { SceneSnapshot } from './sceneSnapshot'
import { sameObject } from './historyChanges'

type CanvasDocument = SceneSnapshot['document']
type Relations = ExcalidrawElement & Partial<Record<'containerId', string | null> & Record<'startBinding' | 'endBinding', { elementId: string } | null>>
type Bound = { id: string; type: 'arrow' | 'text' }

/** Objects a saved version shows that the current canvas no longer does. */
export function missingObjects(version: CanvasDocument, current: CanvasDocument): ExcalidrawElement[] {
  const shown = new Set(current.elements.filter(element => !element.isDeleted).map(element => element.id))
  return version.elements.filter(element => !element.isDeleted && !shown.has(element.id))
}

/** How many of the chosen objects would change the canvas if taken back. */
export function takeBackCount(version: CanvasDocument, current: CanvasDocument, ids: readonly string[]): number {
  return takeBack(version, current, ids).ids.length
}

/**
 * Take objects back from a saved version as they were, keeping who they are.
 * An object the canvas deleted is revived in its old place in the stacking
 * order, one it still shows returns to its old state, one it never had is
 * added. Relationships are then made whole across everything the canvas
 * shows: a label returns into its box and a caption into its group, an arrow
 * reconnects to a target that is still there, and a relation to anything
 * absent is dropped rather than left dangling. Objects not chosen change only
 * to list a relation that now points at them.
 */
export function takeBack(version: CanvasDocument, current: CanvasDocument, ids: readonly string[], now = Date.now()): { elements: ExcalidrawElement[]; files: CanvasAssets; ids: string[] } {
  const chosen = new Set(ids), records = new Map(current.elements.map(element => [element.id, element]))
  const returning = new Map<string, Relations>()
  for (const past of version.elements) {
    if (past.isDeleted || !chosen.has(past.id)) continue
    const record = records.get(past.id)
    if (record && !record.isDeleted && sameObject(record, past)) continue
    returning.set(past.id, { ...past, isDeleted: false, version: Math.max(record?.version ?? 0, past.version) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: now, index: record ? record.index : past.index } as Relations)
  }
  if (!returning.size) return { elements: [...current.elements], files: {}, ids: [] }
  const elements: Relations[] = [...current.elements.map(element => returning.get(element.id) ?? element as Relations), ...[...returning.values()].filter(element => !records.has(element.id))]
  const shown = new Map(elements.filter(element => !element.isDeleted).map(element => [element.id, element]))
  const edits = new Map<string, Relations>()
  const edit = (element: Relations, change: Partial<Relations>) => {
    const next = { ...(edits.get(element.id) ?? element), ...change } as Relations
    if (!returning.has(element.id)) Object.assign(next, { version: element.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: now })
    edits.set(element.id, next)
    return next
  }
  const get = (id: string) => edits.get(id) ?? shown.get(id)
  // Forward references own each relationship. Keep labels already on the
  // canvas before considering returning labels, even if their box returns too.
  const labels = new Map<string, string>(), affected = new Set(returning.keys())
  for (const element of shown.values()) if (!returning.has(element.id) && element.containerId) labels.set(element.containerId, element.id)
  const inside = (element: ExcalidrawElement, frame: ExcalidrawElement) => element.x >= frame.x && element.y >= frame.y && element.x + element.width <= frame.x + frame.width && element.y + element.height <= frame.y + frame.height
  for (const id of returning.keys()) {
    let element = get(id)!
    // Both the old and new targets must agree when a connection changes ends.
    for (const state of [records.get(id) as Relations | undefined, element]) {
      for (const target of [state?.containerId, state?.startBinding?.elementId, state?.endBinding?.elementId]) if (target) affected.add(target)
    }
    // A label rejoins its box only if the box has no other label now.
    if (element.containerId) {
      const box = get(element.containerId), other = labels.get(element.containerId)
      if (!box || other && other !== id) element = edit(element, { containerId: null })
      else labels.set(element.containerId, id)
    }
    // A frame clips its members: one rejoins a frame that stayed only where it still fits inside.
    if (element.frameId) {
      const frame = get(element.frameId)
      if (!frame || !returning.has(frame.id) && !inside(element, frame)) element = edit(element, { frameId: null })
    }
    for (const end of ['startBinding', 'endBinding'] as const) if (element[end] && !get(element[end]!.elementId)) element = edit(element, { [end]: null })
  }
  // Rebuild reciprocal lists once, including connections that stayed on the
  // canvas. Only returned objects and their old/new targets may be changed.
  const incoming = new Map<string, Map<string, Bound>>()
  const list = (target: string | null | undefined, element: Relations, type: Bound['type']) => {
    if (!target || !affected.has(target) || !get(target)) return
    let entries = incoming.get(target)
    if (!entries) incoming.set(target, entries = new Map())
    entries.set(element.id, { id: element.id, type })
  }
  for (const id of shown.keys()) {
    const element = get(id)!
    list(element.containerId, element, 'text')
    list(element.startBinding?.elementId, element, 'arrow')
    list(element.endBinding?.elementId, element, 'arrow')
  }
  for (const id of affected) {
    const element = get(id)
    if (!element) continue
    const entries = incoming.get(id) ?? new Map<string, Bound>(), previous = element.boundElements ?? []
    const bound = previous.filter(item => entries.get(item.id)?.type === item.type)
    for (const item of bound) entries.delete(item.id)
    bound.push(...entries.values())
    if (bound.length !== previous.length || bound.some((item, i) => item.id !== previous[i]?.id || item.type !== previous[i]?.type)) edit(element, { boundElements: bound.length ? bound : null })
  }
  // An object whose rebuilt state is what the canvas already shows did not
  // change: it keeps its record, unbumped, and is not counted.
  const same = new Set([...returning.keys()].filter(id => { const record = records.get(id); return record && !record.isDeleted && sameObject(record, get(id)!) }))
  if (same.size === returning.size) return { elements: [...current.elements], files: {}, ids: [] }
  const result = elements.map(element => same.has(element.id) ? records.get(element.id)! : edits.get(element.id) ?? element) as ExcalidrawElement[]
  const files: CanvasAssets = {}
  for (const element of returning.values()) {
    if (same.has(element.id)) continue
    const video = videoData(element), used = video ? [video.fileId, video.posterId] : element.type === 'image' && element.fileId ? [element.fileId] : []
    for (const fileId of used) if (!current.files[fileId] && version.files[fileId]) files[fileId] = version.files[fileId]!
  }
  return { elements: result, files, ids: [...returning.keys()].filter(id => !same.has(id)) }
}
