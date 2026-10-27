import { normalizeAsset } from '@galta/canvas'
import type { WorkspaceBundle } from './index'

export const workspaceStores = ['workspaces', 'canvas-views', 'canvas-catalog', 'canvas-snapshots', 'canvas-assets', 'canvas-previews']
type Path = (string | number)[]
type SnapshotRecord = { value: unknown; assets: { path: Path; id: string }[] }
export type WorkspaceRecord = Omit<WorkspaceBundle, 'snapshots' | 'canvasView'> & {
  storageVersion: 1; snapshots: Record<string, string>; assets: string[]
}
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value)
const references = new WeakMap<object, string>()
export const snapshotReference = (value: unknown): string | undefined => value !== null && typeof value === 'object' ? references.get(value) : undefined

/** A transaction-local view of immutable records. The repository retains only
 * its last workspace, and always rereads the manifest inside the transaction.
 * IDs are storage addresses, not hashes or a second document revision system.
 */
export class WorkspaceRecords {
  readonly snapshots = new Map<string, { value: unknown; assets: string[] }>()
  readonly assets = new Map<string, object>()
  readonly snapshotIds = new WeakMap<object, string>()
  readonly assetIds = new WeakMap<object, string>()
  constructor(readonly projectId: string, readonly previous?: WorkspaceRecord) {}

  rememberSnapshot(id: string, value: unknown, assets: string[]) {
    this.snapshots.set(id, { value, assets })
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
      if (stored.storageVersion !== 1 || !Array.isArray(stored.assets)) throw new Error('Invalid workspace storage manifest')
      const previous = cached?.projectId === projectId ? cached : undefined
      const encoded = new Map<string, SnapshotRecord>()
      const finish = () => {
        if (--pending) return
        try {
          for (const [id, snapshot] of encoded) {
            for (const { path, id: assetId } of snapshot.assets) {
              if (!records.assets.has(assetId)) throw new Error(`Unreferenced canvas asset: ${assetId}`)
              let parent: any = snapshot.value
              for (const key of path.slice(0, -1)) parent = parent[key]
              parent[path.at(-1)!] = records.assets.get(assetId)!
            }
            records.rememberSnapshot(id, snapshot.value, snapshot.assets.map(asset => asset.id))
          }
          const { storageVersion: _, assets: __, snapshots: refs, ...workspace } = stored
          receive({ ...workspace, snapshots: Object.fromEntries(Object.entries(refs).map(([commit, id]) => [commit, records.snapshots.get(id)!.value])),
            ...(camera.result ? { canvasView: camera.result } : {}) }, records)
        } catch (error) { fail(error) }
      }
      pending = 1
      for (const id of stored.assets) {
        const value = previous?.assets.get(id)
        if (value) records.rememberAsset(id, value)
        else {
          pending++
          const request = tx.objectStore('canvas-assets').get([projectId, id])
          request.onsuccess = () => {
            if (!request.result || typeof request.result !== 'object') { fail(new Error(`Missing canvas asset: ${id}`)); return }
            records.rememberAsset(id, request.result); finish()
          }
        }
      }
      for (const id of new Set(Object.values(stored.snapshots))) {
        const snapshot = previous?.snapshots.get(id)
        if (snapshot) records.rememberSnapshot(id, snapshot.value, snapshot.assets)
        else {
          pending++
          const request = tx.objectStore('canvas-snapshots').get([projectId, id])
          request.onsuccess = () => {
            if (!request.result || !Array.isArray(request.result.assets)) { fail(new Error(`Missing canvas snapshot: ${id}`)); return }
            encoded.set(id, request.result); finish()
          }
        }
      }
      finish()
    } catch (error) { fail(error) }
  }
  metadata.onsuccess = ready; camera.onsuccess = ready
}

export function writeWorkspaceRecords(tx: IDBTransaction, bundle: WorkspaceBundle, records: WorkspaceRecords, create = false) {
  const projectId = bundle.project.id, assets = new Set<string>(), snapshots: Record<string, string> = {}
  const intern = (value: object) => {
    let id = records.assetIds.get(value)
    if (!id) {
      id = crypto.randomUUID(); tx.objectStore('canvas-assets').add(value, [projectId, id]); records.rememberAsset(id, value)
    }
    return id
  }
  for (const [commit, value] of Object.entries(bundle.snapshots)) {
    let id = value !== null && typeof value === 'object' ? records.snapshotIds.get(value) : undefined
    if (!id) {
      id = crypto.randomUUID()
      const encoded = encodeSnapshot(value, intern)
      tx.objectStore('canvas-snapshots').add(encoded, [projectId, id]); records.rememberSnapshot(id, value, encoded.assets.map(asset => asset.id))
    }
    snapshots[commit] = id
    for (const asset of records.snapshots.get(id)!.assets) assets.add(asset)
  }
  const { canvasView: _, snapshots: __, ...workspace } = bundle
  const stored: WorkspaceRecord = { ...workspace, storageVersion: 1, snapshots, assets: [...assets] }
  if (create) tx.objectStore('workspaces').add(stored)
  else tx.objectStore('workspaces').put(stored)
  const referenced = new Set(Object.values(snapshots))
  for (const [commit, ref] of Object.entries(records.previous?.snapshots ?? {})) if (snapshots[commit] !== ref) {
    tx.objectStore('canvas-previews').delete(IDBKeyRange.bound([projectId, commit], [projectId, commit, []]))
  }
  for (const id of Object.values(records.previous?.snapshots ?? {})) if (!referenced.has(id)) tx.objectStore('canvas-snapshots').delete([projectId, id])
  for (const id of records.previous?.assets ?? []) if (!assets.has(id)) tx.objectStore('canvas-assets').delete([projectId, id])
}
