import type { Commit } from '@galta/domain'
import type { WorkspaceBundle } from '@galta/storage'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { changedObjects, documentChanges, type ShownCache } from './historyChanges'
import type { CanvasAssets } from '@galta/canvas'

/** A pause this long between two moments starts a new session on the ruler. */
export const SESSION_GAP = 30 * 60 * 1000
/** A pause this long ends a burst of edits, unless the next edit continues on
 * the objects the burst was already changing. */
export const EDIT_PAUSE = 10 * 1000
/** A pause this long always ends a moment. */
export const EDIT_BREAK = 2 * 60 * 1000

export type HistoryVersion = {
  commit: Commit
  /** When the version was made, never earlier than its parent. */
  time: number
  /** The current canvas or one of its ancestors. */
  lineage: boolean
  /** The first version after a pause of at least `SESSION_GAP`. */
  sessionStart: boolean
  name?: string
}

const incomplete = () => new Error('This canvas history is incomplete. Reopen the canvas before continuing.')

/** Every saved version in the order it was made. */
export function historyTimeline(workspace: WorkspaceBundle, current: string = workspace.project.headCommitId): HistoryVersion[] {
  const commits = workspace.project.commits as Readonly<Record<string, Commit>>
  const lineage = new Set<string>()
  for (let id: string | null = current; id !== null; id = commits[id]!.parentId) {
    if (!commits[id] || lineage.has(id)) throw incomplete()
    lineage.add(id)
  }
  // A clock that stepped back between windows must not put a version before
  // its parent; depth orders versions saved in the same millisecond.
  const order = new Map<string, { time: number; depth: number }>()
  const place = (commit: Commit): { time: number; depth: number } => {
    const known = order.get(commit.id)
    if (known) return known
    const chain: Commit[] = [], seen = new Set<string>()
    for (let item: Commit | undefined = commit; item && !order.has(item.id); item = item.parentId === null ? undefined : commits[item.parentId]) {
      if (seen.has(item.id)) throw incomplete()
      seen.add(item.id); chain.push(item)
    }
    for (const item of chain.reverse()) {
      const parent = item.parentId === null ? undefined : order.get(item.parentId)
      if (item.parentId !== null && !parent) throw incomplete()
      order.set(item.id, { time: Math.max(item.createdAt, parent?.time ?? -Infinity), depth: (parent?.depth ?? -1) + 1 })
    }
    return order.get(commit.id)!
  }
  const names = new Map((workspace.namedVersions ?? []).map(item => [item.commitId, item.label]))
  const versions = Object.values(commits).filter(commit => workspace.snapshots[commit.id] !== undefined)
    .map(commit => ({ commit, ...place(commit) }))
    .sort((a, b) => a.time - b.time || a.depth - b.depth || a.commit.id.localeCompare(b.commit.id))
  return versions.map(({ commit, time }, i) => ({
    commit, time, lineage: lineage.has(commit.id),
    sessionStart: i === 0 || time - versions[i - 1]!.time >= SESSION_GAP,
    ...(names.has(commit.id) ? { name: names.get(commit.id)! } : {})
  }))
}

export type MomentSource = 'start' | 'user' | 'agent' | 'import' | 'restore'
export type MomentTurn = { sessionId: string; id: string; instruction: string }

/** What the ruler shows as one tick: a burst of edits, one Galta request or
 * one import. Every saved version belongs to exactly one moment; the moment
 * shows its last one. */
export type Moment = {
  /** The commit whose state the moment shows. */
  id: string
  /** Its versions in order, ending with `id`. */
  commits: readonly string[]
  /** The moment this one continues from. */
  parent: string | null
  children: readonly string[]
  source: MomentSource
  /** A restore started this moment from an earlier one. */
  restored: boolean
  start: number
  end: number
  turn?: MomentTurn
  name?: string
}

