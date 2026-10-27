import { normalizeAsset, portableAsset, type CanvasAssets } from '@galta/canvas'
import type { CaptureRecord } from '@galta/capture'
import type { ConversationItem, Project, ProjectId, RuntimeContext } from '@galta/domain'
import { shareWorkspaceAssets } from './workspaceAssets'
import { WorkspaceRecords, readWorkspaceRecords, writeWorkspaceRecords, workspaceStores } from './workspaceRecords'
export { snapshotReference } from './workspaceRecords'

export interface ProjectRepository {
  load(projectId: ProjectId): Promise<Project | null>
  save(project: Project): Promise<void>
  remove(projectId: ProjectId): Promise<void>
}

export type NamedVersion = { commitId: string; label: string; savedAt: number }

export type WorkspaceBundle = {
  revision?: number
  canvasView?: { commitId: string; scrollX: number; scrollY: number; zoom: number }
  project: Project
  captures: ReadonlyArray<CaptureRecord>
  snapshots: Readonly<Record<string, unknown>>
  /** Names the user gave to versions. Naming never creates an artwork version. */
  namedVersions?: ReadonlyArray<NamedVersion>
  /** Where the work of each version cut from history continues: its nearest
   * kept ancestor, or the version the canvas now starts from when the start
   * was cut. A window still standing on a cut version saves from there. */
  trimmedVersions?: Readonly<Record<string, string>>
  agentSessions?: ReadonlyArray<CreativeSession>
  agentCheckpoints?: Readonly<Record<string, { providerId: 'codex-app-server'; sessionId: string; threadId: string; turnId: string }>>
  runtimeDefaults?: RuntimeContext
  /** Codex is a published projection; canvas/session names remain local authority. */
  codexProject?: { cwd: string; id?: string; publishedTitle?: string }
}

/** A small navigation projection. Artwork and names are owned by the workspace;
 * only visit order and the disposable preview belong to this record. */
export type WorkspaceSummary = {
  id: ProjectId; title: string; createdAt: number; updatedAt: number
  headCommitId: string; archivedAt?: number; lastOpenedAt: number
  preview?: string; previewHead?: string
}

function summary(bundle: WorkspaceBundle, previous?: WorkspaceSummary): WorkspaceSummary {
  const p = bundle.project
  return { id: p.id, title: p.title, createdAt: p.createdAt, updatedAt: p.updatedAt,
    headCommitId: p.headCommitId, ...(p.archivedAt ? { archivedAt: p.archivedAt } : {}),
    lastOpenedAt: previous?.lastOpenedAt ?? p.updatedAt ?? 0,
    ...(previous?.previewHead === p.headCommitId ? { preview: previous.preview, previewHead: previous.previewHead } : {}) }
}

function putWorkspace(tx: IDBTransaction, bundle: WorkspaceBundle, records: WorkspaceRecords, create = false) {
  const { canvasView } = bundle
  writeWorkspaceRecords(tx, bundle, records, create)
  const views = tx.objectStore('canvas-views')
  if (canvasView) views.put(canvasView, bundle.project.id)
  else views.delete(bundle.project.id)
  const catalog = tx.objectStore('canvas-catalog'), request = catalog.get(bundle.project.id)
  request.onsuccess = () => catalog.put(summary(bundle, request.result))
}

export type CreativeConversationTurn = {
  id: string; instruction: string; status: string; threadId?: string; turnId?: string
  startedAt?: number; completedAt?: number
  steering?: Array<{ id: string; text: string; createdAt: number; afterItemId?: string }>
  context?: { canvasTitle: string; selection: readonly string[]; canvas?: { commitId: string; revision: string; preview: 'attached' | 'unchanged' | 'empty' | 'unavailable'; viewport?: { x: number; y: number; width: number; height: number; zoom: number }; previewEvidenceId?: string }; page?: { title: string; url: string }; unavailablePage?: string }
  items: ConversationItem[]
}
// Native checkpoints are capability-specific. MCP clients own their conversations;
// a canvas lease does not manufacture a resumable provider session.
export type CreativeSession = {
  id: string; label: string; labelSource?: 'request' | 'generated' | 'user'
  naming?: 'attempted' | 'complete' | 'failed'
  publishedName?: string; publishedProjectId?: string
  providerId?: 'codex-app-server'; threadId?: string; lastTurnId?: string
  /** Pending native fork, consumed once threadId is assigned. Historical
   * ancestry is owned by Codex, not retained here as another execution request. */
  forkFrom?: { threadId: string; lastTurnId: string }; turns: CreativeConversationTurn[]
}

