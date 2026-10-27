import type { CreativeSession, WorkspaceBundle } from '@galta/storage'
import type { GeneratedNames } from '@galta/runtime'

export function validName(value: string): string {
  const name = value.trim()
  if (!name || [...name].length > 80 || /[\r\n]/.test(name)) throw new Error('Use a name between 1 and 80 characters on one line.')
  return name
}

export function requestLabel(instruction: string): string {
  return [...instruction.replace(/\s+/g, ' ').trim()].slice(0, 48).join('') || 'New conversation'
}

/** Recognize only the placeholders emitted by older Galta versions. Never rewrite a user's name. */
export function prepareSessionName(session: CreativeSession): CreativeSession {
  if (session.labelSource || !['Moodboard', 'New conversation'].includes(session.label) || !session.turns.length) return session
  return { ...session, label: requestLabel(session.turns[0]!.instruction), labelSource: 'request' }
}

export function sessionLabel(workspace: WorkspaceBundle, id: string): string {
  return workspace.agentSessions?.find(session => session.id === id)?.label ?? 'New conversation'
}

export function renameSession(workspace: WorkspaceBundle, id: string, label: string): WorkspaceBundle {
  const name = validName(label)
  if (!workspace.agentSessions?.some(session => session.id === id)) throw new Error('This conversation is unavailable.')
  return { ...workspace, agentSessions: workspace.agentSessions.map(session => {
    if (session.id !== id) return session
    const { publishedName: _, ...current } = session
    return { ...current, label: name, labelSource: 'user' }
  }) }
}

export function applyGeneratedNames(workspace: WorkspaceBundle, sessionId: string, expectedLabel: string, expectedCanvasTitle: string, names: GeneratedNames): WorkspaceBundle {
  const session = workspace.agentSessions?.find(session => session.id === sessionId)
  if (!session || workspace.project.archivedAt) return workspace
  const rename = session.labelSource === 'request' && session.label === expectedLabel
  const canvas = names.canvasTitle && !workspace.project.titleSource && workspace.project.title === expectedCanvasTitle && expectedCanvasTitle === 'Untitled canvas'
  const { publishedTitle: _, ...binding } = workspace.codexProject ?? {}
  return { ...workspace,
    project: canvas ? { ...workspace.project, title: validName(names.canvasTitle!), titleSource: 'generated' } : workspace.project,
    ...(canvas && workspace.codexProject ? { codexProject: { ...binding, cwd: workspace.codexProject.cwd } } : {}),
    agentSessions: workspace.agentSessions!.map(item => {
      if (item.id !== sessionId) return item
      const { publishedName: _, ...current } = item
      return rename ? { ...current, naming: 'complete', label: validName(names.conversationTitle), labelSource: 'generated' } : { ...item, naming: 'complete' }
    })
  }
}

/** Remove the one-shot fork command from records that already have a native
 * thread. This repairs records written by older Galta versions without
 * rewriting Codex history. */
export function normalizeSessionBinding(session: CreativeSession): CreativeSession {
  if (!session.threadId || !session.forkFrom) return session
  const { forkFrom: _, ...bound } = session
  return bound
}

/** Bind the session to the thread returned by app-server. */
export function bindSessionThread(session: CreativeSession, threadId: string): CreativeSession {
  if (session.threadId && session.threadId !== threadId) {
    throw new Error(`Conversation ${session.id} is already bound to Codex thread ${session.threadId}; cannot replace it with ${threadId}`)
  }
  return normalizeSessionBinding({ ...session, threadId })
}

/** Preserve concurrent name edits and consume a pending fork once its native
 * thread exists, including stale snapshots saved by older Galta versions. */
export function mergeSession(existing: CreativeSession | undefined, incoming: CreativeSession): CreativeSession {
  if (existing?.threadId && incoming.threadId && existing.threadId !== incoming.threadId) {
    throw new Error(`Conversation ${incoming.id} is already bound to Codex thread ${existing.threadId}; cannot replace it with ${incoming.threadId}`)
  }
  const turns = new Map(existing?.turns.map(turn => [turn.id, turn]))
  for (const turn of incoming.turns) {
    const saved = turns.get(turn.id)
    // A provider snapshot captured before finalization cannot erase the
    // durable terminal receipt written by the execution/recovery owner.
    if (saved?.completedAt && !turn.completedAt) continue
    turns.set(turn.id, turn)
  }
  const { label: _, labelSource: __, naming: ___, publishedName: ____, publishedProjectId: _____, ...history } = incoming
  return normalizeSessionBinding(prepareSessionName({ ...(existing ? { ...existing, ...history } : incoming), turns: [...turns.values()] }))
}
