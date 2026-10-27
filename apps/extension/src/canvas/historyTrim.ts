import type { Branch, BranchId, Commit, CommitId } from '@galta/domain'
import type { WorkspaceBundle } from '@galta/storage'

/**
 * Remove saved versions for good. Only the given versions go: what continued
 * from them now continues from the nearest version that stays, and anything
 * left without one continues from the earliest version the current canvas
 * keeps, so history stays one tree and no other universe is cut with them.
 * Their names and conversation checkpoints go with them; the storage write
 * then releases every snapshot and asset no remaining version uses. Each cut
 * version leaves only where its work continues (`trimmedVersions`): its
 * nearest kept ancestor, or the version the canvas now starts from when the
 * start was cut. A window still standing on it saves from there.
 */
export function trimHistory(workspace: WorkspaceBundle, remove: Iterable<string>, now = Date.now()): WorkspaceBundle {
  const project = workspace.project, commits = project.commits as Readonly<Record<string, Commit>>
  // A version another window has already cut is simply gone.
  const removed = new Set([...remove].filter(id => id in commits))
  if (!removed.size) return workspace
  if (removed.has(project.headCommitId)) throw new Error('The current canvas can’t be cut.')
  const survivor = (id: string | null): string | null => {
    const seen = new Set<string>()
    while (id !== null && removed.has(id)) {
      if (seen.has(id)) throw new Error('This canvas history is incomplete. Reopen the canvas before continuing.')
      seen.add(id); id = commits[id]!.parentId
    }
    return id
  }
  // The earliest version the current canvas keeps becomes the start if the
  // original start is cut.
  let start: string = project.headCommitId
  for (let id: string | null = project.headCommitId; id !== null; id = commits[id]!.parentId) if (!removed.has(id)) start = id
  const next: Record<string, Commit> = {}
  for (const [id, commit] of Object.entries(commits)) {
    if (removed.has(id)) continue
    const parentId = id === start ? null : survivor(commit.parentId) ?? start
    next[id] = parentId === commit.parentId ? commit : { ...commit, parentId: parentId as CommitId | null }
  }
  const used = new Set(Object.values(next).map(commit => commit.branchId))
  const branches: Record<string, Branch> = {}
  for (const [id, branch] of Object.entries(project.branches as Readonly<Record<string, Branch>>)) {
    if (!used.has(branch.id) && id !== project.activeBranchId) continue
    const headCommitId = (survivor(branch.headCommitId) ?? start) as CommitId
    const parentCommitId = branch.parentCommitId === null ? null : survivor(branch.parentCommitId) as CommitId | null
    branches[id] = headCommitId === branch.headCommitId && parentCommitId === branch.parentCommitId ? branch : { ...branch, headCommitId, parentCommitId }
  }
  const kept = (id: string) => survivor(id) ?? start
  const trimmed: Record<string, string> = Object.fromEntries(Object.entries(workspace.trimmedVersions ?? {}).map(([id, to]) => [id, removed.has(to) ? kept(to) : to]))
  for (const id of removed) trimmed[id] = kept(id)
  const snapshots = Object.fromEntries(Object.entries(workspace.snapshots).filter(([id]) => !removed.has(id)))
  const checkpoints = workspace.agentCheckpoints && Object.fromEntries(Object.entries(workspace.agentCheckpoints).filter(([id]) => !removed.has(id)))
  const { canvasView, ...rest } = workspace
  return {
    ...rest,
    project: { ...project, commits: next as Record<CommitId, Commit>, branches: branches as Record<BranchId, Branch>, updatedAt: now },
    snapshots,
    trimmedVersions: trimmed,
    ...(workspace.namedVersions ? { namedVersions: workspace.namedVersions.filter(item => !removed.has(item.commitId)) } : {}),
    ...(checkpoints ? { agentCheckpoints: checkpoints } : {}),
    ...(canvasView && !removed.has(canvasView.commitId) ? { canvasView } : {})
  }
}
