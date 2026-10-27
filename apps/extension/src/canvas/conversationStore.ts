import type { ConversationItem } from '@galta/domain'
import type { CreativeConversationTurn } from '@galta/storage'

function sameFields(a: object, b: object) {
  const keys = Object.keys(a) as Array<keyof typeof a>
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key])
}
type CanvasChanges = NonNullable<CreativeConversationTurn['items'][number]['canvasChanges']>
function sameCanvasChanges(a: CanvasChanges, b: CanvasChanges) {
  const { region: ra, ...countsA } = a, { region: rb, ...countsB } = b
  return sameFields(countsA, countsB) && (ra === rb || Boolean(ra && rb && sameFields(ra.bounds, rb.bounds)
    && ra.ids.length === rb.ids.length && ra.ids.every((id, i) => id === rb.ids[i])))
}
function sameArtifact(a: NonNullable<CreativeConversationTurn['items'][number]['artifacts']>[number], b: NonNullable<CreativeConversationTurn['items'][number]['artifacts']>[number]) {
  if (a.status !== b.status || a.href !== b.href) return false
  if (a.status === 'failed' && b.status === 'failed') return a.error === b.error
  if (a.status !== 'ready' || b.status !== 'ready') return false
  return sameFields(a.receipt, b.receipt)
}
function sameSteering(a: CreativeConversationTurn['steering'], b: CreativeConversationTurn['steering']) {
  return a === b || Boolean(a && b && a.length === b.length && a.every((message, index) => sameFields(message, b[index]!)))
}
function sameContext(a: CreativeConversationTurn['context'], b: CreativeConversationTurn['context']) {
  return a === b || Boolean(a && b && a.canvasTitle === b.canvasTitle && a.unavailablePage === b.unavailablePage &&
    a.page?.title === b.page?.title && a.page?.url === b.page?.url &&
    a.canvas?.commitId === b.canvas?.commitId && a.canvas?.revision === b.canvas?.revision && a.canvas?.preview === b.canvas?.preview &&
    a.selection.length === b.selection.length && a.selection.every((id, i) => id === b.selection[i]))
}

/** Cross-window snapshots lose JS identity. Reconcile once at admission, not
 * in every component's memo comparator, retaining unchanged item boundaries. */
export function shareConversationTurn(previous: CreativeConversationTurn | null | undefined, incoming: CreativeConversationTurn): CreativeConversationTurn {
  if (!previous || previous.id !== incoming.id || previous === incoming) return incoming
  const byId = new Map(previous.items.map(item => [item.id, item]))
  const items = incoming.items.map(item => {
    const old = byId.get(item.id)
    let shared = old?.canvasChanges && item.canvasChanges && sameCanvasChanges(old.canvasChanges, item.canvasChanges)
      ? { ...item, canvasChanges: old.canvasChanges } : item
    const previousArtifacts = old?.artifacts, incomingArtifacts = item.artifacts
    if (previousArtifacts && incomingArtifacts && previousArtifacts.length === incomingArtifacts.length && previousArtifacts.every((artifact, i) => sameArtifact(artifact, incomingArtifacts[i]!))) {
      shared = { ...shared, artifacts: previousArtifacts }
    }
    return old && sameFields(old, shared) ? old : shared
  })
  const context = sameContext(previous.context, incoming.context) ? previous.context : incoming.context
  const steering = sameSteering(previous.steering, incoming.steering) ? previous.steering : incoming.steering
  const next: CreativeConversationTurn = { ...incoming, ...(context ? { context } : {}), ...(steering ? { steering } : {}),
    items: items.length === previous.items.length && items.every((item, i) => item === previous.items[i]) ? previous.items : items }
  return sameFields(previous, next) ? previous : next
}

export function shareConversationHistory(previous: readonly CreativeConversationTurn[], incoming: readonly CreativeConversationTurn[]) {
  if (previous === incoming) return previous
  const byId = new Map(previous.map(turn => [turn.id, turn]))
  const next = incoming.map(turn => shareConversationTurn(byId.get(turn.id), turn))
  return next.length === previous.length && next.every((turn, i) => turn === previous[i]) ? previous : next
}

/** View projection only. Task execution and persistence remain authoritative.
 * The workspace observes submitted context; the transcript observes text. */
