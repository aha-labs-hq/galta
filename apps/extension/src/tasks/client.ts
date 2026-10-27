import { TASK_CHANNEL, type TaskCommand, type TaskEvent, type TaskRequest, type TaskState, type TaskStatus } from './protocol'

export class TaskClient {
  private channel: BroadcastChannel | undefined
  private pending = new Map<string, { resolve(state: TaskStatus): void; reject(error: Error): void }>()
  private ready: Promise<void> | undefined
  private readonly hostClosed = (message: { type?: string } | null) => { if (message?.type === 'task-host-closed' && this.channel) this.onHostClosed() }
  constructor(private readonly projectId: string, private readonly receive: (state: TaskState | null) => void, private readonly onHostClosed: () => void) {}
  async open() {
    if (this.channel) throw new Error('Task observer is already open')
    const channel = this.channel = new BroadcastChannel(TASK_CHANNEL)
    chrome.runtime.onMessage.addListener(this.hostClosed)
    channel.onmessage = ({ data }: MessageEvent<TaskEvent>) => {
      if (!data || typeof data !== 'object') return
      if ('requestId' in data && typeof data.requestId === 'string') {
        const request = this.pending.get(data.requestId); this.pending.delete(data.requestId)
        if (data.error) request?.reject(new Error(data.error))
        else request?.resolve(data.state ?? null)
      } else if ('state' in data && data.state && typeof data.state === 'object' && 'projectId' in data.state && data.state.projectId === this.projectId) this.receive(data.state as TaskState)
    }
    await this.refresh()
  }
  async refresh() {
    this.ready = (async () => {
      const result = await chrome.runtime.sendMessage({ type: 'task-host-ensure' })
      if (!result?.ok) throw new Error(result?.error ?? 'Unable to start the task host')
    })()
    const state = await this.command({ method: 'status', projectId: this.projectId })
    if (this.channel) {
      if (Array.isArray(state)) state.forEach(item => this.receive(item))
      else this.receive(state as TaskState | null)
    }
  }
  async command(command: TaskCommand) {
    await this.ready
    if (!this.channel) throw new Error('This task view has closed')
    const requestId = crypto.randomUUID()
    return new Promise<TaskStatus>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('The task host did not respond. Reopen the canvas to check its status before submitting again.'))
      }, 70_000)
      this.pending.set(requestId, { resolve: value => { clearTimeout(timeout); resolve(value) }, reject: error => { clearTimeout(timeout); reject(error) } })
      this.channel!.postMessage({ requestId, command } satisfies TaskRequest)
    })
  }
  close() {
    chrome.runtime.onMessage.removeListener(this.hostClosed)
    this.channel?.close(); this.channel = undefined
    for (const request of this.pending.values()) request.reject(new Error('This task view has closed'))
    this.pending.clear()
  }
}
