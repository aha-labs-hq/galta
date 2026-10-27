import type { TaskQuestion, TaskState, TaskStatus, TaskSubmission, TaskSteer, TaskView } from './protocol'

export type TaskControl = {
  signal: AbortSignal
  setSteer(handler: ((message: TaskSteer) => Promise<void>) | null): void
  /** Published values are immutable snapshots; serialization belongs to the transport. */
  update(change: Partial<Pick<TaskState, 'conversation' | 'pressure' | 'error' | 'runtime' | 'slots'>>): void
  request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  /** What the reader can see while the task runs, as the canvas view reports
   * it. The latest report, if any, arrives at once. */
  watchView(handler: (view: TaskView) => void): void
}
type SteerHandler = (message: TaskSteer) => Promise<void>
/** A follow-up accepted before the turn boundary is a promise to the user, not a
 * fire-and-forget write: the command stays open until the message reaches the
 * turn, or fails with a reason the composer can show without losing the draft. */
type QueuedSteer = { message: TaskSteer; settle(delivered: boolean, reason: string): void }
type Task = { view?: TaskView; viewed?: (view: TaskView) => void; steer?: SteerHandler | null; pending: QueuedSteer[]; steering: Map<string, Promise<TaskState>>; state: TaskState; abort: AbortController; done: Promise<void>; questions: Map<string, { question: TaskQuestion; resolve(value: unknown): void; reject(error: unknown): void }> }

/** Execution belongs to the registry. Observers have no cancellation rights;
 * commands are fenced by task/question identity, including delayed UI replies. */