export class ConversationStore {
  private turn: CreativeConversationTurn | null = null
  private listeners = new Set<() => void>()
  getSnapshot = () => this.turn
  getContext = () => this.turn?.context
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  set = (turn: CreativeConversationTurn | null) => {
    const next = turn ? shareConversationTurn(this.turn, turn) : null
    if (next === this.turn) return
    this.turn = next
    this.listeners.forEach(listener => listener())
  }
}

type SteeringMessage = NonNullable<CreativeConversationTurn['steering']>[number]

export type ConversationTimelineEntry =
  | { kind: 'user'; message: SteeringMessage }
  | { kind: 'process'; id: string; items: ConversationItem[] }
  | { kind: 'reply'; item: ConversationItem }
  | { kind: 'error'; item: ConversationItem }
  /** Codex condensed the conversation so far to keep working within the
   * model's context: a boundary in what the agent remembers, not a step of its
   * work, so it divides the process around it instead of joining it. */
  | { kind: 'boundary'; item: ConversationItem }

/** Pick the latest provider item that is still in progress. A retry or tool
 * receipt can arrive after a final answer has started, so the live cursor must
 * follow provider order rather than privileging one item type. A completed
 * receipt after a retry does not steal the cursor because the retry remains the
 * latest in-progress item.
 */
export function currentConversationItem(items: readonly ConversationItem[], running: boolean) {
  if (!running) return undefined
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    if (item.status === 'inProgress') return item
  }
  return undefined
}

type DialogueEntry = { kind: 'user'; message: SteeringMessage } | { kind: 'agent'; item: ConversationItem }

export function presentConversation(turn: CreativeConversationTurn) {
  const process: ConversationItem[] = [], replies: ConversationItem[] = [], attention: ConversationItem[] = []
  const timeline: ConversationTimelineEntry[] = []
  const dialogue: DialogueEntry[] = []
  const ids = new Set(turn.items.map(item => item.id))
  const anchored = new Map<string, SteeringMessage[]>()
  const unanchored: SteeringMessage[] = []
  for (const message of turn.steering ?? []) {
    // Older receipts have no reliable placement. Keep them beside the original
    // request instead of inventing a timestamp/order for provider messages.
    if (!message.afterItemId || !ids.has(message.afterItemId)) { dialogue.push({ kind: 'user', message }); unanchored.push(message) }
    else {
      const messages = anchored.get(message.afterItemId) ?? []
      messages.push(message); anchored.set(message.afterItemId, messages)
    }
  }

  let segment: ConversationItem[] = []
  const flush = () => {
    if (!segment.length) return
    timeline.push({ kind: 'process', id: `process:${segment[0]!.id}`, items: segment })
    segment = []
  }
  const addUser = (message: SteeringMessage) => {
    flush()
    timeline.push({ kind: 'user', message })
  }
  for (const message of unanchored) addUser(message)

  for (const item of turn.items) {
    if (item.type === 'contextCompaction') {
      flush()
      timeline.push({ kind: 'boundary', item })
    } else if (item.type === 'error') {
      attention.push(item)
      flush()
      timeline.push({ kind: 'error', item })
    } else if (item.type === 'agentMessage') {
      // Only an explicitly classified final answer is a top-level reply. All
      // other agent prose remains an item in the process segment at its exact
      // provider position. The parent process disclosure may hide it, but the
      // prose itself never gets a second disclosure control.
      if (item.phase === 'final_answer') {
        if (item.text) replies.push(item)
        flush()
        if (item.text) timeline.push({ kind: 'reply', item })
        if (item.text) dialogue.push({ kind: 'agent', item })
      } else {
        process.push(item)
        segment.push(item)
        if (item.text) dialogue.push({ kind: 'agent', item })
      }
    } else {
      // An unsuccessful tool attempt is execution history, not a failed
      // request. Keep its actual status and diagnostics in the same segment.
      process.push(item)
      segment.push(item)
    }
    for (const message of anchored.get(item.id) ?? []) {
      dialogue.push({ kind: 'user', message })
      addUser(message)
    }
  }
  flush()
  return { process, replies, attention, dialogue, timeline }
}

export interface DraftCommand {
  getSnapshot(): string
  subscribe(listener: () => void): () => void
  set(value: string): void
}
