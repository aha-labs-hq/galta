import { test, expect } from 'bun:test'
import { TaskClient } from '../apps/extension/src/tasks/client'
import { TaskRegistry } from '../apps/extension/src/tasks/registry'
import { isTaskStateNewer, TASK_CHANNEL } from '../apps/extension/src/tasks/protocol'

test('task state admission is monotonic across crossed transport deliveries', () => {
  const current = { id: 'task', sequence: 4 }
  expect(isTaskStateNewer(undefined, current)).toBe(true)
  expect(isTaskStateNewer(current, { ...current, sequence: 5 })).toBe(true)
  expect(isTaskStateNewer(current, { ...current, sequence: 4 })).toBe(false)
  expect(isTaskStateNewer(current, { ...current, sequence: 3 })).toBe(false)
})

test('closing the submitting transport cannot cancel accepted work, and a new client receives its state', async () => {
  const previous = globalThis.chrome
  const listeners = new Set()
  globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true }), onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } }
  const channel = new BroadcastChannel(TASK_CHANNEL)
  let started, finish
  const accepted = new Promise(resolve => { started = resolve }), gate = new Promise(resolve => { finish = resolve })
  const registry = new TaskRegistry(async (input, control) => {
    expect(await input.submitted.images[0].file.blob.text()).toBe('frozen image')
    started(); await gate
    expect(control.signal.aborted).toBe(false)
    control.update({ conversation: { id: input.id, instruction: input.instruction, status: 'completed', items: [] } })
  }, state => channel.postMessage({ state }))
  channel.onmessage = ({ data }) => {
    if (!data.command) return
    const state = data.command.method === 'start' ? registry.start(data.command.input) : registry.status('canvas')
    channel.postMessage({ requestId: data.requestId, state })
  }
  const first = new TaskClient('canvas', () => {}, () => {}), snapshots = []
  const reopened = new TaskClient('canvas', state => snapshots.push(state), () => {})
  try {
    await first.open()
    const sent = first.command({ method: 'start', input: { id: 'task', projectId: 'canvas', instruction: 'Draw', runtime: { sessionId: 'conversation' }, submitted: { images: [{ file: { blob: new Blob(['frozen image']) } }] } } }).catch(() => null)
    await accepted; first.close(); await sent
    await reopened.open()
    expect(snapshots.at(-1).active).toBe(true)
    finish()
    await new Promise(resolve => setTimeout(resolve, 10))
    await reopened.refresh()
    expect(snapshots.at(-1).conversation.status).toBe('completed')
    expect(snapshots.at(-1).active).toBe(false)
  } finally { finish(); first.close(); reopened.close(); channel.close(); globalThis.chrome = previous }
})

test('only a confirmed task-host closure reaches open observers; close removes its listener', async () => {
  const previous = globalThis.chrome, listeners = new Set(), lost = []
  globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true }), onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } }
  const host = new BroadcastChannel(TASK_CHANNEL)
  host.onmessage = ({ data }) => { if (data.command) host.postMessage({ requestId: data.requestId, state: [] }) }
  const client = new TaskClient('canvas', () => {}, () => lost.push('host closed'))
  try {
    await client.open(); expect(lost).toEqual([])
    for (const listener of listeners) listener({ type: 'another-message' })
    expect(lost).toEqual([])
    for (const listener of listeners) listener({ type: 'task-host-closed' })
    expect(lost).toEqual(['host closed'])
    client.close(); expect(listeners.size).toBe(0)
  } finally { client.close(); host.close(); globalThis.chrome = previous }
})