export class TaskRegistry {
  /** One canvas may have several independent conversations in flight. */
  private tasks = new Map<string, Map<string, Task>>()
  constructor(private readonly execute: (input: TaskSubmission, control: TaskControl) => Promise<void>, private readonly publish: (state: TaskState) => void) {}
  status(projectId: string): TaskStatus {
    const tasks = this.tasks.get(projectId)
    if (!tasks?.size) return null
    const states = [...tasks.values()].map(task => structuredClone(task.state))
    return states.length === 1 ? states[0]! : states
  }
  start(input: TaskSubmission) {
    const tasks = this.tasks.get(input.projectId) ?? new Map<string, Task>()
    this.tasks.set(input.projectId, tasks)
    const previous = tasks.get(input.id)
    if (previous) return structuredClone(previous.state)
    for (const [id, task] of tasks) if (task.state.runtime.sessionId === input.runtime.sessionId) {
      if (task.state.active) throw new Error('A task is already running in this conversation.')
      // A settled turn still owns queued follow-ups and a stop handle. Retiring
      // it here must release them rather than strand a command that is waiting
      // for a turn that will never accept it.
      task.abort.abort(new Error('This conversation moved on to a newer task.'))
      tasks.delete(id)
    }
    const task: Task = { pending: [], state: { id: input.id, projectId: input.projectId, runtime: input.runtime, active: true, sequence: 0,
      conversation: { id: input.id, instruction: input.instruction, status: 'preparing', startedAt: Date.now(), items: [] }, pressure: null, question: null, error: '' },
      steering: new Map(), abort: new AbortController(), questions: new Map(), done: Promise.resolve() }
    tasks.set(input.id, task)
    const changed = () => { task.state = { ...task.state, sequence: task.state.sequence + 1 }; this.publish(task.state) }
    const request: TaskControl['request'] = (method, params, signal) => {
      if (!['item/tool/requestUserInput', 'item/permissions/requestApproval', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) return Promise.reject(new Error(`Unsupported Codex interaction: ${method}. The request was not approved.`))
      const combined = AbortSignal.any([signal, task.abort.signal])
      combined.throwIfAborted()
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID(), question = { id, method, params }
        const finish = (answer: () => void) => {
          combined.removeEventListener('abort', cancel); task.questions.delete(id)
          task.state = { ...task.state, question: task.questions.values().next().value?.question ?? null }
          changed(); answer()
        }
        const cancel = () => finish(() => reject(combined.reason))
        task.questions.set(id, { question, resolve: value => finish(() => resolve(value)), reject: error => finish(() => reject(error)) })
        combined.addEventListener('abort', cancel, { once: true })
        task.state = { ...task.state, question: task.state.question ?? question }; changed()
      })
    }
    // Reserve synchronously, before any asynchronous preparation or observer
    // acknowledgement. Closing the submitting view cannot revoke this task.
    task.done = Promise.resolve().then(() => this.execute(input, { signal: task.abort.signal, request, watchView: handler => { task.viewed = handler; if (task.view) handler(task.view) }, setSteer: handler => { task.steer = handler; task.state = { ...task.state, canSteer: Boolean(handler) }; changed(); if (handler) this.flushSteers(task) }, update: change => { task.state = { ...task.state, ...change }; changed() } }))
      .catch(error => {
        task.state = { ...task.state, error: error instanceof Error ? error.message : String(error), conversation: { ...task.state.conversation, status: 'failed', completedAt: Date.now() } }
        console.error('Task execution failed', { projectId: input.projectId, taskId: input.id, error: task.state.error })
      }).finally(() => {
        for (const question of [...task.questions.values()]) question.reject(new Error('The task ended'))
        // A turn that never accepted a follow-up still owes its sender an
        // answer: silence here is exactly the loss this queue exists to prevent.
        this.settleSteers(task, 'The turn ended before this follow-up could reach it.')
        task.state = { ...task.state, active: false, canSteer: false, slots: [] }; changed()
      })
    changed()
    return structuredClone(task.state)
  }
  private require(projectId: string, id: string) {
    const task = this.tasks.get(projectId)?.get(id)
    if (!task) throw new Error('This task is no longer current.')
    return task
  }
  /** Deliver queued follow-ups once the turn accepts one. A turn that ends
   * first settles every queued message with its reason, so an accepted command
   * can never end in silence. */
  private flushSteers(task: Task) {
    const handler = task.steer
    if (!handler || !task.pending.length) return
    for (const queued of task.pending.splice(0)) void this.deliver(task, handler, queued)
  }
  private settleSteers(task: Task, reason: string) {
    for (const queued of task.pending.splice(0)) queued.settle(false, reason)
  }
  /** One follow-up is settled exactly once: delivered to the turn, or rejected
   * with a reason. A refused follow-up is not a failed turn — the status stays
   * unchanged — so the reason travels back to the command that asked for it and
   * is also published, where a collapsed composer can still report it. */
  private deliver(task: Task, handler: SteerHandler, queued: QueuedSteer) {
    const sent = Promise.resolve().then(() => handler(queued.message))
    void sent.then(() => queued.settle(true, ''), error => {
      const message = error instanceof Error ? error.message : String(error)
      queued.settle(false, message)
      task.state = { ...task.state, error: message, sequence: task.state.sequence + 1 }
      this.publish(task.state)
    })
    // The command's rejection is the user-visible signal; `steering` only
    // serializes sends, so it must never carry an unhandled rejection.
    return sent.then(() => undefined, () => undefined)
  }
  steer(projectId: string, id: string, message: TaskSteer) {
    const task = this.require(projectId, id)
    if (!message.id || !message.instruction.trim()) throw new Error('A follow-up message cannot be empty.')
    const existing = task.steering.get(message.id)
    if (existing) return existing
    if (!task.state.active || task.abort.signal.aborted) throw new Error('This conversation is no longer running. Your draft is preserved.')
    const state = new Promise<TaskState>((resolve, reject) => {
      const queued: QueuedSteer = { message, settle: (delivered, reason) => delivered ? resolve(structuredClone(task.state)) : reject(new Error(reason)) }
      const handler = task.steer
      if (!handler) { task.pending.push(queued); return }
      void this.deliver(task, handler, queued)
    })
    // Register before waiting or delivering so a retried command shares the
    // same outcome. A pending duplicate must not enter the delivery queue a
    // second time, and an accepted duplicate must not call the provider twice.
    task.steering.set(message.id, state)
    return state
  }
  async stop(projectId: string, id: string) {
    const task = this.require(projectId, id)
    if (task.state.active) task.abort.abort(new Error('Stopped by the user'))
    await task.done
    return structuredClone(task.state)
  }
  /** Where the reader is looking, from the canvas view. A task places work
   * without a place of its own there, as an agent in the open canvas does. */
  view(projectId: string, id: string, view: TaskView) {
    const task = this.require(projectId, id)
    if (![view?.x, view?.y, view?.width, view?.height, view?.zoom].every(Number.isFinite) || view.width <= 0 || view.height <= 0 || view.zoom <= 0) throw new Error('Invalid canvas view')
    if (!task.state.active) return null
    task.view = { x: view.x, y: view.y, width: view.width, height: view.height, zoom: view.zoom }
    task.viewed?.(task.view)
    return null
  }
  answer(projectId: string, id: string, questionId: string, value: unknown) {
    const task = this.require(projectId, id), question = task.questions.get(questionId)
    if (!task.state.active || !question) throw new Error('This question is no longer waiting for an answer.')
    question.resolve(value)
    return structuredClone(task.state)
  }
}
