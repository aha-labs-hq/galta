import { asCommitId, type Commit, type ConversationItem } from '@galta/domain'
import { conversationItem } from '@galta/runtime'
import type { CreativeSession, CreativeConversationTurn, WorkspaceBundle } from '@galta/storage'

/** Only terminal-turn checkpoints may seed a Codex fork. Canvas snapshots
 * between tool calls inherit the preceding checkpoint, never a future turn. */
export function checkpointAt(workspace: WorkspaceBundle, cursor: string, sessionId: string) {
  let id: string | null = cursor
  const visited = new Set<string>()
  while (id) {
    if (visited.has(id)) throw new Error('Canvas history contains a cycle')
    visited.add(id)
    const checkpoint = workspace.agentCheckpoints?.[id]
    if (checkpoint?.providerId === 'codex-app-server' && checkpoint.sessionId === sessionId) return checkpoint
    const commit: Commit | undefined = workspace.project.commits[asCommitId(id)]
    if (!commit) throw new Error('Canvas history is missing a version')
    id = commit.parentId
  }
  return undefined
}

export function reconcileCodexSession(session: CreativeSession, thread: any): CreativeSession {
  if (!Array.isArray(thread?.turns)) throw new Error('Codex returned no conversation history')
  const turns: CreativeConversationTurn[] = thread.turns.map((raw: any) => {
    const existing = session.turns.find(turn => turn.turnId === raw.id)
    const userText = raw.items?.find((item: any) => item.type === 'userMessage')?.content?.find((item: any) => item.type === 'text')?.text ?? ''
    const instruction = existing?.instruction ?? restoredUserText(String(userText))
    const remoteItems: ConversationItem[] = (raw.items ?? []).flatMap((item: any) => conversationItem(item, 'completed') ?? [])
    // thread/read reconstructs message IDs and omits some streamed activities.
    // The provider's item sequence is authoritative. Match local items once,
    // then place local-only receipts in the gap before their next matched item;
    // this keeps newly restored items in provider order without discarding a
    // partial receipt that never reached durable history.
    const restoredAnchors = new Map<string, string>()
    const matchedRemote = new Set<number>()
    const localToRemote = new Map<number, number>()
    const restoredByRemote = new Map<number, ConversationItem>()
    const restoredIds = new Set<string>()
    const localOnly: Array<{ index: number; item: ConversationItem }> = []
    const findRemoteIndex = (item: ConversationItem) => {
      const exact = remoteItems.findIndex((remote, index) => !matchedRemote.has(index) && remote.id === item.id)
      if (exact >= 0) return exact
      if (item.type !== 'agentMessage') return -1
      return remoteItems.findIndex((remote, index) => !matchedRemote.has(index) && remote.type === item.type &&
        (!remote.phase || !item.phase || remote.phase === item.phase) &&
        (remote.text === item.text || (item.status === 'inProgress' && item.text.length > 0 && remote.text.startsWith(item.text))))
    }
    for (const [index, item] of (existing?.items ?? []).entries()) {
      // A reconstructed provider ID can appear once under its old live alias
      // and once under the restored ID. The first match owns the item; the
      // duplicate local shell must not survive as a second timeline entry.
      if (restoredIds.has(item.id)) continue
      const remoteIndex = findRemoteIndex(item)
      if (remoteIndex < 0) {
        localOnly.push({ index, item: item.status === 'inProgress' && raw.status !== 'inProgress' ? { ...item, status: 'interrupted' } : item })
        continue
      }
      const restored = remoteItems[remoteIndex]!
      matchedRemote.add(remoteIndex)
      localToRemote.set(index, remoteIndex)
      restoredByRemote.set(remoteIndex, restored)
      restoredIds.add(restored.id)
      restoredAnchors.set(item.id, restored.id)
      if (restored.type === 'agentMessage' && !restored.phase && item.phase) restored.phase = item.phase
      if (!restored.details && item.details) restored.details = item.details
      // thread/read may return a compact receipt after the live stream exposed
      // public fields such as command output or a confirmed canvas effect.
      // Preserve those fields when the provider omits them on reload.
      if (restored.error === undefined && item.error !== undefined) restored.error = item.error
      if (restored.output === undefined && item.output !== undefined) restored.output = item.output
      if (restored.cwd === undefined && item.cwd !== undefined) restored.cwd = item.cwd
      if (restored.exitCode === undefined && item.exitCode !== undefined) restored.exitCode = item.exitCode
      if (restored.tool === undefined && item.tool !== undefined) restored.tool = item.tool
      if (restored.server === undefined && item.server !== undefined) restored.server = item.server
      if (!restored.canvasChanges && item.canvasChanges) restored.canvasChanges = item.canvasChanges
      if (restored.type === 'commandExecution' && restored.text === 'Running a command' && item.text !== 'Running a command') restored.text = item.text
      if (restored.type === 'mcpToolCall' && restored.text === 'Using a tool' && item.text !== 'Using a tool') restored.text = item.text
      // Provider history can omit the host-validated final delivery. Preserve
      // it from the saved turn, never a failed replacement.
      if (restored.status === 'completed' && item.status === 'completed') {
        if (!restored.artifacts && item.artifacts) restored.artifacts = item.artifacts
        if (!restored.delivery && item.delivery) restored.delivery = item.delivery
      }
    }
    const inserts = new Map<number, ConversationItem[]>()
    for (const preserved of localOnly) {
      let nextRemote = -1
      for (let index = preserved.index + 1; index < (existing?.items.length ?? 0); index++) {
        const candidate = localToRemote.get(index)
        if (candidate !== undefined) { nextRemote = candidate; break }
      }
      if (nextRemote < 0) {
        let previousRemote = -1
        for (let index = preserved.index - 1; index >= 0; index--) {
          const candidate = localToRemote.get(index)
          if (candidate !== undefined) { previousRemote = candidate; break }
        }
        nextRemote = previousRemote + 1
      }
      const bucket = inserts.get(nextRemote) ?? []
      bucket.push(preserved.item)
      inserts.set(nextRemote, bucket)
    }
    const items: ConversationItem[] = []
    for (let index = 0; index <= remoteItems.length; index++) {
      for (const item of inserts.get(index) ?? []) items.push(item)
      if (index < remoteItems.length) items.push(restoredByRemote.get(index) ?? remoteItems[index]!)
    }
    if (raw.error?.message && !items.some(item => item.id === raw.id + '-error')) items.push({ id: raw.id + '-error', type: 'error', text: raw.error.message, status: 'failed' })
    const steering = existing?.steering?.map(message => message.afterItemId && restoredAnchors.has(message.afterItemId)
      ? { ...message, afterItemId: restoredAnchors.get(message.afterItemId)! } : message)
    return { ...existing, ...(steering ? { steering } : {}), id: existing?.id ?? raw.id, instruction: instruction || 'Creative task', threadId: thread.id, turnId: raw.id, status: raw.status === 'interrupted' ? 'stopped' : raw.status === 'inProgress' ? existing?.completedAt ? existing.status : 'streaming' : raw.status, items }
  })
  const terminal = [...turns].reverse().find(turn => turn.status !== 'streaming')
  return { ...session, turns, ...(terminal?.turnId ? { lastTurnId: terminal.turnId } : {}) }
}

/** Only the old Galta wrapper is metadata. Ordinary user text must survive
 * restoration, including literal mentions of "User request" or image routes. */
function restoredUserText(text: string): string {
  const legacyRoute = '\n\nImage generation route authorized by the user: invoke ~/Desktop/seed-media.sh --type image through your command tool, without building any service or module.'
  const end = text.indexOf(legacyRoute)
  return text.startsWith('User request: ') && end >= 0
    ? text.slice('User request: '.length, end)
    : text
}
