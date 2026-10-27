import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { videoData } from '@galta/canvas'
import { documentEquals } from './documentEquality'

type Document = { elements: readonly ExcalidrawElement[] }
type Shown = ReadonlyMap<string, ExcalidrawElement>

/** The objects a saved document shows, by id. A caller that compares many
 * versions passes a cache for that one computation; nothing is retained. */
export type ShownCache = Map<object, Shown>
export function shownObjects(document: Document, cache?: ShownCache): Shown {
  let shown = cache?.get(document)
  if (!shown) {
    shown = new Map(document.elements.filter(element => !element.isDeleted).map(element => [element.id, element]))
    cache?.set(document, shown)
  }
  return shown
}

/** The engine bumps `version` and `versionNonce` on every mutation, so a
 * matching pair is the same object. A differing pair is only a candidate: the
 * engine also bumps them when restoring a document without changing content. */
const stamp = (element: ExcalidrawElement) => `${element.version}:${element.versionNonce}`

/** Objects whose stamp differs between two documents: cheap enough to run on
 * every version of a long history when it opens. */
export function touchedObjects(before: Document | undefined, after: Document, cache?: ShownCache): string[] {
  const a = before ? shownObjects(before, cache) : new Map<string, ExcalidrawElement>(), b = shownObjects(after, cache), touched: string[] = []
  for (const [id, element] of b) { const previous = a.get(id); if (!previous || previous !== element && stamp(previous) !== stamp(element)) touched.push(id) }
  for (const id of a.keys()) if (!b.has(id)) touched.push(id)
  return touched
}

