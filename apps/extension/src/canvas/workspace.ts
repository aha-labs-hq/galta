import { asBranchId, asCommitId, asProjectId, createProject, commitAtCursor, forkAndCommit, type CommitId, type Project, type RuntimeContext } from '@galta/domain'
import { IndexedDbWorkspaceRepository, type WorkspaceBundle } from '@galta/storage'
import { documentEquals } from './documentEquality'
import { saveCanvasVersion } from './cloneSnapshot'

export const workspaceRepository = new IndexedDbWorkspaceRepository()
export const defaultProjectId = asProjectId('default-project')

export const defaultRuntime: RuntimeContext = {
  sessionId: 'moodboard',
  sessionLabel: 'New conversation',
  modelId: 'gpt-6-astra',
  effort: 'High',
  providerId: 'codex-app-server'
}

export function makeId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
}

export function createInitialWorkspace(projectId = defaultProjectId, now = Date.now()): WorkspaceBundle {
  const branchId = asBranchId(makeId('branch'))
  const commitId = asCommitId(makeId('commit'))
  const project = createProject({ projectId, branchId, commitId }, now)
  return {
    project,
    captures: [],
    snapshots: {},
    runtimeDefaults: { ...defaultRuntime }
  }
}

export function activeCommit(project: Project) {
  return project.commits[project.headCommitId]
}

export function initializeWorkspaceSnapshot(current: WorkspaceBundle, id: string, snapshot: unknown): WorkspaceBundle {
  if (current.snapshots[id]) return current
  if (current.project.commits[asCommitId(id)]?.parentId !== null) throw new Error('The initial canvas version is unavailable.')
  return { ...current, snapshots: { ...current.snapshots, [id]: snapshot } }
}

/** Saving a document version preserves the current session preferences.
 * A run's captured runtime belongs to commit provenance, never preferences. */
export function commitWorkspaceSnapshot(current: WorkspaceBundle, at: CommitId, snapshot: { document: unknown }, source: 'user' | 'agent' | 'import', runtime?: RuntimeContext, preserveCurrent = false): WorkspaceBundle {
  // A version cut from history in another window continues where the cut
  // recorded: its nearest kept ancestor, or the canvas's new start.
  const cursor = current.project.commits[at] ? at : asCommitId(current.trimmedVersions?.[at] ?? at)
  const previous = current.snapshots[cursor] as { document?: unknown } | undefined
  // A version shares every element its parent saved: history grows with what
  // changed, and an unchanged canvas compares by identity.
  const version = saveCanvasVersion(snapshot, previous)
  // Explicitly preserving a historical current canvas must not replace its
  // existing future, even if the document still equals that historical parent.
  if (documentEquals(previous?.document, version.document) && !(preserveCurrent && cursor !== current.project.headCommitId)) return current
  const id = asCommitId(makeId('commit'))
  const project = commitAtCursor(current.project, { id, cursorCommitId: cursor, newBranchId: asBranchId(makeId('branch')), source, now: Date.now(), events: [], snapshotRef: id, ...(runtime ? { runtime } : {}) })
  return { ...current, project, snapshots: { ...current.snapshots, [id]: version } }
}

/** Save the current canvas and an agent candidate in one transaction. The
 * candidate is a reachable alternative, never the version reopened by default. */
export function stageAgentSnapshot(current: WorkspaceBundle, cursor: CommitId, before: { document: unknown }, candidate: { document: unknown }, runtime: RuntimeContext) {
  const base = commitWorkspaceSnapshot(current, cursor, before, 'user', undefined, true)
  const baseId = base.project.headCommitId
  if (documentEquals(before.document, candidate.document)) return { workspace: base, baseId, candidateId: baseId }
  const candidateId = asCommitId(makeId('commit'))
  const staged = forkAndCommit(base.project, { id: candidateId, historicalCommitId: baseId, newBranchId: asBranchId(makeId('branch')), source: 'agent', now: Date.now(), events: [], snapshotRef: candidateId, runtime })
  const project = { ...staged, headCommitId: baseId, activeBranchId: base.project.activeBranchId }
  return { workspace: { ...base, project, snapshots: { ...base.snapshots, [candidateId]: saveCanvasVersion(candidate, base.snapshots[baseId]) } }, baseId, candidateId }
}

export function activateCanvasSnapshot(current: WorkspaceBundle, id: CommitId, view: { scrollX: number; scrollY: number; zoom: number }): WorkspaceBundle {
  const commit = current.project.commits[id]
  if (!commit || !current.snapshots[id]) throw new Error(`Saved canvas version ${id} is unavailable`)
  return { ...current, project: { ...current.project, headCommitId: id, activeBranchId: commit.branchId }, canvasView: { commitId: id, ...view } }
}

/** Make a saved version the current canvas as a new version of its own; the
 * canvas it replaces stays in history with everything after it. */
export function restoreVersion(current: WorkspaceBundle, from: CommitId, expectedHead: CommitId, view: { scrollX: number; scrollY: number; zoom: number }): WorkspaceBundle {
  if (current.project.headCommitId !== expectedHead) throw new Error('Another window changed the canvas. Close Time Machine and load those changes before restoring.')
  const snapshot = current.snapshots[from]
  if (!current.project.commits[from] || !snapshot) throw new Error('This saved canvas is unavailable. Your current work is unchanged.')
  if (from === expectedHead) return current
  const id = asCommitId(makeId('commit'))
  const project = forkAndCommit(current.project, { id, historicalCommitId: from, newBranchId: asBranchId(makeId('branch')), now: Date.now(), source: 'user', events: [], snapshotRef: id })
  return { ...current, project, snapshots: { ...current.snapshots, [id]: snapshot }, canvasView: { commitId: id, ...view } }
}

/** Name a version, rename it, or forget its name with an empty one. A name
 * is metadata: it never creates an artwork version. */
export function nameVersion(current: WorkspaceBundle, commitId: string, label: string): WorkspaceBundle {
  if (!current.project.commits[asCommitId(commitId)] || !current.snapshots[commitId]) throw new Error('This version is unavailable.')
  const name = label.trim(), existing = current.namedVersions ?? []
  if (name.length > 80) throw new Error('Use a name of at most 80 characters.')
  const found = existing.find(item => item.commitId === commitId)
  if (!name) return found ? { ...current, namedVersions: existing.filter(item => item !== found) } : current
  if (found?.label === name) return current
  return { ...current, namedVersions: found ? existing.map(item => item === found ? { ...item, label: name } : item) : [...existing, { commitId, label: name, savedAt: Date.now() }] }
}
