import type { CreativeConversationTurn } from '@galta/storage'
import { isTaskRunning } from './protocol'

export const TASK_INTERRUPTED_MESSAGE = 'Chat was interrupted. Your saved changes are safe. Send a message to continue.'

export function hasUnobservedCompletion(turn: CreativeConversationTurn): boolean {
  return turn.completionUnobserved === true || turn.items.some(item => item.type === 'error'
    && item.text === 'The background task host closed before this task finished. Saved changes are preserved.')
}

/** Discovery time is not execution time. Keep the durable settlement timestamp,
 * but explicitly mark an unobserved ending so the UI cannot invent a duration. */
export function recoverInterruptedTurn(turn: CreativeConversationTurn, now: number): CreativeConversationTurn {
  if (!isTaskRunning(turn.status) && !(typeof turn.startedAt === 'number' && !turn.completedAt)) return turn
  return { ...turn, status: 'failed', completedAt: now, completionUnobserved: true,
    items: [...turn.items, { id: `interrupted-${turn.id}`, type: 'error', text: TASK_INTERRUPTED_MESSAGE }] }
}