export type Moments = {
  byId: ReadonlyMap<string, Moment>
  /** The moment that holds each saved version. */
  of: ReadonlyMap<string, string>
  root: string
  /** The moment that is the current canvas. */
  current: string
}

type Snapshot = { document: { elements: readonly ExcalidrawElement[]; files: CanvasAssets } }
/** A saved document the model can read; an unreadable one is still a moment. */
export function readableDocument(snapshot: unknown): Snapshot['document'] | undefined {
  const document = (snapshot as Partial<Snapshot> | null | undefined)?.document
  return document && Array.isArray(document.elements) && document.files && typeof document.files === 'object' ? document : undefined
}

/** The Galta request a version was made in: the turn that was running in the
 * commit's conversation when it was saved. */
function turnFinder(workspace: WorkspaceBundle) {
  const sessions = new Map((workspace.agentSessions ?? []).map(session => [session.id, [...session.turns].filter(turn => turn.startedAt !== undefined).sort((a, b) => a.startedAt! - b.startedAt!)]))
  return (commit: Commit): MomentTurn | undefined => {
    const checkpoint = workspace.agentCheckpoints?.[commit.id]
    const sessionId = checkpoint?.sessionId ?? commit.runtime?.sessionId
    const turns = sessionId ? sessions.get(sessionId) : undefined
    if (!sessionId || !turns?.length) return undefined
    let turn = checkpoint ? turns.find(item => item.turnId === checkpoint.turnId) : undefined
    if (!turn) for (const item of turns) if (item.startedAt! <= commit.createdAt) turn = item
    return turn ? { sessionId, id: turn.id, instruction: turn.instruction } : undefined
  }
}

/**
 * Group every saved version into moments. A moment continues while the next
 * version is its only continuation and comes from the same hands: your edits
 * until a pause of `EDIT_PAUSE` (longer while you keep working on the same
 * objects, never past `EDIT_BREAK`), one Galta request, one run of imports.
 * A fork, a name or the current canvas always ends a moment, so each of them
 * is exactly one tick. A restore starts a moment that the next work joins.
 */
