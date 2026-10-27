import { test, expect } from 'bun:test'
import { TaskRegistry } from '../apps/extension/src/tasks/registry'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const input = (id = 'first', projectId = 'canvas') => ({ id, projectId, instruction: 'Continue drawing', runtime: { sessionId: 'session' } })

test('execution continues without observers, reattachment reads the current task and start is idempotent', async () => {
  const gate = deferred(); let starts = 0, observe = true
  const events = []
  const registry = new TaskRegistry(async (submission, control) => {
    starts++
    await gate.promise
    expect(control.signal.aborted).toBe(false)
    control.update({ conversation: { id: submission.id, status: 'completed', items: [{ text: 'Finished after the view closed' }] } })
  }, state => { if (observe) events.push(state) })
  registry.start(input()); await tick(); observe = false
  expect(registry.start(input()).id).toBe('first')
  expect(() => registry.start(input('duplicate'))).toThrow('already running')
  gate.resolve(); await tick()
  const reopened = registry.status('canvas')
  expect(starts).toBe(1)
  expect(reopened.active).toBe(false)
  expect(reopened.conversation.status).toBe('completed')
  reopened.conversation.items.length = 0
  expect(registry.status('canvas').conversation.items).toHaveLength(1)
  expect(events.at(-1).active).toBe(true)
})

test('approval survives observer loss, queues questions, and stale answers cannot approve another task', async () => {
  let answers
  const registry = new TaskRegistry(async (_, control) => {
    answers = await Promise.all([
      control.request('item/tool/requestUserInput', { question: 'First' }, control.signal),
      control.request('item/commandExecution/requestApproval', { command: 'Second' }, control.signal)
    ])
  }, () => {})
  registry.start(input()); await tick()
  const first = registry.status('canvas').question
  registry.answer('canvas', 'first', first.id, { answers: 'one' })
  expect(() => registry.answer('canvas', 'first', first.id, 'duplicate')).toThrow('no longer')
  const second = registry.status('canvas').question
  expect(second.params.command).toBe('Second')
  registry.answer('canvas', 'first', second.id, { decision: 'accept' })
  await tick()
  expect(answers).toEqual([{ answers: 'one' }, { decision: 'accept' }])
  expect(registry.status('canvas').question).toBeNull()
})

test('stop aborts once and waits for terminal persistence; old controls cannot stop a replacement', async () => {
  const saved = deferred(); let stops = 0
  const registry = new TaskRegistry(async (_, control) => {
    try { await control.request('item/tool/requestUserInput', {}, control.signal) }
    catch { stops++; await saved.promise; control.update({ conversation: { status: 'stopped', items: [] } }) }
  }, () => {})
  registry.start(input()); await tick()
  let ended = false
  const one = registry.stop('canvas', 'first').then(() => { ended = true })
  const two = registry.stop('canvas', 'first')
  await tick()
  expect(ended).toBe(false)
  expect(registry.status('canvas').active).toBe(true)
  saved.resolve(); await Promise.all([one, two])
  expect(stops).toBe(1)
  registry.start(input('replacement')); await tick()
  await expect(registry.stop('canvas', 'first')).rejects.toThrow('no longer current')
  expect(registry.status('canvas').active).toBe(true)
  await registry.stop('canvas', 'replacement')
})

test('separate projects have independent execution and cancellation', async () => {
  const registry = new TaskRegistry(async (_, control) => {
    await new Promise(resolve => control.signal.addEventListener('abort', resolve, { once: true }))
    control.update({ conversation: { status: 'stopped', items: [] } })
  }, () => {})
  registry.start(input('one', 'a')); registry.start(input('two', 'b')); await tick()
  await registry.stop('a', 'one')
  expect(registry.status('b').active).toBe(true)
  await registry.stop('b', 'two')
})

