import { normalizeAsset } from '@galta/canvas'
import type { WorkspaceBundle } from './index'

export const workspaceStores = ['workspaces', 'canvas-views', 'canvas-catalog', 'canvas-snapshots', 'canvas-assets', 'canvas-previews']
type Path = (string | number)[]
/** A stored version: a complete snapshot, or the change from the version it is
 * based on — its new and changed elements, the IDs it removed, where changed
 * elements now stand when the order moved (or, rarely, the whole order), and
 * whether its files are the base's. Either kind is immutable. */
type SnapshotRecord = {
  value: unknown; assets: { path: Path; id: string }[]
  base?: string; depth?: number; removed?: string[]; placed?: [string, number][]; order?: string[]; sameFiles?: true
}
/** Version 1 listed every asset in the manifest and stored complete snapshots;
 * version 2 lets each record list its own assets, so a change writes only itself. */
export type WorkspaceRecord = Omit<WorkspaceBundle, 'snapshots' | 'canvasView'> & {
  storageVersion: 1 | 2; snapshots: Record<string, string>; assets?: string[]
}
type Remembered = { value: unknown; assets: string[]; base?: string; depth: number }
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value)
const references = new WeakMap<object, string>()
export const snapshotReference = (value: unknown): string | undefined => value !== null && typeof value === 'object' ? references.get(value) : undefined
/** Longest chain of changes before a version is stored complete again. */
const MAX_DEPTH = 64

/** A transaction-local view of immutable records. The repository retains only
 * its last workspace, and always rereads the manifest inside the transaction.
 * IDs are storage addresses, not hashes or a second document revision system.
 */
export class WorkspaceRecords {
  readonly snapshots = new Map<string, Remembered>()
  readonly assets = new Map<string, object>()
  readonly snapshotIds = new WeakMap<object, string>()
  readonly assetIds = new WeakMap<object, string>()
  constructor(readonly projectId: string, readonly previous?: WorkspaceRecord) {}

  rememberSnapshot(id: string, value: unknown, assets: string[], base?: string, depth = 0) {
    this.snapshots.set(id, { value, assets, ...(base ? { base } : {}), depth })
    if (value !== null && typeof value === 'object') { this.snapshotIds.set(value, id); references.set(value, id) }
  }
  rememberAsset(id: string, value: object) { this.assets.set(id, value); this.assetIds.set(value, id) }
}

function encodeSnapshot(value: unknown, intern: (value: object) => string): SnapshotRecord {
  const assets: SnapshotRecord['assets'] = []
  const detach = (value: object, path: Path) => { assets.push({ path, id: intern(value) }); return null }
  if (!object(value) || !object(value.document)) return { value, assets }
  const document = { ...value.document }
  if (object(document.files)) document.files = Object.fromEntries(Object.entries(document.files).map(([id, file]) =>
    [id, object(file) && (file.blob instanceof Blob || typeof file.dataURL === 'string') ? detach(normalizeAsset(file as any), ['document', 'files', id]) : file]))
  if (Array.isArray(document.elements)) document.elements = document.elements.map((element: unknown, i: number) => {
    if (!object(element)) return element
    const next = { ...element }, path: Path = ['document', 'elements', i]
    for (const field of ['points', 'pressures']) if (Array.isArray(element[field])) next[field] = detach(element[field], [...path, field])
    if (element.type === 'embeddable' && object(element.customData?.htmlDocument) && typeof element.customData.htmlDocument.html === 'string') {
      next.customData = { ...element.customData, htmlDocument: detach(element.customData.htmlDocument, [...path, 'customData', 'htmlDocument']) }
    }
    return next
  })
  return { value: { ...value, document }, assets }
}

/** Plain stored data compared by value; anything else only by identity. */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameData(item, b[i]))
  const plain = (value: object) => [Object.prototype, null].includes(Object.getPrototypeOf(value))
  if (Array.isArray(b) || !plain(a) || !plain(b)) return false
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameData(left[key], right[key]))
}

/** Excalidraw's own identity of an element version, confirmed by its content. */
const sameElement = (before: unknown, after: unknown) => before === after ||
  object(before) && object(after) && before.version === after.version && before.versionNonce === after.versionNonce && sameData(before, after)

/** Elements by ID, or undefined when IDs are missing or repeated. A version's
 * array is immutable, so it is indexed once and again as the next one's base. */