const BOOKKEEPING = new Set(['version', 'versionNonce', 'updated', 'seed', 'lastCommittedPoint'])
const STYLE = new Set(['strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'fontSize', 'fontFamily', 'textAlign', 'verticalAlign', 'roundness', 'startArrowhead', 'endArrowhead', 'lineHeight'])
const SHAPE = new Set(['width', 'height', 'points', 'pressures', 'scale', 'autoResize'])

/** Absent and empty relationships are the same; restoring a document fills them in. */
const normal = (key: string, value: unknown) => value === undefined || key === 'boundElements' && Array.isArray(value) && !value.length ? null : value

/** The content fields that differ, ignoring engine bookkeeping. */
function changedFields(before: ExcalidrawElement, after: ExcalidrawElement): string[] {
  const a = before as unknown as Record<string, unknown>, b = after as unknown as Record<string, unknown>
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => !BOOKKEEPING.has(key) && !documentEquals(normal(key, a[key]), normal(key, b[key])))
}

/** Objects whose content differs between two documents, without engine-only
 * revisions such as the ones a restore makes. */
export function changedObjects(before: Document | undefined, after: Document, cache?: ShownCache): string[] {
  const a = before ? shownObjects(before, cache) : new Map<string, ExcalidrawElement>(), b = shownObjects(after, cache)
  return touchedObjects(before, after, cache).filter(id => { const x = a.get(id), y = b.get(id); return !x || !y || changedFields(x, y).length > 0 })
}

/** Whether two states of an object look and relate the same; its place in
 * the stacking order aside. */
export const sameObject = (a: ExcalidrawElement, b: ExcalidrawElement) => changedFields(a, b).every(field => field === 'index')

export type ObjectKind = 'stroke' | 'text' | 'image' | 'video' | 'page' | 'shape' | 'line' | 'frame' | 'object'
export function objectKind(element: ExcalidrawElement): ObjectKind {
  if (videoData(element)) return 'video'
  switch (element.type) {
    case 'freedraw': return 'stroke'
    case 'text': return 'text'
    case 'image': return 'image'
    case 'rectangle': case 'ellipse': case 'diamond': return 'shape'
    case 'arrow': case 'line': return 'line'
    case 'frame': case 'magicframe': return 'frame'
    case 'embeddable': case 'iframe': return (element.customData as { htmlDocument?: unknown } | undefined)?.htmlDocument ? 'page' : 'object'
    default: return 'object'
  }
}

export type ChangeKind = 'added' | 'deleted' | 'moved' | 'resized' | 'rotated' | 'restyled' | 'retyped' | 'cropped' | 'grouped' | 'arranged' | 'edited'
export type ObjectChange = { id: string; kind: ChangeKind; object: ObjectKind }

/** What changed between two documents, one entry per object, with engine-only
 * revisions removed. Bound text follows its container and an arrow that only
 * followed a moved binding follows its target, as the user sees them. */
export function documentChanges(before: Document | undefined, after: Document, cache?: ShownCache): ObjectChange[] {
  const a = before ? shownObjects(before, cache) : new Map<string, ExcalidrawElement>(), b = shownObjects(after, cache)
  const changes = new Map<string, ObjectChange>()
  for (const id of touchedObjects(before, after, cache)) {
    const previous = a.get(id), next = b.get(id)
    if (!previous) { changes.set(id, { id, kind: 'added', object: objectKind(next!) }); continue }
    if (!next) { changes.set(id, { id, kind: 'deleted', object: objectKind(previous) }); continue }
    const fields = changedFields(previous, next)
    if (!fields.length) continue
    const has = (set: Set<string>) => fields.some(field => set.has(field))
    const kind: ChangeKind = fields.includes('text') || fields.includes('originalText') ? 'retyped'
      : fields.includes('crop') ? 'cropped'
      : has(SHAPE) ? 'resized'
      : fields.includes('angle') ? 'rotated'
      : has(STYLE) ? 'restyled'
      : fields.every(field => field === 'x' || field === 'y') ? 'moved'
      : fields.every(field => field === 'groupIds') ? 'grouped'
      : fields.every(field => field === 'index') ? 'arranged'
      : 'edited'
    changes.set(id, { id, kind, object: objectKind(next) })
  }
  for (const [id, change] of changes) {
    const element = b.get(id) ?? a.get(id)!
    const container = (element as { containerId?: string | null }).containerId
    if (container && changes.has(container) && change.kind !== 'retyped') { changes.delete(id); continue }
    if (change.object === 'line' && (change.kind === 'resized' || change.kind === 'moved' || change.kind === 'edited')) {
      const ends = [(element as { startBinding?: { elementId: string } | null }).startBinding?.elementId, (element as { endBinding?: { elementId: string } | null }).endBinding?.elementId]
      if (ends.some(end => end && end !== id && changes.has(end) && changes.get(end)!.kind !== 'deleted')) changes.delete(id)
    }
  }
  return [...changes.values()]
}

const NOUNS: Record<ObjectKind, [string, string]> = {
  stroke: ['stroke', 'strokes'], text: ['text', 'text boxes'], image: ['image', 'images'], video: ['video', 'videos'], page: ['page', 'pages'],
  shape: ['shape', 'shapes'], line: ['line', 'lines'], frame: ['frame', 'frames'], object: ['object', 'objects']
}
const VERBS: Record<ChangeKind, string> = {
  added: 'Added', deleted: 'Deleted', moved: 'Moved', resized: 'Resized', rotated: 'Rotated', restyled: 'Restyled', retyped: 'Edited',
  cropped: 'Cropped', grouped: 'Regrouped', arranged: 'Rearranged', edited: 'Changed'
}

function phrase(kind: ChangeKind, changes: readonly ObjectChange[]): string {
  const kinds = new Set(changes.map(change => change.object)), object = kinds.size === 1 ? [...kinds][0]! : 'object'
  const count = changes.length, [one, many] = NOUNS[object]
  if (kind === 'added' && object === 'stroke') return count === 1 ? 'Drew a stroke' : `Drew ${count} strokes`
  if (kind === 'added' && object === 'text') return count === 1 ? 'Wrote text' : `Added ${count} text boxes`
  if (kind === 'retyped') return count === 1 ? 'Edited text' : `Edited ${count} text boxes`
  const noun = count === 1 ? (object === 'text' ? 'text' : `${/^[aeiou]/.test(one) ? 'an' : 'a'} ${one}`) : `${count} ${many}`
  return `${VERBS[kind]} ${noun}`
}

/** One plain sentence for a set of changes: the largest kind of change, then
 * the next one, in the user's terms. Computed locally, at no token cost. */
export function summarizeChanges(changes: readonly ObjectChange[]): string {
  if (!changes.length) return 'No visible change'
  const groups = new Map<ChangeKind, ObjectChange[]>()
  for (const change of changes) groups.set(change.kind, [...groups.get(change.kind) ?? [], change])
  const ranked = [...groups].sort((a, b) => b[1].length - a[1].length)
  const parts = ranked.slice(0, 2).map(([kind, items]) => phrase(kind, items))
  return parts.length > 1 ? `${parts[0]}, ${parts[1]!.charAt(0).toLowerCase()}${parts[1]!.slice(1)}` : parts[0]!
}