test('one project can retain independent conversations and steer the selected task', async () => {
  const gates = new Map([['one', deferred()], ['two', deferred()]])
  const registry = new TaskRegistry(async (submission, control) => {
    control.setSteer(async message => control.update({ conversation: { steering: [{ id: message.id, text: message.instruction }] } }))
    await gates.get(submission.id).promise
  }, () => {})
  const first = { ...input('one'), runtime: { sessionId: 'first' } }
  const second = { ...input('two'), runtime: { sessionId: 'second' } }
  registry.start(first); registry.start(second); await tick()
  const status = registry.status('canvas')
  expect(Array.isArray(status)).toBe(true)
  expect(status.map(task => task.runtime.sessionId).sort()).toEqual(['first', 'second'])
  const steered = await registry.steer('canvas', 'two', { id: 'steer-1', instruction: 'Keep the second conversation focused.' })
  expect(steered.conversation.steering).toEqual([{ id: 'steer-1', text: 'Keep the second conversation focused.' }])
  gates.get('one').resolve(); gates.get('two').resolve(); await Promise.all([registry.stop('canvas', 'one'), registry.stop('canvas', 'two')])
})

test('a follow-up submitted during preparation is delivered when steering becomes available', async () => {
  const ready = deferred(), delivered = []
  const registry = new TaskRegistry(async (_, control) => {
    await ready.promise
    control.setSteer(async message => { delivered.push(message.instruction) })
    await new Promise(resolve => control.signal.addEventListener('abort', resolve, { once: true }))
  }, () => {})
  registry.start({ ...input('queued'), runtime: { sessionId: 'queued-session' } }); await tick()
  // Before the provider boundary the command stays open: nothing has been sent,
  // so nothing may be reported as sent.
  const queued = registry.steer('canvas', 'queued', { id: 'queued-steer', instruction: 'Keep the spacing quiet.' })
  let settled = false
  void queued.finally(() => { settled = true }).catch(() => {})
  await tick()
  expect(settled).toBe(false)
  expect(delivered).toEqual([])
  ready.resolve(); await tick(); await tick()
  expect((await queued).active).toBe(true)
  expect(delivered).toEqual(['Keep the spacing quiet.'])
  await registry.stop('canvas', 'queued')
})

test('a follow-up that never reaches the turn is refused with a reason instead of vanishing', async () => {
  const gate = deferred()
  const registry = new TaskRegistry(async (_, control) => {
    control.update({ conversation: { status: 'streaming', items: [] } })
    await gate.promise
  }, () => {})
  registry.start({ ...input('doomed', 'doomed-canvas'), runtime: { sessionId: 'doomed-session' } }); await tick()
  // No turn boundary ever arrives, so the queued follow-up must not be silently
  // dropped when the turn ends.
  const refusal = registry.steer('doomed-canvas', 'doomed', { id: 'doomed-steer', instruction: 'Reconsider the entrance.' }).then(() => '', error => error.message)
  gate.resolve(); await tick(); await tick()
  expect(await refusal).toBe('The turn ended before this follow-up could reach it.')
})

test('a follow-up the turn itself refuses reports its reason without failing the request', async () => {
  const gate = deferred(), errors = []
  const registry = new TaskRegistry(async (_, control) => {
    control.setSteer(async () => { throw new Error('This Codex turn is no longer accepting follow-ups.') })
    await gate.promise
  }, state => { if (state.error) errors.push(state.error) })
  registry.start({ ...input('refusing', 'refusing-canvas'), runtime: { sessionId: 'refusing-session' } }); await tick()
  const refusal = registry.steer('refusing-canvas', 'refusing', { id: 'refusing-steer', instruction: 'Reconsider.' }).then(() => '', error => error.message)
  expect(await refusal).toBe('This Codex turn is no longer accepting follow-ups.')
  expect(errors).toEqual(['This Codex turn is no longer accepting follow-ups.'])
  // The request itself is still running: a refused follow-up is not a failure.
  expect(registry.status('refusing-canvas').conversation.status).toBe('preparing')
  gate.resolve(); await tick()
})