const indexes = new WeakMap<unknown[], Map<string, Record<string, any>> | undefined>()
function elementsById(elements: unknown[]) {
  const cached = indexes.get(elements)
  if (cached?.size === elements.length || cached === undefined && indexes.has(elements)) return cached
  let map: Map<string, Record<string, any>> | undefined = new Map()
  for (const element of elements) {
    if (!object(element) || typeof element.id !== 'string' || map.has(element.id)) { map = undefined; break }
    map.set(element.id, element)
  }
  indexes.set(elements, map)
  return map
}

/** The base's elements with removals dropped, changes in place and additions
 * appended in their own order: the order a change implies unless it states one. */
function rebuild(previous: unknown[], changed: Record<string, any>[], removed: Set<string>) {
  const replacing = new Map(changed.map(element => [element.id, element])), elements: unknown[] = []
  for (const element of previous as Record<string, any>[]) {
    if (removed.has(element.id)) continue
    const next = replacing.get(element.id)
    elements.push(next ?? element)
    replacing.delete(element.id)
  }
  for (const element of changed) if (replacing.has(element.id)) elements.push(element)
  return elements
}

/** Changed elements at their stated positions, the others in their base order:
 * a reorder moves only elements whose version changed. */
function place(elements: unknown[], placed: [string, number][]) {
  const ids = new Set(placed.map(([id]) => id)), moving = new Map<string, unknown>(), rest: unknown[] = []
  for (const element of elements as Record<string, any>[]) {
    if (ids.has(element.id)) moving.set(element.id, element)
    else rest.push(element)
  }
  const result: unknown[] = new Array(elements.length)
  for (const [id, index] of placed) {
    if (!moving.has(id) || !Number.isInteger(index) || index < 0 || index >= result.length || result[index] !== undefined) return undefined
    result[index] = moving.get(id)
  }
  let next = 0
  for (let i = 0; i < result.length; i++) if (result[i] === undefined) result[i] = rest[next++]
  return next === rest.length ? result : undefined
}

const sameFiles = (a: unknown, b: unknown) => object(a) && object(b) &&
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key, i) => Object.keys(b)[i] === key && a[key] === b[key])

/** Store a version as the change from its base when that is smaller; the base
 * must be a version this transaction knows. */
function encodeVersion(value: unknown, base: { id: string } & Remembered | undefined, intern: (value: object) => string): SnapshotRecord {
  const complete = () => encodeSnapshot(value, intern)
  if (!base || base.depth >= MAX_DEPTH || !object(value) || !object(value.document) || !object(base.value) || !object(base.value.document)) return complete()
  const elements = value.document.elements, previous = base.value.document.elements
  if (!Array.isArray(elements) || !Array.isArray(previous)) return complete()
  const before = elementsById(previous), after = elementsById(elements)
  if (!before || !after) return complete()
  const changed = (elements as Record<string, any>[]).filter(element => !sameElement(before.get(element.id), element))
  if (changed.length * 2 > elements.length) return complete()
  const removed = (previous as Record<string, any>[]).filter(element => !after.has(element.id)).map(element => element.id)
  const implied = rebuild(previous, changed, new Set(removed)) as Record<string, any>[]
  const matches = (candidate: unknown[] | undefined) => !!candidate && candidate.length === elements.length && candidate.every((element, i) => (element as Record<string, any>).id === (elements[i] as Record<string, any>).id)
  const ordered = matches(implied)
  const moved = new Set(changed.map(element => element.id))
  const placed = ordered ? undefined : (elements as Record<string, any>[]).flatMap((element, i): [string, number][] => moved.has(element.id) ? [[element.id, i]] : [])
  const positioned = !!placed && matches(place(implied, placed))
  const files = Object.hasOwn(value.document, 'files') && Object.hasOwn(base.value.document, 'files') && sameFiles(base.value.document.files, value.document.files)
  const record = encodeSnapshot({ ...value, document: { ...value.document, ...(files ? { files: null } : {}), elements: changed } }, intern)
  return { ...record, base: base.id, depth: base.depth + 1, ...(removed.length ? { removed } : {}), ...(ordered ? {} : positioned ? { placed } : { order: elements.map(element => (element as Record<string, any>).id) }), ...(files ? { sameFiles: true as const } : {}) }
}

/** Rebuild a stored version over its decoded base; unchanged elements and
 * files stay the base's own objects, so versions share them in memory too. */
