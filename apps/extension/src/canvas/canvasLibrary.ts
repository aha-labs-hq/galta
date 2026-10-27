import { asProjectId, type RuntimeContext } from '@galta/domain'
import { type WorkspaceBundle } from '@galta/storage'
import { createInitialWorkspace, defaultProjectId, defaultRuntime, makeId, workspaceRepository } from './workspace'
import { validateSnapshot, type SceneSnapshot } from './scene'
import { migrateWorkspace } from './migrateWorkspace'

export const catalogEvent = 'galta-canvas-catalog'
export function announceCatalog() {
  window.dispatchEvent(new Event(catalogEvent))
  const channel = new BroadcastChannel(catalogEvent)
  channel.postMessage({ changed: true }); channel.close()
}

export async function initializeLibrary() {
  const entries = await workspaceRepository.list()
  if (entries.length) return entries
  const initial = createInitialWorkspace(defaultProjectId)
  initial.project = { ...initial.project, title: 'Untitled canvas' }
  await workspaceRepository.update(defaultProjectId, current => current ?? initial)
  return workspaceRepository.list()
}

export async function loadCanvas(id: string): Promise<WorkspaceBundle> {
  const current = await workspaceRepository.load(asProjectId(id))
  if (!current) throw new Error('This canvas could not be found. Choose another canvas from the list.')
  if (current.project.archivedAt) throw new Error('This canvas is archived. Restore it from the canvas list.')
  const migrated = await migrateWorkspace(current)
  validateCanvas(migrated)
  if (migrated !== current) await workspaceRepository.saveMigration(current, migrated)
  return migrated
}

export async function restoreCanvas(id: string): Promise<WorkspaceBundle> {
  // Archived projects have already passed migration when opened. Validate the
  // exact transaction value before changing its lifecycle or catalog entry.
  return workspaceRepository.update(asProjectId(id), current => {
    if (!current) throw new Error('This canvas could not be found.')
    validateCanvas(current)
    const { archivedAt: _, ...project } = current.project
    return { ...current, project }
  }, true)
}

/** Validate navigation and history before accepting a portable project. A root
 * without a snapshot is the one legitimate, not-yet-mounted empty document. */