type LegacyWorkspace = WorkspaceBundle & {
  codexSessions?: CreativeSession[]; codexCheckpoints?: Record<string, { sessionId: string; threadId: string; turnId: string }>
  savedDirections?: NamedVersion[]; historyClips?: unknown; historyTrash?: unknown
}

/** Upgrade legacy exports and persisted records at one boundary, without touching artwork.
 * History is one timeline: saved directions became named versions, and the
 * retired clip ranges and hidden-version marks are dropped, so every version
 * shows again. No commit, snapshot or asset is removed. */
export function normalizeWorkspace(bundle: WorkspaceBundle): WorkspaceBundle {
  const legacy = bundle as LegacyWorkspace
  if (!legacy.codexSessions && !legacy.codexCheckpoints && !legacy.savedDirections && !('historyClips' in legacy) && !('historyTrash' in legacy)) return bundle
  const { codexSessions, codexCheckpoints, savedDirections, historyClips: _clips, historyTrash: _hidden, ...current } = legacy
  if (codexSessions && current.agentSessions || codexCheckpoints && current.agentCheckpoints) throw new Error('Workspace contains conflicting legacy and current agent histories')
  // An older build may have saved a direction beside current names: keep
  // every name, the current one where both name the same version.
  const named = current.namedVersions ?? []
  const namedVersions = savedDirections ? [...named, ...savedDirections.filter(item => !named.some(name => name.commitId === item.commitId))] : undefined
  return {
    ...current,
    ...(namedVersions ? { namedVersions } : {}),
    ...(codexSessions ? { agentSessions: codexSessions.map(session => ({ ...session, providerId: 'codex-app-server' as const })) } : {}),
    ...(codexCheckpoints ? { agentCheckpoints: Object.fromEntries(Object.entries(codexCheckpoints).map(([id, checkpoint]) => [id, { ...checkpoint, providerId: 'codex-app-server' as const }])) } : {})
  }
}

export interface WorkspaceRepository {
  load(projectId: ProjectId): Promise<WorkspaceBundle | null>
  save(bundle: WorkspaceBundle): Promise<void>
  remove(projectId: ProjectId): Promise<void>
}

export class MemoryWorkspaceRepository implements WorkspaceRepository {
  private readonly bundles = new Map<string, WorkspaceBundle>()

  async load(projectId: ProjectId): Promise<WorkspaceBundle | null> {
    return this.bundles.get(projectId) ?? null
  }

  async save(bundle: WorkspaceBundle): Promise<void> {
    this.bundles.set(bundle.project.id, structuredClone(shareWorkspaceAssets(normalizeWorkspace(bundle))))
  }

  async remove(projectId: ProjectId): Promise<void> {
    if (!this.bundles.get(projectId)?.project.archivedAt) throw new Error('Archive this canvas before deleting it.')
    this.bundles.delete(projectId)
  }
}

