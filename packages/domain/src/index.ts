import type { ArtifactDeliveryDeclaration, ConversationArtifact } from './artifacts'
export * from './artifacts'

export type WorkspaceId = string & { readonly __workspaceId: unique symbol }
export type ProjectId = string & { readonly __projectId: unique symbol }
export type CommitId = string & { readonly __commitId: unique symbol }
export type BranchId = string & { readonly __branchId: unique symbol }
export type CaptureId = string & { readonly __captureId: unique symbol }
export type AgentRunId = string & { readonly __agentRunId: unique symbol }

/** Where a confirmed canvas change landed, in scene coordinates: created or
 * updated element ids (at most `CANVAS_REGION_IDS`) and the union of all their
 * bounds. The bounds outlive the elements, so a later deletion still has a place. */
export type CanvasChangeRegion = { ids: readonly string[]; bounds: { x: number; y: number; width: number; height: number } }
export const CANVAS_REGION_IDS = 64

export type RuntimeContext = {
  sessionId: string
  sessionLabel: string
  modelId: string
  effort: string
  providerId: string
}

/**
 * One step of an agent run: what the runtime produces, the workspace stores
 * and the canvas renders. Declared once here because all three must agree —
 * an optional field added to a second copy is invisible to the others rather
 * than a compile error.
 */
export type ConversationItem = {
  id: string
  type: string
  /** How the step reads. Prose, and free to be reworded. */
  text: string
  /** Provider-authored message purpose. Absent means unclassified, not final. */
  phase?: 'commentary' | 'final_answer'
  status?: string
  /** Failure diagnostics, preserved for both live and restored tool calls. */
  error?: string
  /** Provider-authored input/output or reasoning summary, bounded by the runtime. */
  details?: string
  /** Command receipts retain process results without interpreting exit codes. */
  exitCode?: number
  output?: string
  cwd?: string
  /** The tool the step invoked, named as the provider named it. A surface with
   * copy per tool keys on this; nothing recovers the tool from `text`. */
  tool?: string
  server?: string
  /** Compact, confirmed document effects from successful Galta receipts. */
  canvasChanges?: { created: number; updated: number; deleted: number; kind?: 'image' | 'video'; region?: CanvasChangeRegion }
  /** Host-validated final-message file links, scoped to this item and turn. */
  artifacts?: readonly ConversationArtifact[]
  /** A successful canvas_deliver declaration, later frozen into `artifacts`. */
  delivery?: ArtifactDeliveryDeclaration
  imagePath?: string
}

export type CanvasNode =
  | { id: string; type: 'image'; x: number; y: number; width: number; height: number; captureId?: CaptureId; blobRef?: string }
  | { id: string; type: 'text'; x: number; y: number; text: string }
  | { id: string; type: 'shape'; x: number; y: number; width: number; height: number; shape: 'rect' | 'ellipse' | 'arrow' }
  | { id: string; type: 'stroke'; points: ReadonlyArray<{ x: number; y: number }>; color: string; width: number }
  | { id: string; type: 'connector'; from: string; to: string }

export type CanvasState = {
  nodes: Readonly<Record<string, CanvasNode>>
}

export type CanvasEvent =
  | { type: 'NodeCreated'; node: CanvasNode }
  | { type: 'NodeMoved'; nodeId: string; x: number; y: number }
  | { type: 'NodeDeleted'; nodeId: string }
  | { type: 'StrokeCreated'; node: Extract<CanvasNode, { type: 'stroke' }> }
  | { type: 'CapturePlaced'; node: Extract<CanvasNode, { type: 'image' }> }

export type Commit = {
  id: CommitId
  projectId: ProjectId
  branchId: BranchId
  parentId: CommitId | null
  createdAt: number
  source: 'user' | 'agent' | 'import'
  events: ReadonlyArray<CanvasEvent>
  snapshotRef?: string
  runtime?: RuntimeContext
}

export type Branch = {
  id: BranchId
  projectId: ProjectId
  parentCommitId: CommitId | null
  headCommitId: CommitId
  createdAt: number
}

export type Project = {
  id: ProjectId
  title: string
  titleSource?: 'generated' | 'user'
  archivedAt?: number
  activeBranchId: BranchId
  headCommitId: CommitId
  branches: Readonly<Record<BranchId, Branch>>
  commits: Readonly<Record<CommitId, Commit>>
  createdAt: number
  updatedAt: number
}

export function asProjectId(value: string): ProjectId {
  if (!value.trim()) throw new Error('Project id cannot be empty')
  return value as ProjectId
}

export function asCommitId(value: string): CommitId {
  if (!value.trim()) throw new Error('Commit id cannot be empty')
  return value as CommitId
}

export function asBranchId(value: string): BranchId {
  if (!value.trim()) throw new Error('Branch id cannot be empty')
  return value as BranchId
}