export function validateCanvas(bundle: WorkspaceBundle): void {
  const p = bundle.project
  const invalid = () => { throw new Error('This canvas has incomplete history. The original is preserved.') }
  if (typeof p?.id !== 'string' || !p.id.trim() || typeof p.title !== 'string' || !p.commits?.[p.headCommitId] || !p.branches?.[p.activeBranchId]
    || !Number.isFinite(p.createdAt) || !Number.isFinite(p.updatedAt) || !Array.isArray(bundle.captures)) invalid()
  if (p.commits[p.headCommitId]?.branchId !== p.activeBranchId) invalid()
  if (p.titleSource !== undefined && !['user', 'generated'].includes(p.titleSource)) invalid()
  if (bundle.codexProject && (typeof bundle.codexProject.cwd !== 'string' || !bundle.codexProject.cwd || ['id', 'publishedTitle'].some(key => {
    const value = bundle.codexProject![key as 'id']
    return value !== undefined && typeof value !== 'string'
  }))) invalid()
  const checked = new Set<string>()
  const geometry = { points: new WeakSet<object>(), pressures: new WeakSet<object>() }
  for (const [key, commit] of Object.entries(p.commits)) {
    if (key !== commit.id || commit.projectId !== p.id || !p.branches[commit.branchId]) invalid()
    const path = new Set<string>()
    let id: string | null = key
    while (id !== null && !checked.has(id)) {
      const current: typeof commit | undefined = p.commits[id as keyof typeof p.commits]
      if (!current || path.has(id)) invalid()
      path.add(id); id = current!.parentId
    }
    for (const id of path) checked.add(id)
    const snapshot = bundle.snapshots[key]
    if (snapshot) validateSnapshot(snapshot, geometry)
    else if (commit.parentId !== null || commit.snapshotRef) invalid()
  }
  for (const [key, branch] of Object.entries(p.branches)) {
    if (key !== branch.id || branch.projectId !== p.id || !p.commits[branch.headCommitId]
      || branch.parentCommitId !== null && !p.commits[branch.parentCommitId]) invalid()
  }
  for (const named of bundle.namedVersions ?? []) if (!p.commits[named.commitId as keyof typeof p.commits] || !bundle.snapshots[named.commitId]) invalid()
  const view = bundle.canvasView
  if (view && (!p.commits[view.commitId as keyof typeof p.commits] || ![view.scrollX, view.scrollY, view.zoom].every(Number.isFinite) || view.zoom <= 0)) throw new Error('This canvas has invalid view settings. The original is preserved.')
  const runtime = bundle.runtimeDefaults
  if (runtime && ['sessionId', 'sessionLabel', 'modelId', 'effort', 'providerId'].some(key => typeof runtime[key as keyof RuntimeContext] !== 'string')) throw new Error('This canvas has invalid conversation settings. The original is preserved.')
  const sessions = bundle.agentSessions
  const conversationError = () => { throw new Error('This canvas has invalid conversation history. The original is preserved.') }
  if (sessions !== undefined && !Array.isArray(sessions)) conversationError()
  const sessionIds = new Set<string>()
  for (const session of sessions ?? []) {
    if (!session || typeof session.id !== 'string' || !session.id || sessionIds.has(session.id) || typeof session.label !== 'string' || !Array.isArray(session.turns)) conversationError()
    if (session.labelSource !== undefined && !['request', 'generated', 'user'].includes(session.labelSource)
      || session.naming !== undefined && !['attempted', 'complete', 'failed'].includes(session.naming)
      || ['publishedName', 'publishedProjectId'].some(key => session[key as 'publishedName'] !== undefined && typeof session[key as 'publishedName'] !== 'string')) conversationError()
    sessionIds.add(session.id)
    for (const turn of session.turns) {
      if (!turn || ['id', 'instruction', 'status'].some(key => typeof turn[key as 'id'] !== 'string') || !Array.isArray(turn.items)) conversationError()
      for (const item of turn.items) if (!item || ['id', 'type', 'text'].some(key => typeof item[key as 'id'] !== 'string')) conversationError()
      const context = turn.context
      if (context && (typeof context.canvasTitle !== 'string'
        || !Array.isArray(context.selection) || !context.selection.every((id: unknown) => typeof id === 'string')
        || context.unavailablePage !== undefined && typeof context.unavailablePage !== 'string'
        || context.page && (typeof context.page.title !== 'string' || typeof context.page.url !== 'string' || !/^https?:\/\//i.test(context.page.url)))) conversationError()
    }
  }
}

export function newCanvas(runtime: RuntimeContext = defaultRuntime): WorkspaceBundle {
  const bundle = createInitialWorkspace(asProjectId(makeId('project')))
  bundle.project = { ...bundle.project, title: 'Untitled canvas' }
  bundle.runtimeDefaults = { ...runtime, sessionId: makeId('session'), sessionLabel: 'New conversation' }
  return bundle
}

/** A new project must never resume a source project's native execution. */
export function detachImportedCanvas(original: WorkspaceBundle): WorkspaceBundle {
  validateCanvas(original)
  const bundle = structuredClone(original)
  const id = asProjectId(makeId('project'))
  const { archivedAt: _, ...project } = bundle.project
  bundle.project = { ...project, id, createdAt: Date.now(), updatedAt: Date.now(),
    commits: Object.fromEntries(Object.entries(project.commits).map(([key, commit]) => [key, { ...commit, projectId: id }])),
    branches: Object.fromEntries(Object.entries(project.branches).map(([key, branch]) => [key, { ...branch, projectId: id }])) }
  delete bundle.revision
  delete bundle.agentCheckpoints
  delete bundle.codexProject
  bundle.agentSessions = (bundle.agentSessions ?? []).map(({ id, label, labelSource, turns, providerId }) => ({ id, label, ...(labelSource ? { labelSource } : {}), ...(providerId ? { providerId } : {}),
    turns: turns.map(({ threadId: _, turnId: __, ...turn }) => ({ ...turn, status: ['preparing', 'streaming'].includes(turn.status) ? 'stopped' : turn.status })) }))
  bundle.runtimeDefaults = { ...(bundle.runtimeDefaults ?? defaultRuntime), sessionId: makeId('session'), sessionLabel: 'New conversation' }
  // Materialized bytes remain portable. Paths into the source native workspace
  // are provenance, not a resource the new project may read or overwrite.
  bundle.snapshots = Object.fromEntries(Object.entries(bundle.snapshots).map(([key, raw]) => {
    const snapshot = validateSnapshot(raw)
    const elements = snapshot.document.elements.map(element => {
      if (!element.customData?.generatedPath) return element
      const { generatedPath: _, ...customData } = element.customData
      return { ...element, customData }
    })
    return [key, { ...snapshot, document: { ...snapshot.document, elements } }]
  }))
  return bundle
}

export function duplicateCanvas(original: WorkspaceBundle): WorkspaceBundle {
  const bundle = newCanvas(original.runtimeDefaults)
  const snapshot = validateSnapshot(original.snapshots[original.project.headCommitId])
  bundle.project = { ...bundle.project, title: original.project.title.slice(0, 73).trimEnd() + ' · Copy' }
  bundle.snapshots = { [bundle.project.headCommitId]: structuredClone(snapshot) }
  bundle.captures = structuredClone(original.captures)
  return detachDuplicatePaths(bundle)
}

function detachDuplicatePaths(bundle: WorkspaceBundle) {
  const id = bundle.project.headCommitId, snapshot = bundle.snapshots[id] as SceneSnapshot
  const elements = snapshot.document.elements.map(element => {
    if (!element.customData?.generatedPath) return element
    const { generatedPath: _, ...customData } = element.customData
    return { ...element, customData }
  })
  return { ...bundle, snapshots: { [id]: { ...snapshot, document: { ...snapshot.document, elements } } } }
}