export class IndexedDbWorkspaceRepository implements WorkspaceRepository {
  private cached: WorkspaceRecords | undefined
  constructor(private readonly dbName = 'galta-v1') {}

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let upgradeFailure: unknown
      const request = indexedDB.open(this.dbName, 6)
      request.onupgradeneeded = event => {
        const db = request.result, tx = request.transaction!
        if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'project.id' })
        if (!db.objectStoreNames.contains('migration-backups')) db.createObjectStore('migration-backups', { keyPath: 'project.id' })
        if (!db.objectStoreNames.contains('canvas-catalog')) db.createObjectStore('canvas-catalog', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('canvas-views')) db.createObjectStore('canvas-views')
        if (event.oldVersion >= 5) {
          // Asset records are already detached. Convert them atomically without
          // touching snapshot IDs, revisions or the user's history.
          const assets = tx.objectStore('canvas-assets').openCursor()
          assets.onsuccess = () => {
            const cursor = assets.result
            if (!cursor) return
            try {
              const file = cursor.value
              if (file && typeof file.dataURL === 'string') cursor.update(normalizeAsset(file))
              cursor.continue()
            } catch (error) { upgradeFailure = error; tx.abort() }
          }
          return
        }
        db.createObjectStore('canvas-snapshots')
        db.createObjectStore('canvas-assets')
        db.createObjectStore('canvas-previews')
        // One atomic upgrade removes the old embedded history representation.
        // Any failed snapshot/asset write rolls the entire upgrade back.
        const cursor = tx.objectStore('workspaces').openCursor()
        cursor.onsuccess = () => {
          if (!cursor.result) return
          const original = cursor.result.value as WorkspaceBundle
          const view = tx.objectStore('canvas-views').get(original.project.id)
          view.onsuccess = () => {
            try {
              const bundle = shareWorkspaceAssets(normalizeWorkspace(view.result ? { ...original, canvasView: view.result } : original))
              putWorkspace(tx, bundle, new WorkspaceRecords(bundle.project.id))
              cursor.result!.continue()
            } catch (error) { upgradeFailure = error; tx.abort() }
          }
        }
      }
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result) }
      request.onblocked = () => reject(new Error('Close other Galta panels, then reopen this canvas to finish upgrading storage.'))
      request.onerror = () => reject(upgradeFailure ?? request.error ?? new Error('Unable to open Galta database'))
    })
  }

  async load(projectId: ProjectId): Promise<WorkspaceBundle | null> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(workspaceStores, 'readonly')
      let result: WorkspaceBundle | null = null, records: WorkspaceRecords, failure: unknown
      readWorkspaceRecords(tx, projectId, this.cached, (stored, read) => { result = stored ? normalizeWorkspace(stored) : null; records = read }, error => { failure = error; tx.abort() })
      tx.oncomplete = () => { this.cached = records; db.close(); resolve(result) }
      tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? tx.error ?? new Error('Unable to load Galta workspace')) }
    })
  }

  async save(bundle: WorkspaceBundle): Promise<void> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(workspaceStores, 'readwrite')
      let records: WorkspaceRecords, failure: unknown
      const fail = (error: unknown) => { failure = error; tx.abort() }
      readWorkspaceRecords(tx, bundle.project.id, this.cached, (current, read) => {
        try {
          records = read
          if (current?.project.archivedAt) throw new Error('This canvas is archived. Restore it before editing.')
          putWorkspace(tx, shareWorkspaceAssets(normalizeWorkspace(bundle)), records)
        } catch (error) { fail(error) }
      }, fail)
      tx.oncomplete = () => { this.cached = records; db.close(); resolve() }
      tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? tx.error ?? new Error('Unable to save Galta workspace')) }
    })
  }

  /** Read and change the workspace in one serialized database transaction.
   * The manifest is authoritative; cached immutable records only save I/O. */
  async update(projectId: ProjectId, change: (current: WorkspaceBundle | null) => WorkspaceBundle, allowArchived = false): Promise<WorkspaceBundle> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(workspaceStores, 'readwrite')
      let result: WorkspaceBundle, records: WorkspaceRecords, failure: unknown
      const fail = (error: unknown) => { failure = error; tx.abort() }
      readWorkspaceRecords(tx, projectId, this.cached, (current, read) => {
        try {
          records = read
          if (current?.project.archivedAt && !allowArchived) throw new Error('This canvas is archived. Restore it before editing.')
          // An unchanged legacy record stays as stored until a real change.
          const base = current ? normalizeWorkspace(current) : null, next = change(base)
          if (next.project.id !== projectId) throw new Error('Workspace update changed the project identity.')
          result = next === base ? next : shareWorkspaceAssets({ ...next, revision: (current?.revision ?? 0) + 1 })
          if (result !== base) putWorkspace(tx, result, records)
        } catch (error) { fail(error) }
      }, fail)
      tx.oncomplete = () => { this.cached = records; db.close(); resolve(result) }
      tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? tx.error ?? new Error('Unable to save Galta workspace')) }
    })
  }

  /** A camera is a preference for a saved head, never a new artwork revision.
   * The catalog and head change atomically with artwork, fencing stale views. */
  async saveView(projectId: ProjectId, view: NonNullable<WorkspaceBundle['canvasView']>): Promise<boolean> {
    if (![view.scrollX, view.scrollY, view.zoom].every(Number.isFinite) || view.zoom <= 0) throw new Error('Invalid canvas view')
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['canvas-catalog', 'canvas-views'], 'readwrite')
      const request = tx.objectStore('canvas-catalog').get(projectId)
      let saved = false, failure: unknown
      request.onsuccess = () => {
        const item = request.result as WorkspaceSummary | undefined
        if (!item) { failure = new Error('This canvas is unavailable.'); tx.abort(); return }
        if (item.archivedAt || item.headCommitId !== view.commitId) return
        tx.objectStore('canvas-views').put(view, projectId); saved = true
      }
      tx.oncomplete = () => { db.close(); resolve(saved) }
      tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? tx.error ?? new Error('Unable to save the canvas view')) }
    })
  }

  /** A single transaction preserves the original and installs the new format. */
  async saveMigration(original: WorkspaceBundle, migrated: WorkspaceBundle): Promise<void> {
    if (original.project.id !== migrated.project.id) throw new Error('Migration changed the project identity.')
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction([...workspaceStores, 'migration-backups'], 'readwrite')
      let records: WorkspaceRecords, failure: unknown
      const fail = (error: unknown) => { failure = error; tx.abort() }
      readWorkspaceRecords(tx, original.project.id, this.cached, (current, read) => {
        try {
          records = read
          if (current && ((current.revision ?? 0) !== (original.revision ?? 0) || current.project.archivedAt)) throw new Error('This canvas changed during migration. Reopen it to load the saved version.')
          const backups = tx.objectStore('migration-backups'), existing = backups.get(original.project.id)
          // The backup is the record exactly as stored, before any upgrade.
          existing.onsuccess = () => { if (!existing.result) backups.add(shareWorkspaceAssets(current ?? original)) }
          putWorkspace(tx, shareWorkspaceAssets(normalizeWorkspace(migrated)), records)
        } catch (error) { fail(error) }
      }, fail)
      tx.oncomplete = () => { this.cached = records; db.close(); resolve() }
      tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? tx.error ?? new Error('Canvas migration could not be saved')) }
    })
  }

  async loadMigrationBackup(projectId: ProjectId): Promise<WorkspaceBundle | null> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const request = db.transaction('migration-backups', 'readonly').objectStore('migration-backups').get(projectId)
      request.onsuccess = () => { db.close(); resolve(request.result ? shareWorkspaceAssets(request.result) : null) }
      request.onerror = () => { db.close(); reject(request.error) }
    })
  }

  async hasMigrationBackup(projectId: ProjectId): Promise<boolean> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const request = db.transaction('migration-backups', 'readonly').objectStore('migration-backups').count(projectId)
      request.onsuccess = () => { db.close(); resolve(request.result > 0) }
      request.onerror = () => { db.close(); reject(request.error) }
    })
  }

  /** Permanently delete an archived canvas: its manifest, catalog entry,
   * camera, every snapshot, asset and preview, and its migration backup, in
   * one transaction. Only an archived canvas can be deleted; the check runs
   * inside the transaction, so a canvas restored meanwhile is kept. */
  async remove(projectId: ProjectId): Promise<void> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([...workspaceStores, 'migration-backups'], 'readwrite')
      let failure: unknown
      const stored = transaction.objectStore('workspaces').get(projectId)
      stored.onsuccess = () => {
        if (!stored.result?.project?.archivedAt) { failure = new Error(stored.result ? 'Archive this canvas before deleting it.' : 'This canvas no longer exists.'); transaction.abort(); return }
        for (const store of ['canvas-snapshots', 'canvas-assets', 'canvas-previews']) transaction.objectStore(store).delete(IDBKeyRange.bound([projectId], [projectId, []]))
        for (const store of ['workspaces', 'canvas-catalog', 'canvas-views', 'migration-backups']) transaction.objectStore(store).delete(projectId)
      }
      transaction.oncomplete = () => { if (this.cached?.projectId === projectId) this.cached = undefined; db.close(); resolve() }
      transaction.onabort = transaction.onerror = () => { db.close(); reject(failure ?? transaction.error ?? new Error('Unable to delete this canvas.')) }
    })
  }

  async list(): Promise<WorkspaceSummary[]> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const request = db.transaction('canvas-catalog').objectStore('canvas-catalog').getAll()
      request.onsuccess = () => { db.close(); resolve(request.result.sort((a: WorkspaceSummary, b: WorkspaceSummary) => b.lastOpenedAt - a.lastOpenedAt || a.id.localeCompare(b.id))) }
      request.onerror = () => { db.close(); reject(request.error) }
    })
  }

  async create(bundle: WorkspaceBundle): Promise<void> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(workspaceStores, 'readwrite')
      let failure: unknown
      const records = new WorkspaceRecords(bundle.project.id)
      try { putWorkspace(tx, shareWorkspaceAssets(normalizeWorkspace(bundle)), records, true) }
      catch (error) { failure = error; tx.abort() }
      tx.oncomplete = () => { this.cached = records; db.close(); resolve() }
      tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? tx.error ?? new Error('Unable to create this canvas.')) }
    })
  }

  async visit(projectId: ProjectId): Promise<void> {
    await this.updateSummary(projectId, item => ({ ...item, lastOpenedAt: Date.now() }))
  }

  async preview(projectId: ProjectId, headCommitId: string, preview: string): Promise<void> {
    await this.updateSummary(projectId, item => item.headCommitId === headCommitId ? { ...item, previewHead: headCommitId, preview } : item)
  }

  /** A preview is disposable derived data, bound to an immutable snapshot
   * address. A late render can never overwrite a replaced/imported snapshot. */
  async readPreview(projectId: string, commitId: string, appearance: string): Promise<{ snapshotRef: string; blob?: Blob; empty?: boolean }> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['workspaces', 'canvas-previews']), metadata = tx.objectStore('workspaces').get(projectId)
      let result: { snapshotRef: string; blob?: Blob; empty?: boolean }, failure: unknown
      metadata.onsuccess = () => {
        const snapshotRef = metadata.result?.snapshots[commitId]
        if (typeof snapshotRef !== 'string') { failure = new Error('This saved canvas is unavailable.'); tx.abort(); return }
        result = { snapshotRef }
        const preview = tx.objectStore('canvas-previews').get([projectId, commitId, appearance])
        preview.onsuccess = () => { if (preview.result?.snapshotRef === snapshotRef) { result.blob = preview.result.blob; result.empty = preview.result.empty } }
      }
      tx.oncomplete = () => { db.close(); resolve(result) }
      tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? tx.error ?? new Error('Unable to read the saved canvas preview')) }
    })
  }

  /** Previews are disposable: keep one version's (the canvas picker shows the
   * current version) and release every other version's, in two range
   * deletes. Nothing else in the canvas is touched. */
  async prunePreviews(projectId: string, keep: string): Promise<void> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('canvas-previews', 'readwrite'), store = tx.objectStore('canvas-previews')
      store.delete(IDBKeyRange.bound([projectId], [projectId, keep], false, true))
      store.delete(IDBKeyRange.bound([projectId, keep, []], [projectId, []], true, false))
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Unable to release canvas previews')) }
    })
  }

  /** The same rule for every canvas at once, from the catalog's current
   * versions, so canvases not opened lately release their old previews too. */
  async pruneAllPreviews(): Promise<void> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['canvas-catalog', 'canvas-previews'], 'readwrite'), store = tx.objectStore('canvas-previews'), catalog = tx.objectStore('canvas-catalog').getAll()
      catalog.onsuccess = () => {
        for (const { id, headCommitId } of catalog.result as WorkspaceSummary[]) {
          store.delete(IDBKeyRange.bound([id], [id, headCommitId], false, true))
          store.delete(IDBKeyRange.bound([id, headCommitId, []], [id, []], true, false))
        }
      }
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Unable to release canvas previews')) }
    })
  }

  async savePreview(projectId: string, commitId: string, appearance: string, snapshotRef: string, blob: Blob, empty = false): Promise<boolean> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['workspaces', 'canvas-previews'], 'readwrite'), metadata = tx.objectStore('workspaces').get(projectId)
      let saved = false
      metadata.onsuccess = () => {
        if (metadata.result?.snapshots[commitId] !== snapshotRef) return
        tx.objectStore('canvas-previews').put({ snapshotRef, blob, empty }, [projectId, commitId, appearance]); saved = true
      }
      tx.oncomplete = () => { db.close(); resolve(saved) }
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Unable to save the canvas preview')) }
    })
  }

  private async updateSummary(projectId: ProjectId, change: (item: WorkspaceSummary) => WorkspaceSummary): Promise<void> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('canvas-catalog', 'readwrite'), store = tx.objectStore('canvas-catalog'), request = store.get(projectId)
      request.onsuccess = () => { if (request.result) store.put(change(request.result)) }
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Unable to update the canvas list.')) }
    })
  }

  async rename(projectId: ProjectId, title: string): Promise<WorkspaceBundle> {
    const name = title.trim()
    if (!name || name.length > 80) throw new Error('Use a name between 1 and 80 characters.')
    return this.update(projectId, current => {
      if (!current) throw new Error('This canvas is unavailable.')
      const { publishedTitle: _, ...binding } = current.codexProject ?? {}
      return { ...current, project: { ...current.project, title: name, titleSource: 'user' },
        ...(current.codexProject ? { codexProject: { ...binding, cwd: current.codexProject.cwd } } : {}) }
    })
  }

  async setArchived(projectId: ProjectId, archived: boolean): Promise<WorkspaceBundle> {
    return this.update(projectId, current => {
      if (!current) throw new Error('This canvas is unavailable.')
      const { archivedAt: _, ...project } = current.project
      return { ...current, project: { ...project, ...(archived ? { archivedAt: Date.now() } : {}) } }
    }, true)
  }
}

