import type { RuntimeContext } from '@galta/domain'
import type { CanvasSlot } from '@galta/canvas'
import type { ContextPressure } from '@galta/runtime'
import type { CreativeConversationTurn } from '@galta/storage'
import type { SubmittedContext } from '../canvas/context'

export const TASK_CHANNEL = 'galta-tasks-v1'
export type TaskSubmission = {
  id: string; projectId: string; commitId: string; instruction: string; runtime: RuntimeContext
  submitted: SubmittedContext; page: { tabId: number; title: string; url: string } | null
}
export type TaskQuestion = { id: string; method: string; params: Record<string, unknown> }
export type TaskState = {
  id: string; projectId: string; runtime: RuntimeContext; active: boolean
  conversation: CreativeConversationTurn; pressure: ContextPressure | null
  question: TaskQuestion | null; error: string; sequence: number
  /** A follow-up reaches the current turn only after the provider reports its
   * turn boundary. Until then no affordance may promise one. */
  canSteer?: boolean
  /** Places the agent holds on the canvas for work in progress; view state only. */
  slots?: readonly CanvasSlot[]
}
export type TaskSteer = { id: string; instruction: string }
/** What the reader of the canvas can see, in scene units. */
export type TaskView = NonNullable<SubmittedContext['viewport']>
export type TaskCommand = { method: 'steer'; projectId: string; taskId: string; message: TaskSteer } | { method: 'status'; projectId: string } | { method: 'start'; input: TaskSubmission } | { method: 'stop'; projectId: string; taskId: string } | { method: 'answer'; projectId: string; taskId: string; questionId: string; value: unknown } | { method: 'view'; projectId: string; taskId: string; viewport: TaskView }
/** A status response can contain every task still retained for a project. This
 * keeps reopening a canvas lossless when more than one conversation is active. */
export type TaskStatus = TaskState | readonly TaskState[] | null
export type TaskRequest = { requestId: string; command: TaskCommand }
export type TaskEvent = { requestId: string; state?: TaskStatus; error?: string } | { state: TaskState }
export const isTaskRunning = (status: CreativeConversationTurn['status']) => status === 'preparing' || status === 'streaming'
/** Broadcast and command-response delivery can cross; task state is accepted
 * only when its monotonic sequence advances. */
export const isTaskStateNewer = (previous: TaskState | undefined, next: TaskState) => !previous || next.sequence > previous.sequence