test('replayed follow-ups share one result and are delivered once', async () => {
  const gate = deferred(), delivered = []
  const registry = new TaskRegistry(async (_, control) => {
    control.setSteer(async message => { delivered.push(message.id); control.update({ conversation: { steering: [{ id: message.id, text: message.instruction }] } }) })
    await gate.promise
  }, () => {})
  registry.start({ ...input('replayed'), runtime: { sessionId: 'replayed-session' } }); await tick()
  const message = { id: 'same-steer', instruction: 'Keep the current spacing.' }
  const first = registry.steer('canvas', 'replayed', message)
  const second = registry.steer('canvas', 'replayed', message)
  expect(second).toBe(first)
  const [one, two] = await Promise.all([first, second])
  expect(one.conversation.steering).toEqual([{ id: 'same-steer', text: 'Keep the current spacing.' }])
  expect(two.conversation.steering).toEqual(one.conversation.steering)
  expect(delivered).toEqual(['same-steer'])
  gate.resolve(); await registry.stop('canvas', 'replayed')
})

test('replayed follow-ups queued during preparation share one pending delivery', async () => {
  const ready = deferred(), delivered = []
  const registry = new TaskRegistry(async (_, control) => {
    await ready.promise
    control.setSteer(async message => { delivered.push(message.id) })
    await new Promise(resolve => control.signal.addEventListener('abort', resolve, { once: true }))
  }, () => {})
  registry.start({ ...input('queued-replay'), runtime: { sessionId: 'queued-replay-session' } }); await tick()
  const message = { id: 'same-queued-steer', instruction: 'Keep the process in order.' }
  const first = registry.steer('canvas', 'queued-replay', message)
  const second = registry.steer('canvas', 'queued-replay', message)
  expect(second).toBe(first)
  ready.resolve(); await tick(); await tick()
  await Promise.all([first, second])
  expect(delivered).toEqual(['same-queued-steer'])
  await registry.stop('canvas', 'queued-replay')
})

test('an active turn still refuses a second task in the same conversation', async () => {
  const gate = deferred()
  const registry = new TaskRegistry(async (_, control) => {
    await gate.promise
  }, () => {})
  registry.start({ ...input('old', 'retire-canvas'), runtime: { sessionId: 'shared' } }); await tick()
  expect(() => registry.start({ ...input('new', 'retire-canvas'), runtime: { sessionId: 'shared' } })).toThrow('already running')
  gate.resolve(); await tick()
})

test('places a task holds on the canvas end with the task', async () => {
  const gate = deferred(), events = []
  const registry = new TaskRegistry(async (_, control) => {
    control.update({ slots: [{ id: 'place-1', x: 0, y: 0, width: 320, height: 180 }] })
    await gate.promise
  }, state => events.push(state))
  registry.start(input()); await tick()
  expect(registry.status('canvas').slots).toHaveLength(1)
  gate.resolve(); await tick()
  expect(registry.status('canvas')).toMatchObject({ active: false, slots: [] })
  expect(events.at(-1)).toMatchObject({ active: false, slots: [] })
})

// A built-in task runs where no reader is. The canvas view reports what its
// reader can see while the task runs; the task receives the latest report as
// soon as it watches, then every later one, and a malformed or late report
// never reaches it.
test('a running task follows the reader’s view, starting from the latest report', async () => {
  const gate = deferred(), seen = []
  let watch
  const registry = new TaskRegistry(async (_, control) => {
    watch = () => control.watchView(view => seen.push(view))
    await gate.promise
  }, () => {})
  registry.start(input()); await tick()
  const early = { x: 0, y: 80, width: 1200, height: 400, zoom: 1 }, later = { ...early, height: 300 }
  expect(registry.view('canvas', 'first', { ...early, extra: 'ignored' })).toBeNull()
  watch()
  expect(seen).toEqual([early])
  registry.view('canvas', 'first', later)
  expect(seen).toEqual([early, later])
  for (const invalid of [{ ...later, width: 0 }, { ...later, zoom: Number.NaN }, null]) expect(() => registry.view('canvas', 'first', invalid)).toThrow('Invalid canvas view')
  expect(() => registry.view('canvas', 'missing', later)).toThrow('no longer current')
  gate.resolve(); await tick()
  registry.view('canvas', 'first', { ...later, y: 0 })
  expect(seen).toHaveLength(2)
})