function decodeVersion(id: string, record: SnapshotRecord, base: Remembered | undefined) {
  const value = record.value
  if (record.base === undefined) return value
  if (!base || !object(value) || !object(value.document) || !Array.isArray(value.document.elements) || !object(base.value) || !object(base.value.document) || !Array.isArray(base.value.document.elements)) {
    throw new Error(`Invalid canvas version: ${id}`)
  }
  let elements = rebuild(base.value.document.elements, value.document.elements, new Set(record.removed ?? []))
  if (record.placed) {
    const placed = place(elements, record.placed)
    if (!placed) throw new Error(`Invalid canvas version order: ${id}`)
    elements = placed
  } else if (record.order) {
    const byId = elementsById(elements)
    if (!byId || byId.size !== record.order.length) throw new Error(`Invalid canvas version order: ${id}`)
    elements = record.order.map(elementId => {
      const element = byId.get(elementId)
      if (!element) throw new Error(`Invalid canvas version order: ${id}`)
      return element
    })
  }
  value.document.elements = elements
  if (record.sameFiles) value.document.files = base.value.document.files
  return value
}

/** Versions in an order that writes each parent before its children. */
function parentsFirst(bundle: WorkspaceBundle) {
  const commits = (bundle.project as { commits?: Record<string, { parentId?: string | null }> }).commits ?? {}
  const ordered: string[] = [], placed = new Set<string>()
  for (const start of Object.keys(bundle.snapshots)) {
    const chain = new Set<string>()
    for (let id: string | null | undefined = start; id && Object.hasOwn(bundle.snapshots, id) && !placed.has(id) && !chain.has(id); id = commits[id]?.parentId) chain.add(id)
    for (const id of [...chain].reverse()) { placed.add(id); ordered.push(id) }
  }
  return ordered
}

/** All requests stay inside the caller's serialized IndexedDB transaction.
 * Unchanged immutable snapshots/assets reuse the last read; changed records
 * arrive as separate small requests, preserving shared payload identity.
 */
export function readWorkspaceRecords(tx: IDBTransaction, projectId: string, cached: WorkspaceRecords | undefined,
  receive: (bundle: WorkspaceBundle | undefined, records: WorkspaceRecords) => void, fail: (error: unknown) => void) {
  const metadata = tx.objectStore('workspaces').get(projectId), camera = tx.objectStore('canvas-views').get(projectId)
  let pending = 2
  const ready = () => {
    if (--pending) return
    try {
      const stored = metadata.result as WorkspaceRecord | undefined
      const records = new WorkspaceRecords(projectId, stored)
      if (!stored) { receive(undefined, records); return }
      if (stored.storageVersion === 1 ? !Array.isArray(stored.assets) : stored.storageVersion !== 2) throw new Error('Invalid workspace storage manifest')
      const previous = cached?.projectId === projectId ? cached : undefined
      const encoded = new Map<string, SnapshotRecord>(), requestedAssets = new Set<string>()
      let failed = false
      const failOnce = (error: unknown) => { if (!failed) { failed = true; fail(error) } }
      const asset = (id: string) => {
        if (records.assets.has(id) || requestedAssets.has(id)) return
        const known = previous?.assets.get(id)
        if (known) { records.rememberAsset(id, known); return }
        requestedAssets.add(id); pending++
        const request = tx.objectStore('canvas-assets').get([projectId, id])
        request.onsuccess = () => {
          if (!request.result || typeof request.result !== 'object') { failOnce(new Error(`Missing canvas asset: ${id}`)); return }
          records.rememberAsset(id, request.result); finish()
        }
      }
      // A version needs its base too, even one no longer in the history.
      const snapshot = (id: string) => {
        if (records.snapshots.has(id) || encoded.has(id)) return
        const known = previous?.snapshots.get(id)
        if (known) {
          // Its payloads keep their IDs, so a write reuses rather than copies them.
          records.rememberSnapshot(id, known.value, known.assets, known.base, known.depth)
          for (const assetId of known.assets) asset(assetId)
          if (known.base) snapshot(known.base)
          return
        }
        encoded.set(id, undefined as unknown as SnapshotRecord); pending++
        const request = tx.objectStore('canvas-snapshots').get([projectId, id])
        request.onsuccess = () => {
          const record = request.result as SnapshotRecord | undefined
          if (!record || !Array.isArray(record.assets)) { failOnce(new Error(`Missing canvas snapshot: ${id}`)); return }
          encoded.set(id, record)
          for (const { id: assetId } of record.assets) asset(assetId)
          if (typeof record.base === 'string') snapshot(record.base)
          finish()
        }
      }
      const decode = (id: string, trail: string[] = []): Remembered => {
        const known = records.snapshots.get(id)
        if (known) return known
        const record = encoded.get(id)
        if (!record || trail.includes(id)) throw new Error(`Missing canvas snapshot: ${id}`)
        const base = typeof record.base === 'string' ? decode(record.base, [...trail, id]) : undefined
        for (const { path, id: assetId } of record.assets) {
          if (!records.assets.has(assetId)) throw new Error(`Unreferenced canvas asset: ${assetId}`)
          let parent: any = record.value
          for (const key of path.slice(0, -1)) parent = parent[key]
          parent[path.at(-1)!] = records.assets.get(assetId)!
        }
        records.rememberSnapshot(id, decodeVersion(id, record, base), record.assets.map(asset => asset.id), record.base, record.depth ?? 0)
        return records.snapshots.get(id)!
      }
      const finish = () => {
        if (--pending || failed) return
        try {
          for (const id of encoded.keys()) decode(id)
          const { storageVersion: _, assets: __, snapshots: refs, ...workspace } = stored
          receive({ ...workspace, snapshots: Object.fromEntries(Object.entries(refs).map(([commit, id]) => [commit, records.snapshots.get(id)!.value])),
            ...(camera.result ? { canvasView: camera.result } : {}) }, records)
        } catch (error) { failOnce(error) }
      }
      pending = 1
      if (stored.storageVersion === 1) for (const id of stored.assets!) asset(id)
      for (const id of new Set(Object.values(stored.snapshots))) snapshot(id)
      finish()
    } catch (error) { fail(error) }
  }
  metadata.onsuccess = ready; camera.onsuccess = ready
}

