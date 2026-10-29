import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { documentEquals } from './documentEquality'

/** Native point tuples dominate large drawings. Copy these known numeric
 * payloads directly; use structured clone for extensible element metadata.
 * Every returned array remains detached, including pressures and point tuples.
 */
export function cloneCanvasElement<T extends ExcalidrawElement>(element: T): T {
  if (!('points' in element)) return structuredClone(element)
  const { points, ...metadata } = element
  const copy = structuredClone(metadata)
  return { ...copy, points: points.map(point => [...point]) } as unknown as T
}

export function cloneCanvasSnapshot<T extends { document: unknown }>(snapshot: T): T {
  const document = snapshot.document as { elements?: readonly ExcalidrawElement[]; files?: unknown } | undefined
  if (!Array.isArray(document?.elements)) return structuredClone(snapshot)
  const { document: _, ...metadata } = snapshot
  const { elements, files, ...fields } = document
  return { ...structuredClone(metadata), document: { ...structuredClone(fields), ...(files ? { files: Object.fromEntries(Object.entries(files as Record<string, object>).map(([id, file]) => [id, { ...file }])) } : {}), elements: elements!.map(cloneCanvasElement) } } as unknown as T
}

/** History keeps one immutable copy of each element version and shares it
 * between every version holding it, so a version costs what changed, not the
 * size of the canvas. Saved copies never reach the editor: restoring clones
 * them. Development builds freeze them so an accidental write fails loudly. */
const saved = new WeakSet<object>()
type SavedCopy = { copy: ExcalidrawElement; version: number; versionNonce: number; updated: number; points?: unknown; pressures?: unknown }
const copies = new WeakMap<object, SavedCopy>()
const sources = new WeakMap<object, object>()
const development = typeof __GALTA_BUILD__ !== 'undefined' && __GALTA_BUILD__.mode === 'development'

function seal<T extends object>(copy: T): T {
  saved.add(copy)
  if (development) {
    for (const field of ['points', 'pressures']) {
      const array = (copy as Record<string, unknown>)[field]
      if (Array.isArray(array)) Object.freeze(array)
    }
    Object.freeze(copy)
  }
  return copy
}

/** The saved copy of an element's current version, made once per version. */
export function saveCanvasElement<T extends ExcalidrawElement>(element: T): T {
  if (saved.has(element)) return element
  const known = copies.get(element), payload = element as unknown as Record<string, unknown>
  if (known && known.version === element.version && known.versionNonce === element.versionNonce && known.updated === element.updated) return known.copy as T
  const copy = cloneCanvasElement(element) as unknown as Record<string, unknown>
  // A changed element often keeps its geometry: share the unchanged arrays.
  if (known && 'points' in element && known.points === payload.points) copy.points = (known.copy as unknown as Record<string, unknown>).points
  if (known && 'pressures' in element && known.pressures === payload.pressures) copy.pressures = (known.copy as unknown as Record<string, unknown>).pressures
  seal(copy)
  copies.set(element, { copy: copy as unknown as ExcalidrawElement, version: element.version, versionNonce: element.versionNonce, updated: element.updated, points: payload.points, pressures: payload.pressures })
  sources.set(copy, element)
  return copy as unknown as T
}

/** A restored element is history's own object: captured as itself, and as the
 * editor's copy of it until the editor changes that copy (when given). */
export function rememberSavedElement(savedCopy: ExcalidrawElement, live?: ExcalidrawElement) {
  seal(savedCopy)
  if (!live) return
  const payload = live as unknown as Record<string, unknown>
  copies.set(live, { copy: savedCopy, version: live.version, versionNonce: live.versionNonce, updated: live.updated, points: payload.points, pressures: payload.pressures })
}

/** A snapshot for history: unchanged elements are the copies already saved. */
export function saveCanvasSnapshot<T extends { document: unknown }>(snapshot: T): T {
  const document = snapshot.document as { elements?: readonly ExcalidrawElement[]; files?: unknown } | undefined
  if (!Array.isArray(document?.elements)) return structuredClone(snapshot)
  const { document: _, ...metadata } = snapshot
  const { elements, files, ...fields } = document
  return { ...structuredClone(metadata), document: { ...structuredClone(fields), ...(files ? { files: Object.fromEntries(Object.entries(files as Record<string, object>).map(([id, file]) => [id, saved.has(file) ? file : { ...file }])) } : {}), elements: elements!.map(saveCanvasElement) } } as unknown as T
}

const shallowEqual = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && Object.is(a[key], b[key]))

/** A new version of `parent`: every element and file equal to the parent's is
 * the parent's own object, so an unchanged canvas compares by identity and
 * storage writes only the difference. Later captures of the same live
 * element reuse that object directly. */
export function saveCanvasVersion<T extends { document: unknown }>(snapshot: T, parent?: unknown): T {
  const version = saveCanvasSnapshot(snapshot) as unknown as { document: { elements: ExcalidrawElement[]; files?: Record<string, Record<string, unknown>> } }
  const before = (parent as { document?: { elements?: unknown; files?: unknown } } | undefined)?.document
  if (!before || !Array.isArray(before.elements)) return version as unknown as T
  const previous = new Map((before.elements as ExcalidrawElement[]).map(element => [element.id, element]))
  let changed = false
  const elements = version.document.elements.map(element => {
    const other = previous.get(element.id)
    if (!other || other === element || other.version !== element.version || other.versionNonce !== element.versionNonce || !documentEquals(other, element)) return element
    changed = true
    seal(other)
    const source = sources.get(element), known = source && copies.get(source)
    if (source && known) copies.set(source, { ...known, copy: other })
    return other
  })
  const files = version.document.files, oldFiles = before.files as Record<string, Record<string, unknown>> | undefined
  const sharedFiles = files && oldFiles ? Object.fromEntries(Object.entries(files).map(([id, file]) => {
    const other = oldFiles[id]
    if (!other || other === file || !shallowEqual(other, file)) return [id, file]
    changed = true
    saved.add(other)
    return [id, other]
  })) : files
  return (changed ? { ...version, document: { ...version.document, ...(sharedFiles ? { files: sharedFiles } : {}), elements } } : version) as unknown as T
}