export function asAgentRunId(value: string): AgentRunId {
  if (!value.trim()) throw new Error('Agent run id cannot be empty')
  return value as AgentRunId
}

export function emptyCanvas(): CanvasState {
  return { nodes: {} }
}

export function applyEvent(state: CanvasState, event: CanvasEvent): CanvasState {
  if (event.type === 'NodeMoved') {
    const node = state.nodes[event.nodeId]
    if (!node || !('x' in node) || !('y' in node)) return state
    return { nodes: { ...state.nodes, [node.id]: { ...node, x: event.x, y: event.y } } }
  }
  if (event.type === 'NodeDeleted') {
    const nodes = { ...state.nodes }
    delete nodes[event.nodeId]
    return { nodes }
  }
  const node = event.type === 'StrokeCreated' || event.type === 'CapturePlaced' ? event.node : event.node
  return { nodes: { ...state.nodes, [node.id]: node } }
}

export function replay(project: Project, commitId: CommitId): CanvasState {
  const chain: Commit[] = []
  let cursor: CommitId | null = commitId
  while (cursor) {
    const currentCommit: Commit | undefined = project.commits[cursor]
    if (!currentCommit) throw new Error(`Unknown commit: ${cursor}`)
    chain.push(currentCommit)
    cursor = currentCommit.parentId
  }
  return chain.reverse().reduce((state, commit) => commit.events.reduce(applyEvent, state), emptyCanvas())
}

export type CommitInput = {
  now: number
  id: CommitId
  branchId?: BranchId
  source: Commit['source']
  events: ReadonlyArray<CanvasEvent>
  snapshotRef?: string
  runtime?: RuntimeContext
}

export function commit(project: Project, input: CommitInput): Project {
  const isHistorical = input.branchId !== undefined && input.branchId !== project.activeBranchId
  const branchId = input.branchId ?? project.activeBranchId
  const branch = project.branches[branchId]
  if (!branch) throw new Error(`Unknown branch: ${branchId}`)
  const parentId = isHistorical ? branch.headCommitId : project.headCommitId
  const nextCommit: Commit = {
    id: input.id,
    projectId: project.id,
    branchId,
    parentId,
    createdAt: input.now,
    source: input.source,
    events: input.events,
    ...(input.snapshotRef ? { snapshotRef: input.snapshotRef } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {})
  }
  const nextBranch: Branch = { ...branch, headCommitId: nextCommit.id }
  return {
    ...project,
    activeBranchId: branchId,
    headCommitId: nextCommit.id,
    updatedAt: input.now,
    branches: { ...project.branches, [branchId]: nextBranch },
    commits: { ...project.commits, [nextCommit.id]: nextCommit }
  }
}

export function forkAndCommit(project: Project, input: CommitInput & { historicalCommitId: CommitId; newBranchId: BranchId }): Project {
  const parent = project.commits[input.historicalCommitId]
  if (!parent) throw new Error(`Unknown historical commit: ${input.historicalCommitId}`)
  const branch: Branch = {
    id: input.newBranchId,
    projectId: project.id,
    parentCommitId: parent.id,
    headCommitId: parent.id,
    createdAt: input.now
  }
  return commit({ ...project, branches: { ...project.branches, [branch.id]: branch }, activeBranchId: branch.id, headCommitId: parent.id }, { ...input, branchId: branch.id })
}

export type CursorCommitInput = CommitInput & {
  cursorCommitId: CommitId
  newBranchId: BranchId
}

/** The single write entry point for canvas edits, including writes from history. */
export function commitAtCursor(project: Project, input: CursorCommitInput): Project {
  const cursor = project.commits[input.cursorCommitId]
  if (!cursor) throw new Error(`Unknown history cursor: ${input.cursorCommitId}`)
  if (input.cursorCommitId === project.headCommitId) {
    return commit(project, { ...input, branchId: project.activeBranchId })
  }
  return forkAndCommit(project, {
    ...input,
    historicalCommitId: input.cursorCommitId,
    newBranchId: input.newBranchId
  })
}

export function createProject(ids: { projectId: ProjectId; branchId: BranchId; commitId: CommitId }, now = Date.now()): Project {
  const root: Commit = { id: ids.commitId, projectId: ids.projectId, branchId: ids.branchId, parentId: null, createdAt: now, source: 'user', events: [] }
  const branch: Branch = { id: ids.branchId, projectId: ids.projectId, parentCommitId: null, headCommitId: root.id, createdAt: now }
  return {
    id: ids.projectId,
    title: 'Untitled canvas',
    activeBranchId: branch.id,
    headCommitId: root.id,
    branches: { [branch.id]: branch },
    commits: { [root.id]: root },
    createdAt: now,
    updatedAt: now
  }
}