export function historyMoments(workspace: WorkspaceBundle, versions: readonly HistoryVersion[] = historyTimeline(workspace)): Moments {
  const head = workspace.project.headCommitId
  const kept = new Map<string, HistoryVersion>(versions.map(version => [version.commit.id, version]))
  const commits = workspace.project.commits as Readonly<Record<string, Commit>>
  // A version whose parent has no saved snapshot continues from the nearest one that does.
  const parentOf = (commit: Commit) => {
    let id = commit.parentId
    while (id !== null && !kept.has(id)) id = commits[id]?.parentId ?? null
    return id
  }
  const children = new Map<string, number>()
  for (const version of versions) { const parent = parentOf(version.commit); if (parent) children.set(parent, (children.get(parent) ?? 0) + 1) }
  const turnOf = turnFinder(workspace)
  const document = (id: string) => readableDocument(workspace.snapshots[id])
  const cache: ShownCache = new Map()
  type Draft = { commits: string[]; parent: string | null; source: MomentSource; restored: boolean; readable: boolean; start: number; end: number; touched: Set<string>; turn?: MomentTurn; sessionId?: string }
  const drafts: Draft[] = [], of = new Map<string, Draft>()
  for (const version of versions) {
    const { commit, time } = version, parent = parentOf(commit)
    const restore = parent !== null && workspace.snapshots[commit.id] === workspace.snapshots[parent]
    const before = parent === null ? undefined : document(parent), after = document(commit.id)
    const unreadable = !after || parent !== null && !before
    const touched = parent === null || restore || unreadable ? [] : changedObjects(before, after, cache)
    const turn = commit.source === 'agent' ? turnOf(commit) : undefined
    const open = parent !== null ? of.get(parent) : undefined
    let joins = false
    if (!unreadable && open && open.commits.at(-1) === parent && children.get(parent) === 1 && parent !== head && !kept.get(parent)!.name && open.source !== 'start' && open.readable) {
      const gap = time - open.end
      if (restore) joins = false
      // Neither a return nor an undone change reaches across a session.
      else if (open.source === 'restore') joins = gap < SESSION_GAP
      else if (!touched.length) joins = gap < EDIT_BREAK
      else if (commit.source !== open.source) joins = false
      else if (commit.source === 'agent') joins = turn && open.turn ? turn.id === open.turn.id : !turn && !open.turn && commit.runtime?.sessionId === open.sessionId && gap < EDIT_BREAK
      else if (commit.source === 'import') joins = gap < EDIT_PAUSE
      else joins = gap < EDIT_BREAK && (gap < EDIT_PAUSE || touched.some(id => open.touched.has(id)))
    }
    if (joins) {
      open!.commits.push(commit.id); open!.end = time
      for (const id of touched) open!.touched.add(id)
      if (open!.source === 'restore' && touched.length) { open!.source = commit.source; if (turn) open!.turn = turn; if (commit.runtime?.sessionId) open!.sessionId = commit.runtime.sessionId }
      of.set(commit.id, open!)
      continue
    }
    // A version that changes nothing and cannot join its parent's moment is a
    // return to that moment: a restore, even when storage no longer shares it.
    const returned = restore || parent !== null && !unreadable && !touched.length
    const draft: Draft = { commits: [commit.id], parent, source: parent === null ? 'start' : returned ? 'restore' : commit.source, restored: returned,
      readable: !unreadable, start: time, end: time, touched: new Set(touched), ...(turn ? { turn } : {}), ...(commit.runtime?.sessionId ? { sessionId: commit.runtime.sessionId } : {}) }
    drafts.push(draft); of.set(commit.id, draft)
  }
  const id = (draft: Draft) => draft.commits.at(-1)!
  // A moment that ends where it began shows nothing new: it joins the moment
  // before it, unless it is a fork, a name or the current canvas.
  const continuations = new Map<Draft, number>()
  for (const draft of drafts) if (draft.parent !== null) { const parent = of.get(draft.parent)!; continuations.set(parent, (continuations.get(parent) ?? 0) + 1) }
  for (const draft of [...drafts]) {
    if (draft.parent === null || draft.source === 'restore' || draft.restored || !draft.readable) continue
    const last = id(draft), parent = of.get(draft.parent)!
    if (last === head || kept.get(last)!.name || parent.source === 'start' || !parent.readable || id(parent) !== draft.parent || continuations.get(parent) !== 1 || id(parent) === head || kept.get(id(parent))!.name) continue
    if (draft.start - parent.end >= SESSION_GAP || documentChanges(document(draft.parent), document(last)!, cache).length) continue
    parent.commits.push(...draft.commits); parent.end = draft.end
    for (const commit of draft.commits) of.set(commit, parent)
    continuations.set(parent, continuations.get(draft) ?? 0)
    drafts.splice(drafts.indexOf(draft), 1)
  }
  const parentId = (draft: Draft) => draft.parent === null ? null : id(of.get(draft.parent)!)
  const childIds = new Map<string, string[]>()
  for (const draft of drafts) { const parent = parentId(draft); if (parent) childIds.set(parent, [...childIds.get(parent) ?? [], id(draft)]) }
  const byId = new Map<string, Moment>()
  for (const draft of drafts) {
    const name = kept.get(id(draft))!.name
    byId.set(id(draft), { id: id(draft), commits: draft.commits, parent: parentId(draft), children: childIds.get(id(draft)) ?? [], source: draft.source, restored: draft.restored,
      start: draft.start, end: draft.end, ...(draft.turn ? { turn: draft.turn } : {}), ...(name ? { name } : {}) })
  }
  const roots = drafts.filter(draft => draft.parent === null)
  if (roots.length !== 1 || !of.has(head)) throw incomplete()
  return { byId, of: new Map([...of].map(([commit, draft]) => [commit, id(draft)])), root: id(roots[0]!), current: id(of.get(head)!) }
}
