import '../styles.css'
import '@excalidraw/excalidraw/index.css'
import { exportToCanvas } from '@excalidraw/excalidraw'
import { TaskRegistry } from './registry'
import { executeTask, recoverInterruptedTasks } from './execute'
import { TASK_CHANNEL, type TaskRequest, type TaskState } from './protocol'

window.EXCALIDRAW_ASSET_PATH = new URL('../', location.href).href
// Native export initializes its bundled font registry without an editor.
const fonts = exportToCanvas({ elements: [], files: {} }).then(async () => {
  await Promise.all(['Liberation Sans', 'Excalifont', 'Cascadia'].map(name => document.fonts.load(`20px "${name}"`, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')))
})
void fonts.catch((error: unknown) => console.error('Task fonts failed to load', { error: String(error) }))
const channel = new BroadcastChannel(TASK_CHANNEL)
const pending = new Map<string, TaskState>()
let timer: ReturnType<typeof setTimeout> | undefined
const registry = new TaskRegistry((input, control) => executeTask(input, control, fonts), state => {
  // Questions and failures must never wait behind a text display batch.
  if (!state.active || state.question || state.error || !['preparing', 'streaming'].includes(state.conversation.status)) {
    pending.delete(state.id)
    channel.postMessage({ state })
    return
  }
  pending.set(state.id, state)
  if (!timer) timer = setTimeout(() => {
    timer = undefined
    for (const state of pending.values()) channel.postMessage({ state })
    pending.clear()
  }, 50)
})
const recovered = new Map<string, Promise<void>>()
channel.onmessage = ({ data }: MessageEvent<TaskRequest>) => {
  if (!data?.requestId || !data.command) return
  void (async () => {
    const command = data.command, projectId = command.method === 'start' ? command.input.projectId : command.projectId
    if (!recovered.has(projectId)) recovered.set(projectId, recoverInterruptedTasks(projectId))
    await recovered.get(projectId)
    switch (command.method) {
      case 'status': return registry.status(projectId)
      case 'start': return registry.start(command.input)
      case 'steer': return registry.steer(projectId, command.taskId, command.message)
      case 'stop': return registry.stop(projectId, command.taskId)
      case 'answer': return registry.answer(projectId, command.taskId, command.questionId, command.value)
      case 'view': return registry.view(projectId, command.taskId, command.viewport)
      default: throw new Error('Unknown task command')
    }
  })().then(state => channel.postMessage({ requestId: data.requestId, state }), error => channel.postMessage({ requestId: data.requestId, error: error instanceof Error ? error.message : String(error) }))
}
let host = chrome.runtime.connect({ name: 'galta-task-host' })
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.type !== 'task-host-ping') return false
  host.disconnect(); host = chrome.runtime.connect({ name: 'galta-task-host' })
  reply({ ok: true }); return false
})