export type ExportEnvelope = {
  format: 'galta'
  schemaVersion: 1
  exportedAt: number
  project: Project
}

export function exportProject(project: Project, exportedAt = Date.now()): ExportEnvelope {
  return { format: 'galta', schemaVersion: 1, exportedAt, project }
}

export function importProject(envelope: ExportEnvelope): Project {
  if (envelope.format !== 'galta' || envelope.schemaVersion !== 1) throw new Error('Unsupported Galta export')
  return envelope.project
}

export type WorkspaceExportEnvelope = {
  format: 'galta-workspace'
  schemaVersion: 1 | 2
  exportedAt: number
  workspace: WorkspaceBundle
  assets?: CanvasAssets
}

/** Portable JSON stores each source once, independently of history length.
 * Blobs remain the internal representation; only this boundary encodes bytes. */
export async function exportWorkspace(bundle: WorkspaceBundle, exportedAt = Date.now()): Promise<WorkspaceExportEnvelope> {
  const workspace = structuredClone(shareWorkspaceAssets(normalizeWorkspace(bundle)))
  const references = new Map<object, string>(), assets: CanvasAssets = {}
  for (const value of Object.values(workspace.snapshots)) {
    const snapshot = value as { document?: { files?: Record<string, any> } }
    const files = snapshot?.document?.files
    if (!files) continue
    for (const [id, file] of Object.entries(files)) {
      if (!file || !(file.blob instanceof Blob) && typeof file.dataURL !== 'string') continue
      let ref = references.get(file)
      if (!ref) {
        ref = `asset-${references.size + 1}`; references.set(file, ref)
        assets[ref] = await portableAsset(file)
      }
      files[id] = { assetRef: ref }
    }
  }
  return { format: 'galta-workspace', schemaVersion: 2, exportedAt, workspace, assets }
}

