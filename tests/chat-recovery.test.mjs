import { test, expect } from 'bun:test'
import { recoverInterruptedTurn, TASK_INTERRUPTED_MESSAGE, hasUnobservedCompletion } from '../apps/extension/src/tasks/recovery'
import { conversationError } from '../apps/extension/src/canvas/ConversationError'

test('recovering an unobserved ending preserves receipts without claiming the offline interval as work', () => {
  const turn = { id: 'turn', status: 'streaming', startedAt: 1000, items: [{ id: 'tool', type: 'mcpToolCall', status: 'completed', text: 'Saved' }] }
  const recovered = recoverInterruptedTurn(turn, 70_000_000)
  expect(recovered).toMatchObject({ status: 'failed', completionUnobserved: true, completedAt: 70_000_000 })
  expect(recovered.items[0]).toBe(turn.items[0])
  expect(recovered.items[1].text).toBe(TASK_INTERRUPTED_MESSAGE)
  expect(turn.items).toHaveLength(1)
  expect(recoverInterruptedTurn(recovered, 90_000_000)).toBe(recovered)
  const completed = { ...turn, status: 'completed', completedAt: 2000 }
  expect(recoverInterruptedTurn(completed, 90_000_000)).toBe(completed)
  // A provider completion before durable finalization still needs recovery.
  expect(recoverInterruptedTurn({ ...turn, status: 'completed' }, 5000).completionUnobserved).toBe(true)
})

test('missing old context and competing writers offer an explicit new conversation while preserving diagnostics', () => {
  for (const [message, action] of [['no rollout found for thread id old-id', 'new-conversation'], ['thread old-id already has an active writer', 'retry-or-new-conversation']]) {
    for (const text of [message, JSON.stringify({ error: { message } })]) {
      expect(conversationError(text)).toMatchObject({ action, details: text })
    }
  }
  expect(conversationError('The network is unavailable.').action).toBeUndefined()
})


test('already-saved legacy interruption notices also suppress fabricated duration', () => {
  expect(hasUnobservedCompletion({ items: [{ type: 'error', text: 'The background task host closed before this task finished. Saved changes are preserved.' }] })).toBe(true)
  expect(hasUnobservedCompletion({ items: [{ type: 'error', text: 'A different failure' }] })).toBe(false)
})
