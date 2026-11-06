import { hostRuntime } from '../shared/hostRuntime'
import { TASK_CHANNEL, type TaskCommand, type TaskEvent, type TaskRequest, type TaskState, type TaskStatus } from './protocol'
import { TASK_INTERRUPTED_MESSAGE } from './recovery'

export class TaskClient {
  private channel: BroadcastChannel | undefined
  private pending = new Map<string, { resolve(state: TaskStatus): void; reject(error: Error): void }>()
  private ready: Promise<void> | undefined
  private readonly hostClosed = (message: { type?: string } | null) => {
    if (message?.type !== 'task-host-closed' || !this.channel) return
    this.ready = undefined
    this.channel.close()
    this.observe()
    for (const request of this.pending.values()) request.reject(new Error(TASK_INTERRUPTED_MESSAGE))
    this.pending.clear()
    this.onHostClosed()
  }
  constructor(private readonly projectId: string, private readonly receive: (state: TaskState | null) => void, private readonly onHostClosed: () => void) {}
  async open() {
    if (this.channel) throw new Error('Task observer is already open')
    this.observe()
    hostRuntime()!.onMessage.addListener(this.hostClosed)
    await this.refresh()
  }
  private observe() {
    const channel = this.channel = new BroadcastChannel(TASK_CHANNEL)
    channel.onmessage = ({ data }: MessageEvent<TaskEvent>) => {
      if (this.channel !== channel) return
      if (!data || typeof data !== 'object') return
      if ('requestId' in data && typeof data.requestId === 'string') {
        const request = this.pending.get(data.requestId); this.pending.delete(data.requestId)
        if (data.error) request?.reject(new Error(data.error))
        else request?.resolve(data.state ?? null)
      } else if ('state' in data && data.state && typeof data.state === 'object' && 'projectId' in data.state && data.state.projectId === this.projectId) this.receive(data.state as TaskState)
    }
  }
  async refresh() {
    this.ready = undefined
    const state = await this.command({ method: 'status', projectId: this.projectId })
    if (this.channel) {
      if (Array.isArray(state)) state.forEach(item => this.receive(item))
      else this.receive(state as TaskState | null)
    }
  }
  private ensureHost() {
    if (this.ready) return this.ready
    const ready = (async () => {
      const result = await hostRuntime()!.sendMessage({ type: 'task-host-ensure' })
      if (!result?.ok) throw new Error(result?.error ?? 'Unable to start the task host')
    })().catch(error => { if (this.ready === ready) this.ready = undefined; throw error })
    this.ready = ready
    return ready
  }
  async command(command: TaskCommand) {
    if (!this.channel) throw new Error('This task view has closed')
    const requestId = crypto.randomUUID()
    return new Promise<TaskStatus>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('The task host did not respond. Reopen the canvas to check its status before submitting again.'))
      }, 70_000)
      this.pending.set(requestId, { resolve: value => { clearTimeout(timeout); resolve(value) }, reject: error => { clearTimeout(timeout); reject(error) } })
      // Own the request before readiness: host loss must settle opening commands
      // too, and a late readiness response must never dispatch them afterward.
      void this.ensureHost().then(() => {
        if (this.pending.has(requestId)) this.channel!.postMessage({ requestId, command } satisfies TaskRequest)
      }).catch(error => {
        const request = this.pending.get(requestId)
        this.pending.delete(requestId)
        request?.reject(error)
      })
    })
  }
  close() {
    this.ready = undefined
    hostRuntime()!.onMessage.removeListener(this.hostClosed)
    this.channel?.close(); this.channel = undefined
    for (const request of this.pending.values()) request.reject(new Error('This task view has closed'))
    this.pending.clear()
  }
}