export class WorkspaceImportError extends Error {
  constructor(readonly reason: 'format' | 'version' | 'assets') {
    super(reason === 'assets' ? 'Missing or mismatched exported canvas asset' : 'Unsupported Galta workspace export')
    this.name = 'WorkspaceImportError'
  }
}

export function importWorkspace(envelope: WorkspaceExportEnvelope): WorkspaceBundle {
  if (envelope?.format !== 'galta-workspace') throw new WorkspaceImportError('format')
  if (![1, 2].includes(envelope.schemaVersion)) throw new WorkspaceImportError('version')
  if (envelope.schemaVersion === 1) return normalizeWorkspace(envelope.workspace)
  const workspace = structuredClone(envelope.workspace), assets = envelope.assets
  if (!assets || typeof assets !== 'object') throw new WorkspaceImportError('assets')
  const decoded = new Map<string, ReturnType<typeof normalizeAsset>>()
  for (const value of Object.values(workspace.snapshots)) {
    const snapshot = value as { document?: { files?: Record<string, any> } }
    for (const [id, reference] of Object.entries(snapshot?.document?.files ?? {})) {
      // A shared snapshot may already have been decoded for another commit.
      if (reference?.blob instanceof Blob) continue
      const ref = reference?.assetRef
      if (typeof ref !== 'string' || !Object.hasOwn(assets, ref) || assets[ref]?.id !== id) throw new WorkspaceImportError('assets')
      let file = decoded.get(ref)
      if (!file) { file = normalizeAsset(assets[ref]!); decoded.set(ref, file) }
      snapshot.document!.files![id] = file
    }
  }
  return normalizeWorkspace(workspace)
}