export function writeWorkspaceRecords(tx: IDBTransaction, bundle: WorkspaceBundle, records: WorkspaceRecords, create = false) {
  const projectId = bundle.project.id, snapshots: Record<string, string> = {}, existing = [...records.snapshots.keys()]
  const intern = (value: object) => {
    let id = records.assetIds.get(value)
    if (!id) {
      id = crypto.randomUUID(); tx.objectStore('canvas-assets').add(value, [projectId, id]); records.rememberAsset(id, value)
    }
    return id
  }
  const commits = (bundle.project as { commits?: Record<string, { parentId?: string | null }> }).commits ?? {}
  for (const commit of parentsFirst(bundle)) {
    const value = bundle.snapshots[commit]
    let id = value !== null && typeof value === 'object' ? records.snapshotIds.get(value) : undefined
    if (!id) {
      id = crypto.randomUUID()
      // A version is stored as its change from its parent's stored version.
      const parentId = commits[commit]?.parentId, parent = parentId ? bundle.snapshots[parentId] : undefined
      const baseId = parent !== null && typeof parent === 'object' ? records.snapshotIds.get(parent) : undefined
      const encoded = encodeVersion(value, baseId ? { id: baseId, ...records.snapshots.get(baseId)! } : undefined, intern)
      tx.objectStore('canvas-snapshots').add(encoded, [projectId, id])
      records.rememberSnapshot(id, value, encoded.assets.map(asset => asset.id), encoded.base, encoded.depth ?? 0)
    }
    snapshots[commit] = id
  }
  const { canvasView: _, snapshots: __, ...workspace } = bundle
  const stored: WorkspaceRecord = { ...workspace, storageVersion: 2, snapshots }
  if (create) tx.objectStore('workspaces').add(stored)
  else tx.objectStore('workspaces').put(stored)
  for (const [commit, ref] of Object.entries(records.previous?.snapshots ?? {})) if (snapshots[commit] !== ref) {
    tx.objectStore('canvas-previews').delete(IDBKeyRange.bound([projectId, commit], [projectId, commit, []]))
  }
  // Keep each kept version's whole chain of bases; collect the rest, and any
  // asset that only removed records used.
  const kept = new Set<string>()
  for (let id of Object.values(snapshots)) for (let ref: string | undefined = id; ref && !kept.has(ref); ref = records.snapshots.get(ref)?.base) kept.add(ref)
  const dropped = existing.filter(id => !kept.has(id))
  for (const id of dropped) tx.objectStore('canvas-snapshots').delete([projectId, id])
  const listed = records.previous?.storageVersion === 1 ? records.previous.assets ?? [] : []
  if (dropped.length || listed.length) {
    const used = new Set<string>()
    for (const id of kept) for (const asset of records.snapshots.get(id)!.assets) used.add(asset)
    for (const asset of new Set([...listed, ...dropped.flatMap(id => records.snapshots.get(id)!.assets)])) {
      if (!used.has(asset)) tx.objectStore('canvas-assets').delete([projectId, asset])
    }
  }
}
