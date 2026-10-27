import { test, expect } from 'bun:test'
import { CodexAgentRuntime, additionalContext, conversationItem, encodeNativeMessages, NativeMessageDecoder } from '../packages/runtime/src/index.ts'
import { codexInstructions } from '../packages/runtime/src/codexInstructions.ts'
import { CANVAS_MESSAGE_LABEL, CANVAS_SELECTION_ROUTING_INSTRUCTIONS, CANVAS_COORDINATE_INSTRUCTIONS, CANVAS_TOOL_NAMES, canvasMessageContextSchema, summarizeCanvasEvidence } from '../packages/canvas/src/index.ts'
import { galtaToolContract } from '../packages/canvas/src/contract'

const input = { projectId: 'p', branchId: 'b', execution: { id: 'bridge/lease', cwd: '/tmp/galta' }, instruction: 'Create a rectangle', runtime: { sessionId: 'moodboard', sessionLabel: 'Moodboard', modelId: 'model', effort: 'Low', providerId: 'codex-app-server' } }
const observation = {
  commitId: 'commit', revision: 'revision', viewport: { x: 10, y: 20, width: 1000, height: 800, zoom: 1 }, elementCount: 1,
  selection: { total: 0, items: [], truncated: false },
  visible: { total: 1, items: [{ id: 'drawing', kind: 'draw', bounds: { x: 10, y: 20, width: 100, height: 100 } }], truncated: false },
  changes: { since: null, status: 'initial', total: 0, items: [], truncated: false }, preview: { status: 'attached', unrenderedCount: 0 }
}
const host = { request: async () => ({ decision: 'decline' }) }
function setup() {
  const listeners = new Set(), calls = [], replies = []
  const emit = (method, params, id) => listeners.forEach(listener => listener({ method, params, ...(id === undefined ? {} : { id }) }))
  const rpc = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async respond(id, result, error) { replies.push({ id, result, error }) },
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'galta/config/read') return { toolContract: await galtaToolContract() }
      if (method.startsWith('thread/')) return { thread: { id: 'thread' } }
      if (method === 'turn/start') return { turn: { id: 'turn' } }
      return {}
    }
  }
  return { rpc, calls, replies, emit, listeners }
}
async function started(runtime, inputOverride = input, toolHost = host) {
  const handle = await runtime.start(inputOverride, toolHost)
  const iterator = handle.updates[Symbol.asyncIterator]()
  expect((await iterator.next()).value.state).toBe('preparing')
  expect((await iterator.next()).value.threadId).toBe('thread')
  expect((await iterator.next()).value.state).toBe('streaming')
  return { handle, iterator }
}

test('the canvas surface is one verb per tool, each with one effect', () => {
  expect(CANVAS_TOOL_NAMES).toEqual(['canvas_inspect', 'canvas_capture', 'canvas_report', 'canvas_edit', 'canvas_place', 'canvas_reserve', 'canvas_extract', 'canvas_deliver'])
})

test('only a successful Galta canvas_deliver result becomes a structured delivery declaration', () => {
  const declaration = {
    path: '/workspace/selected.txt', artifactUri: 'galta-workspace:/selected.txt', sourceArtifactUri: 'galta-workspace:/sources/source.txt',
    name: 'selected.txt', mimeType: 'text/plain', size: 4, sha256: '0000000000000000000000000000000000000000000000000000000000000000', version: 'source-version'
  }
  const item = conversationItem({ id: 'delivery', type: 'mcpToolCall', status: 'completed', server: 'galta', tool: 'canvas_deliver', result: { structuredContent: declaration } }, 'completed')
  expect(item?.delivery).toEqual(declaration)
  expect(conversationItem({ id: 'failed-delivery', type: 'mcpToolCall', status: 'failed', server: 'galta', tool: 'canvas_deliver', result: { structuredContent: declaration } }, 'failed')?.delivery).toBeUndefined()
  expect(conversationItem({ id: 'malformed-delivery', type: 'mcpToolCall', status: 'completed', server: 'galta', tool: 'canvas_deliver', result: { structuredContent: { ...declaration, sha256: 'bad' } } }, 'completed')?.delivery).toBeUndefined()
  expect(conversationItem({ id: 'wrong-tool', type: 'mcpToolCall', status: 'completed', server: 'other', tool: 'canvas_deliver', result: { structuredContent: declaration } }, 'completed')?.delivery).toBeUndefined()
})

test('the runtime supplies an MCP execution context without registering a second tool path', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { iterator } = await started(runtime)
  const thread = t.calls.find(c => c.method === 'thread/start').params
  expect(thread.ephemeral).toBe(false)
  // Galta IDs are local canvas identities, not registered Codex projects.
  expect(thread.projectId).toBeUndefined()
  expect(thread.cwd).toBe('/tmp/galta')
  expect(thread.approvalPolicy).toBe('never')
  expect(thread.sandbox).toBe('danger-full-access')
  expect(thread.baseInstructions).toBeUndefined()
  expect(thread.developerInstructions).toBeUndefined()
  expect(thread.dynamicTools).toBeUndefined()
  expect(t.calls.find(c => c.method === 'turn/start').params.outputSchema).toBeUndefined()
  const turn = t.calls.find(c => c.method === 'turn/start').params
  expect(turn.input[0].text).toBe(input.instruction)
  expect(turn.additionalContext.galta_instructions.kind).toBe('application')
  const instructions = turn.additionalContext.galta_instructions.value
  expect(instructions).toContain("galta MCP server's instructions and tool schemas")
  // Capabilities carry their own guidance in their tools; the always-sent prompt names none.
  expect(instructions).not.toMatch(/generate_|BytePlus|OpenRouter|Higgsfield|\bfal\b/)
  expect(instructions).not.toContain('seed-media')
  expect(turn.collaborationMode).toBeUndefined()
  expect(t.calls.map(c => c.method)).toEqual(['galta/config/read', 'thread/start', 'turn/start'])
  expect(turn.additionalContext.canvas.kind).toBe('application')
  expect(turn.additionalContext.execution).toEqual({ kind: 'application', value: JSON.stringify(input.execution) })
  expect(instructions).toContain('galta MCP server')
  expect(turn.approvalPolicy).toBe('never')
  expect(turn.sandboxPolicy).toEqual({ type: 'dangerFullAccess' })
  t.emit('item/agentMessage/delta', { threadId: 'thread', turnId: 'turn', itemId: 'answer', delta: '**Done.** The rectangle is on your canvas.' })
  expect((await iterator.next()).value.item.text).toContain('**Done.**')
  t.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } })
  expect((await iterator.next()).value.state).toBe('completed')
  await iterator.return()
  expect(t.listeners.size).toBe(0)
})

test('selection is a first-class target signal for source delivery', () => {
  expect(CANVAS_SELECTION_ROUTING_INSTRUCTIONS).toContain('first-class attention signal')
  expect(CANVAS_SELECTION_ROUTING_INSTRUCTIONS).toContain('canvas_extract with the selection scope before searching workspace files')
  expect(CANVAS_SELECTION_ROUTING_INSTRUCTIONS).toContain('old output')
  expect(CANVAS_SELECTION_ROUTING_INSTRUCTIONS).toContain('no source file')
  expect(codexInstructions()).toContain(CANVAS_SELECTION_ROUTING_INSTRUCTIONS)
})

test('embedded Codex receives target routing before it can search workspace names', () => {
  const instructions = codexInstructions(null)
  expect(instructions).toContain(CANVAS_SELECTION_ROUTING_INSTRUCTIONS)
  expect(instructions).toContain('explicitly asks about an independent workspace file')
  expect(instructions).toContain(CANVAS_COORDINATE_INSTRUCTIONS)
  expect(instructions).toContain('exact execution.id in the current execution application context')
  expect(instructions).not.toContain('use its id for Galta tool calls')
})

test('unsupported host interactions return one protocol error without breaking the turn', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { iterator } = await started(runtime, input, { request: async () => { throw new Error('Unsupported interaction') } })
  t.emit('item/unknown/request', { threadId: 'thread', turnId: 'turn' }, 91)
  const next = iterator.next()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(t.replies).toEqual([{ id: 91, result: undefined, error: { code: -32000, message: 'Unsupported interaction' } }])
  t.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } })
  expect((await next).value.state).toBe('completed')
  await iterator.return()
})

test('a server-resolved request is dismissed even if its UI has not opened yet', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  let prompts = 0
  const { iterator } = await started(runtime, input, { request: async () => { prompts++; return {} } })
  t.emit('item/tool/requestUserInput', { threadId: 'thread', turnId: 'turn' }, 12)
  t.emit('serverRequest/resolved', { threadId: 'thread', requestId: 12 })
  const next = iterator.next()
  await new Promise(resolve => setTimeout(resolve, 0))
  t.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } })
  expect((await next).value.state).toBe('completed')
  expect(prompts).toBe(0)
  expect(t.replies).toEqual([])
  await iterator.return()
})

for (const ended of ['serverRequest/resolved', 'galta/connection-lost']) test(`${ended} closes pending host interaction without sending a stale answer`, async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  let opened
  const shown = new Promise(resolve => { opened = resolve })
  const { iterator } = await started(runtime, input, { request: (_method, _params, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    opened()
  }) })
  t.emit('item/tool/requestUserInput', { threadId: 'thread', turnId: 'turn' }, 12)
  const next = iterator.next()
  await shown
  t.emit(ended, { threadId: 'thread', requestId: 12, message: 'Transport closed' })
  if (ended === 'galta/connection-lost') await expect(next).rejects.toThrow('Transport closed')
  else {
    t.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } })
    expect((await next).value.state).toBe('stopped')
    await iterator.return()
  }
  expect(t.replies).toEqual([])
  expect(t.listeners.size).toBe(0)
}, 1000)

test('a message without a canvas observation carries only the user words', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { iterator } = await started(runtime)
  const turn = t.calls.find(c => c.method === 'turn/start').params
  expect(turn.input).toEqual([{ type: 'text', text: input.instruction, text_elements: [] }])
  await iterator.return()
})

test('an unsupported observation image fails before opening a Codex thread', async () => {
  for (const dataUrl of ['https://remote.test/image.png', 'data:image/svg+xml;base64,AA==']) {
    const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
    await expect(runtime.start({ ...input, canvas: { context: observation, image: { dataUrl } } }, host)).rejects.toThrow()
    expect(t.calls).toEqual([])
  }
})

test('context pressure is reported from the thread token usage notification', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { iterator } = await started(runtime)
  t.emit('thread/tokenUsage/updated', { threadId: 'thread', turnId: 'turn', tokenUsage: { last: { inputTokens: 1200, cachedInputTokens: 900, cacheWriteInputTokens: 300 }, modelContextWindow: 200000 } })
  expect((await iterator.next()).value.context).toEqual({ tokens: 1200, window: 200000 })
  t.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } })
  await iterator.next()
  await iterator.return()
})

test('provider retries are visible without retrying a user turn or claiming a completed tool recovered the model', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { iterator } = await started(runtime)
  t.emit('error', { threadId: 'thread', turnId: 'turn', willRetry: true, error: { message: 'Upstream timed out' } })
  // Nested tools can keep running while the model stream reconnects.
  t.emit('item/started', { threadId: 'thread', turnId: 'turn', item: { id: 'tool', type: 'commandExecution', command: 'pwd', status: 'inProgress' } })
  t.emit('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'tool', type: 'commandExecution', command: 'pwd', status: 'completed' } })
  t.emit('item/agentMessage/delta', { threadId: 'thread', turnId: 'turn', itemId: 'reply', delta: 'Continuing.' })
  t.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } })
  const retry = (await iterator.next()).value.item
  expect(retry).toMatchObject({ type: 'modelRetry', status: 'inProgress', error: 'Upstream timed out' })
  expect((await iterator.next()).value.item).toMatchObject({ id: 'tool', status: 'inProgress' })
  expect((await iterator.next()).value.item.id).toBe('tool')
  expect((await iterator.next()).value.item).toMatchObject({ id: retry.id, status: 'completed' })
  expect((await iterator.next()).value.item.text).toBe('Continuing.')
  expect((await iterator.next()).value.state).toBe('completed')
  expect(t.calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
  await iterator.return()
})

test('a provider retry ending in failure keeps its diagnostics and never reports recovery', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { iterator } = await started(runtime)
  t.emit('error', { threadId: 'thread', turnId: 'turn', willRetry: true, error: { message: 'Temporary failure' } })
  t.emit('error', { threadId: 'thread', turnId: 'turn', willRetry: false, error: { message: 'Stream ended' } })
  t.emit('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'partial', type: 'agentMessage', text: 'Partial response' } })
  t.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'failed', error: { message: 'Retries exhausted' } } })
  expect((await iterator.next()).value.item.status).toBe('inProgress')
  expect((await iterator.next()).value.item.id).toBe('partial')
  expect((await iterator.next()).value.item).toMatchObject({ status: 'failed', error: 'Retries exhausted' })
  await expect(iterator.next()).rejects.toThrow('Retries exhausted')
  expect(t.listeners.size).toBe(0)
})

test('a terminal error waits for the authoritative completion and retains final tool receipts', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { iterator } = await started(runtime)
  t.emit('error', { threadId: 'thread', turnId: 'turn', willRetry: false, error: { message: 'Stream failed' } })
  t.emit('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'command', type: 'commandExecution', command: 'pwd', status: 'completed', exitCode: 0, aggregatedOutput: '/tmp/galta' } })
  expect((await iterator.next()).value.item).toMatchObject({ id: 'command', status: 'completed', output: '/tmp/galta' })
  expect(t.listeners.size).toBe(1)
  t.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'failed', error: { message: 'Final failure' } } })
  await expect(iterator.next()).rejects.toThrow('Final failure')
  expect(t.listeners.size).toBe(0)
})

test('an orphaned terminal error is bounded and releases the runtime', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { iterator } = await started(runtime)
  t.emit('error', { threadId: 'thread', turnId: 'turn', willRetry: false, error: { message: 'Stream failed' } })
  await expect(iterator.next()).rejects.toThrow('Stream failed')
  expect(t.listeners.size).toBe(0)
})

test('stop acknowledgement keeps the turn alive until completion, including final tool receipts', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { handle, iterator } = await started(runtime)
  t.emit('turn/started', { threadId: 'thread', turn: { id: 'turn' } })
  t.emit('item/started', { threadId: 'thread', turnId: 'turn', item: { id: 'command', type: 'commandExecution', command: 'sleep 10', status: 'inProgress' } })
  await iterator.next()
  await runtime.stop(handle.runId)
  t.emit('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'command', type: 'commandExecution', command: 'sleep 10', status: 'failed', exitCode: 130 } })
  expect((await iterator.next()).value.item).toMatchObject({ id: 'command', status: 'failed', exitCode: 130 })
  expect(t.listeners.size).toBe(1)
  await runtime.stop(handle.runId)
  expect(t.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(1)
  t.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } })
  expect((await iterator.next()).value.state).toBe('stopped')
  await iterator.return()
})

test('a stale completion cannot suppress interruption or close the current turn', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { handle, iterator } = await started(runtime)
  t.emit('turn/completed', { threadId: 'thread', turn: { id: 'previous-turn', status: 'completed' } })
  await runtime.stop(handle.runId)
  t.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } })
  expect((await iterator.next()).value.state).toBe('stopped')
  expect(t.calls.filter(call => call.method === 'turn/interrupt')).toEqual([{ method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'turn' } }])
  await iterator.return()
})

test('completion already received wins a late stop', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { handle, iterator } = await started(runtime)
  t.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } })
  await runtime.stop(handle.runId)
  expect((await iterator.next()).value.state).toBe('completed')
  expect(t.calls.some(call => call.method === 'turn/interrupt')).toBe(false)
  await iterator.return()
})

test('steering targets the current turn and rejects after completion', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { handle, iterator } = await started(runtime)
  await runtime.steer(handle.runId, 'Keep the current material and tighten the spacing.')
  expect(t.calls.at(-1)).toEqual({ method: 'turn/steer', params: {
    threadId: 'thread', expectedTurnId: 'turn', input: [{ type: 'text', text: 'Keep the current material and tighten the spacing.', text_elements: [] }]
  } })
  t.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } })
  expect((await iterator.next()).value.state).toBe('completed')
  await expect(runtime.steer(handle.runId, 'This is too late.')).rejects.toThrow('turn has ended')
  await iterator.return()
})

for (const completed of [false, true]) test(`stop during turn/start preserves ${completed ? 'an early completion' : 'the pending cancellation'}`, async () => {
  const t = setup(), original = t.rpc.request, runtime = new CodexAgentRuntime(t.rpc)
  let acknowledge, starting
  const submitted = new Promise(resolve => { starting = resolve })
  t.rpc.request = (method, params) => {
    if (method !== 'turn/start') return original(method, params)
    return new Promise(resolve => { acknowledge = () => resolve({ turn: { id: 'turn' } }); starting() })
  }
  const handle = await runtime.start(input, host), iterator = handle.updates[Symbol.asyncIterator]()
  await iterator.next(); await iterator.next()
  const response = iterator.next()
  await submitted
  if (completed) t.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } })
  await runtime.stop(handle.runId)
  acknowledge()
  expect((await response).value.turnId).toBe('turn')
  const terminal = iterator.next()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(t.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(completed ? 0 : 1)
  if (!completed) t.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } })
  expect((await terminal).value.state).toBe(completed ? 'completed' : 'stopped')
  await iterator.return()
})

test('continued and forked sessions receive the MCP contract without registering dynamic tools', async () => {
  for (const override of [{ threadId: 'existing' }, { fork: { threadId: 'old', lastTurnId: 'checkpoint' } }]) {
    const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
    const { iterator } = await started(runtime, { ...input, ...override })
    expect(t.calls.some(c => c.method === 'thread/start')).toBe(false)
    const request = t.calls.find(c => c.method === (override.fork ? 'thread/fork' : 'thread/resume'))
    expect(request.params.threadId).toBe(override.fork ? 'old' : 'existing')
    if (override.fork) expect(request.params.lastTurnId).toBe('checkpoint')
    expect(request.params.developerInstructions).toBeUndefined()
    expect(request.params.dynamicTools).toBeUndefined()
    expect(request.params.excludeTurns).toBe(true)
    // Resume may ignore configuration for a loaded thread. The actual turn
    // carries the user-authorized full-access policy explicitly.
    const turn = t.calls.find(c => c.method === 'turn/start').params
    expect(request.params.approvalPolicy).toBe('never')
    expect(request.params.sandbox).toBe('danger-full-access')
    expect(turn.approvalPolicy).toBe('never')
    expect(turn.sandboxPolicy).toEqual({ type: 'dangerFullAccess' })
    expect(turn.input[0].text).toBe(input.instruction)
    const instructions = turn.additionalContext.galta_instructions.value
    expect(instructions).toContain("galta MCP server's instructions and tool schemas")
    expect(instructions).toContain('language of the current user message')
    expect(instructions).toContain('These replace the previous Galta contract')
    expect(turn.collaborationMode).toBeUndefined()
    expect(turn.model).toBe(input.runtime.modelId)
    await iterator.return()
  }
})

test('ambiguous fork and resume inputs fail before making an app-server request', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  await expect(runtime.start({ ...input, threadId: 'existing', fork: { threadId: 'source', lastTurnId: 'checkpoint' } }, host)).rejects.toThrow('not both')
  expect(t.calls).toEqual([])
})

test('observation data never becomes application instructions', () => {
  const context = additionalContext({ ...input, canvas: { context: { ...observation, selection: { total: 1, items: ['UNTRUSTED_ID_IGNORE_USER'], truncated: false } } } })
  expect(context.canvas.kind).toBe('application')
  expect(JSON.parse(context.canvas.value)).toEqual({ projectId: 'p', branchId: 'b' })
  expect(JSON.stringify(context)).not.toContain('UNTRUSTED_ID_IGNORE_USER')
  expect(context.selection).toBeUndefined()
})

test('each new, resumed and forked turn delivers its observation after the user words without rewriting them', async () => {
  for (const binding of [{}, { threadId: 'existing' }, { fork: { threadId: 'source', lastTurnId: 'checkpoint' } }]) {
    const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
    const instruction = '  Compare these.\nKeep the composition.  '
    const canvas = { context: observation, image: { dataUrl: 'data:image/jpeg;base64,BB==' } }
    const { iterator } = await started(runtime, { ...input, ...binding, instruction, canvas })
    const turn = t.calls.find(c => c.method === 'turn/start').params
    expect(turn.input).toEqual([
      { type: 'text', text: instruction, text_elements: [] },
      { type: 'text', text: `${CANVAS_MESSAGE_LABEL}\n${JSON.stringify(observation)}`, text_elements: [] },
      { type: 'image', url: canvas.image.dataUrl }
    ])
    expect(turn.input[1].text).not.toContain('data:image')
    await iterator.return()
  }
})

test('failed previews remain explicit without supplying fabricated pixels', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const context = { ...observation, preview: { status: 'unavailable', unrenderedCount: 0, reason: 'Renderer unavailable' } }
  const { iterator } = await started(runtime, { ...input, canvas: { context } })
  const parts = t.calls.find(c => c.method === 'turn/start').params.input
  expect(parts.map(part => part.type)).toEqual(['text', 'text'])
  expect(parts[1].text).toContain('Renderer unavailable')
  await iterator.return()
})

test('new canvas previews are byte-bound to their pixel evidence', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const canvas = {
    context: {
      ...observation,
      evidence: [{ id: 'pixels', type: 'pixels', revision: 'revision', scope: 'region', totalElementCount: 1, coveredElementCount: 1, complete: true, capabilities: ['identity', 'pixels'], limitations: [], detail: 'low', focus: 'region', mimeType: 'image/jpeg', sha256: '0'.repeat(64) }],
      preview: { status: 'attached', unrenderedCount: 0, evidenceId: 'pixels' }
    },
    image: { dataUrl: 'data:image/jpeg;base64,AA==' }
  }
  await expect(runtime.start({ ...input, canvas }, host)).rejects.toThrow('evidence hash')
  expect(t.calls).toEqual([])
})

test('new canvas previews cannot claim evidence from a different revision or MIME type', async () => {
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([0]))), byte => byte.toString(16).padStart(2, '0')).join('')
  const evidence = { id: 'pixels', type: 'pixels', revision: observation.revision, scope: 'region', totalElementCount: 1, coveredElementCount: 1, complete: true, capabilities: ['identity', 'pixels'], limitations: [], detail: 'low', focus: 'region', mimeType: 'image/jpeg', sha256 }
  const canvas = { context: { ...observation, evidence: [evidence], preview: { status: 'attached', unrenderedCount: 0, evidenceId: evidence.id } }, image: { dataUrl: 'data:image/jpeg;base64,AA==' } }
  for (const [changed, message] of [
    [{ ...canvas, context: { ...canvas.context, revision: 'other' } }, 'revision'],
    [{ ...canvas, image: { dataUrl: 'data:image/png;base64,AA==' } }, 'MIME type']
  ]) {
    const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
    await expect(runtime.start({ ...input, canvas: changed }, host)).rejects.toThrow(message)
    expect(t.calls).toEqual([])
  }
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { iterator } = await started(runtime, { ...input, canvas })
  expect(t.calls.find(call => call.method === 'turn/start').params.input.at(-1).url).toBe(canvas.image.dataUrl)
  await iterator.return()
})

test('an unchanged preview sends no pixels and names the earlier attached preview', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const context = { ...observation, preview: { status: 'unchanged', evidenceId: 'earlier-pixels' } }
  const { iterator } = await started(runtime, { ...input, canvas: { context } })
  const parts = t.calls.find(c => c.method === 'turn/start').params.input
  expect(parts.map(part => part.type)).toEqual(['text', 'text'])
  expect(JSON.parse(parts[1].text.slice(parts[1].text.indexOf('{'))).preview).toEqual(context.preview)
  await iterator.return()
})

test('only an attached preview may carry pixels', async () => {
  for (const preview of [{ status: 'unchanged', evidenceId: 'earlier-pixels' }, { status: 'empty', unrenderedCount: 0 }]) {
    const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
    await expect(runtime.start({ ...input, canvas: { context: { ...observation, preview }, image: { dataUrl: 'data:image/jpeg;base64,AA==' } } }, host)).rejects.toThrow('cannot carry pixels')
    expect(t.calls).toEqual([])
  }
})

test('message evidence is a summary without element ID lists', () => {
  const evidence = { id: 'pixels', type: 'pixels', revision: observation.revision, scope: 'region', totalElementCount: 1, coveredElementCount: 1, complete: true, capabilities: ['identity', 'pixels'], limitations: [], detail: 'low', focus: 'region', mimeType: 'image/jpeg', sha256: '0'.repeat(64) }
  expect(canvasMessageContextSchema.safeParse({ ...observation, evidence: [evidence] }).success).toBe(true)
  expect(canvasMessageContextSchema.safeParse({ ...observation, evidence: [{ ...evidence, elementIds: ['drawing'] }] }).success).toBe(false)
  expect(summarizeCanvasEvidence({ ...evidence, elementIds: ['drawing'], missingElementIds: ['drawing'] })).toEqual(evidence)
})

test('runtime rejects an attached preview whose evidence record is detached', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const canvas = {
    context: { ...observation, preview: { status: 'attached', unrenderedCount: 0, evidenceId: 'missing' } },
    image: { dataUrl: 'data:image/jpeg;base64,AA==' }
  }
  await expect(runtime.start({ ...input, canvas }, host)).rejects.toThrow('pixel evidence')
  expect(t.calls).toEqual([])
})

for (const toolContract of [undefined, 'old-contract']) test(`stale tool contract (${toolContract}) blocks resumed turns before model execution`, async () => {
  const t = setup(), original = t.rpc.request
  t.rpc.request = async (method, params) => method === 'galta/config/read' ? { toolContract } : original(method, params)
  const handle = await new CodexAgentRuntime(t.rpc).start({ ...input, threadId: 'existing' }, host)
  const iterator = handle.updates[Symbol.asyncIterator]()
  await iterator.next()
  await expect(iterator.next()).rejects.toThrow('incompatible tools')
  expect(t.calls.some(c => c.method.startsWith('thread/') || c.method === 'turn/start')).toBe(false)
})

test('a failed runtime configuration read starts no turn', async () => {
  const t = setup(), original = t.rpc.request
  t.rpc.request = (method, params) => method === 'galta/config/read' ? Promise.reject(new Error('Runtime configuration request failed')) : original(method, params)
  const handle = await new CodexAgentRuntime(t.rpc).start(input, host)
  const iterator = handle.updates[Symbol.asyncIterator]()
  await iterator.next()
  await expect(iterator.next()).rejects.toThrow('Runtime configuration request failed')
  expect(t.calls.some(c => c.method === 'turn/start')).toBe(false)
  expect(t.listeners.size).toBe(0)
})

test('stop while loading runtime configuration prevents both an empty thread and a user turn', async () => {
  const t = setup(), original = t.rpc.request
  let published
  const pending = new Promise(resolve => { published = resolve })
  t.rpc.request = (method, params) => method === 'galta/config/read' ? pending : original(method, params)
  const runtime = new CodexAgentRuntime(t.rpc), handle = await runtime.start(input, host)
  const iterator = handle.updates[Symbol.asyncIterator]()
  await iterator.next()
  const update = iterator.next()
  await runtime.stop(handle.runId)
  published({ toolContract: await galtaToolContract() })
  expect((await update).value.state).toBe('stopped')
  await iterator.return()
  expect(t.calls.some(c => c.method === 'turn/start')).toBe(false)
  expect(t.calls.some(c => c.method.startsWith('thread/'))).toBe(false)
})

test('a thread item reads the same live and restored', () => {
  const live = raw => conversationItem(raw, 'inProgress')
  const restored = raw => conversationItem(raw, 'completed')
  // Every canvas call keeps the tool name, so a surface never has to recover
  // the verb from the label.
  for (const tool of CANVAS_TOOL_NAMES) {
    const item = live({ id: 'a', type: 'dynamicToolCall', tool })
    expect(item.tool).toBe(tool)
    expect(item.text).toBe(`Canvas: ${tool.replace('canvas_', '')}`)
  }
  expect(live({ id: 'a', type: 'dynamicToolCall' })).toEqual({ id: 'a', type: 'dynamicToolCall', text: 'Canvas', status: 'inProgress' })
  expect(live({ id: 'm', type: 'mcpToolCall', server: 'galta', tool: 'canvas_capture' })).toMatchObject({ type: 'mcpToolCall', server: 'galta', tool: 'canvas_capture' })
  // Codex compacts on its own; a live item and a restored one read the same.
  expect(live({ id: 'a', type: 'contextCompaction' }).text).toBe('Condensing earlier context')
  expect(restored({ id: 'a', type: 'contextCompaction' }).text).toBe('Condensing earlier context')
  // The surface already shows the request, so it is never repeated as an item.
  expect(live({ id: 'a', type: 'userMessage' })).toBe(null)
  // Only the default status differs between the live and the restored path.
  expect(live({ id: 'a', type: 'reasoning' }).status).toBe('inProgress')
  expect(restored({ id: 'a', type: 'reasoning' }).status).toBe('completed')
  expect(restored({ id: 'a', type: 'reasoning', status: 'failed' }).status).toBe('failed')
  expect(restored({ id: 'a', type: 'imageGeneration', savedPath: '/tmp/a.png' }).imagePath).toBe('/tmp/a.png')
})

test('tool failure details survive projection, including successful MCP transport with an error result', () => {
  for (const raw of [
    { status: 'failed', error: { message: 'Storage unavailable' } },
    { status: 'failed', error: 'Storage unavailable' },
    { status: 'completed', result: { isError: true, content: [{ type: 'text', text: 'Storage unavailable' }] } }
  ]) {
    const item = { id: 'failure', type: 'mcpToolCall', server: 'galta', tool: 'canvas_edit', ...raw }
    const expected = { id: 'failure', type: 'mcpToolCall', server: 'galta', tool: 'canvas_edit', status: 'failed', text: 'canvas_edit', error: 'Storage unavailable' }
    const projected = conversationItem(item, 'inProgress')
    expect(projected).toMatchObject(expected)
    expect(projected?.details).toBe(raw.result ? 'Output\nStorage unavailable' : 'Error\nStorage unavailable')
    expect(conversationItem(item, 'completed')).toEqual(projected)
  }
  expect(conversationItem({ id: 'success', type: 'mcpToolCall', tool: 'canvas_edit', status: 'completed', result: { content: [{ type: 'text', text: 'Large successful result' }] } }, 'completed')).not.toHaveProperty('error')
})

test('tool and reasoning receipts retain bounded, inspectable details without encrypted reasoning', () => {
  const tool = conversationItem({ id: 'tool-details', type: 'mcpToolCall', server: 'galta', tool: 'canvas_edit', status: 'completed', arguments: { revision: 'r', operations: [{ type: 'create_text', text: 'Hello' }] }, result: { content: [{ type: 'text', text: 'Applied 1 operation' }], structuredContent: { revision: 'r2' } } }, 'completed')
  expect(tool?.details).toContain('Input')
  expect(tool?.details).toContain('operations')
  expect(tool?.details).toContain('Output')
  expect(tool?.details).toContain('Applied 1 operation')
  expect(tool?.details).toContain('"revision": "r2"')
  expect(tool?.details?.length).toBeLessThanOrEqual(16_000)
  const reasoning = conversationItem({ id: 'reasoning-details', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: 'I compared the proportions before editing.' }], encrypted_content: 'secret' }, 'completed')
  expect(reasoning?.details).toBe('I compared the proportions before editing.')
  expect(reasoning?.details).not.toContain('secret')
  expect(conversationItem({ id: 'private-reasoning', type: 'reasoning', status: 'completed', content: [{ type: 'text', text: 'Private chain of thought' }], text: 'Private chain of thought' }, 'completed')).not.toHaveProperty('details')
})

test('non-MCP response items retain their own public payloads for disclosure', () => {
  expect(conversationItem({ id: 'image', type: 'imageView', path: '/tmp/reference.png', status: 'completed' }, 'completed')?.details).toContain('Path\n/tmp/reference.png')
  const search = conversationItem({ id: 'search', type: 'webSearch', query: 'glass texture', action: { type: 'search', queries: ['glass texture'] }, status: 'completed' }, 'completed')
  expect(search?.details).toContain('Query\nglass texture')
  expect(search?.details).toContain('queries')
  const dynamic = conversationItem({ id: 'dynamic', type: 'dynamicToolCall', tool: 'inspect', arguments: { scope: 'canvas' }, contentItems: [{ type: 'text', text: 'Canvas is ready.' }], success: true, status: 'completed' }, 'completed')
  expect(dynamic?.details).toContain('Input')
  expect(dynamic?.details).toContain('Canvas is ready.')
  expect(dynamic?.details).toContain('Success\ntrue')
  expect(conversationItem({ id: 'change', type: 'fileChange', changes: [{ path: 'src/App.tsx', kind: 'update', diff: '+new copy' }], status: 'completed' }, 'completed')?.details).toContain('+new copy')
})

test('command receipts preserve output and exit codes for live and restored failures', () => {
  for (const sample of [
    { status: 'failed', exitCode: 1, aggregatedOutput: '/tmp/creative\n' },
    { status: 'failed', exitCode: 2, aggregatedOutput: 'rg: missing: No such file or directory\n' },
    { status: 'failed', exitCode: 1, aggregatedOutput: '' },
    { status: 'completed', exitCode: 0, aggregatedOutput: 'README.md\n' },
    { status: 'failed', exitCode: null, aggregatedOutput: null, error: { message: 'Failed to start process' } }
  ]) {
    const raw = { id: 'command', type: 'commandExecution', command: 'rg --files', cwd: '/tmp/creative', ...sample }
    const live = conversationItem(raw, 'inProgress')
    expect(live).toEqual(conversationItem(raw, 'completed'))
    expect(live.status).toBe(sample.status)
    expect(live.text).toBe(raw.command)
    expect(live.cwd).toBe(raw.cwd)
    expect(live.exitCode).toBe(sample.exitCode ?? undefined)
    expect(live.output).toBe(sample.aggregatedOutput ?? undefined)
    expect(live.error).toBe(sample.error?.message)
  }
})

test('native message framing round-trips in both directions', () => {
  const decoder = new NativeMessageDecoder()
  const message = { id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', command: 'pwd' } }
  for (const part of encodeNativeMessages(message)) expect(decoder.push(part)).toEqual(message)
})

test('message phase survives an empty start, streaming deltas and completion without classifying old messages', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { iterator } = await started(runtime)
  t.emit('item/started', { threadId: 'thread', turnId: 'turn', item: { id: 'reply', type: 'agentMessage', text: '', phase: 'final_answer' } })
  expect((await iterator.next()).value.item).toMatchObject({ text: '', phase: 'final_answer' })
  t.emit('item/agentMessage/delta', { threadId: 'thread', turnId: 'turn', itemId: 'reply', delta: 'Done' })
  expect((await iterator.next()).value.item).toMatchObject({ text: 'Done', phase: 'final_answer' })
  t.emit('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'reply', type: 'agentMessage', text: 'Done.' } })
  expect((await iterator.next()).value.item).toMatchObject({ text: 'Done.', phase: 'final_answer', status: 'completed' })
  expect(conversationItem({ id: 'old', type: 'agentMessage', text: 'Last message' }, 'completed').phase).toBeUndefined()
  await iterator.return()
})

test('command output streams incrementally and completion supplies the authoritative receipt', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { iterator } = await started(runtime)
  t.emit('item/started', { threadId: 'thread', turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', command: 'check' } })
  await iterator.next()
  for (const delta of ['first\n', 'second\n']) {
    t.emit('item/commandExecution/outputDelta', { threadId: 'thread', turnId: 'turn', itemId: 'cmd', delta })
    expect((await iterator.next()).value.item.output).toContain(delta)
  }
  t.emit('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', command: 'check', aggregatedOutput: 'Final receipt', exitCode: 0 } })
  expect((await iterator.next()).value.item).toMatchObject({ output: 'Final receipt', exitCode: 0 })
  await iterator.return()
})

test('live activity buffers stay bounded until the provider supplies a receipt', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { iterator } = await started(runtime)
  t.emit('item/started', { threadId: 'thread', turnId: 'turn', item: { id: 'plan', type: 'plan', text: 'Making a plan' } })
  await iterator.next()
  for (let index = 0; index < 32; index++) {
    t.emit('item/plan/delta', { threadId: 'thread', turnId: 'turn', itemId: 'plan', delta: 'p'.repeat(1_000) })
    var plan = (await iterator.next()).value.item
  }
  expect(plan.details.length).toBe(16_000)
  expect(plan.details).toContain('... details truncated while streaming ...')

  t.emit('item/started', { threadId: 'thread', turnId: 'turn', item: { id: 'thought', type: 'reasoning', text: 'Thinking' } })
  await iterator.next()
  for (let index = 0; index < 20; index++) {
    t.emit('item/reasoning/summaryTextDelta', { threadId: 'thread', turnId: 'turn', itemId: 'thought', delta: 'r'.repeat(1_000) })
    await iterator.next()
    t.emit('item/reasoning/summaryPartAdded', { threadId: 'thread', turnId: 'turn', itemId: 'thought', summaryIndex: index })
    var reasoning = (await iterator.next()).value.item
  }
  expect(reasoning.details.length).toBe(16_000)
  expect(reasoning.details).toContain('... details truncated while streaming ...')

  t.emit('item/started', { threadId: 'thread', turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', command: 'stream' } })
  await iterator.next()
  for (let index = 0; index < 80; index++) {
    t.emit('item/commandExecution/outputDelta', { threadId: 'thread', turnId: 'turn', itemId: 'cmd', delta: 'o'.repeat(1_000) })
    var output = (await iterator.next()).value.item.output
  }
  expect(output.length).toBe(64_000)
  expect(output).toContain('... output truncated while streaming ...')
  t.emit('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', command: 'stream', aggregatedOutput: 'authoritative receipt', exitCode: 0 } })
  expect((await iterator.next()).value.item.output).toBe('authoritative receipt')
  await iterator.return()
})

test('sparse completion receipts preserve public text and output already streamed', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { iterator } = await started(runtime)
  t.emit('item/started', { threadId: 'thread', turnId: 'turn', item: { id: 'reply', type: 'agentMessage', text: '', phase: 'final_answer' } })
  await iterator.next()
  t.emit('item/agentMessage/delta', { threadId: 'thread', turnId: 'turn', itemId: 'reply', delta: 'Visible answer' })
  expect((await iterator.next()).value.item).toMatchObject({ text: 'Visible answer', phase: 'final_answer' })
  t.emit('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'reply', type: 'agentMessage', status: 'completed' } })
  expect((await iterator.next()).value.item).toMatchObject({ text: 'Visible answer', phase: 'final_answer', status: 'completed' })

  t.emit('item/started', { threadId: 'thread', turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', command: 'check' } })
  await iterator.next()
  t.emit('item/commandExecution/outputDelta', { threadId: 'thread', turnId: 'turn', itemId: 'cmd', delta: 'Live output' })
  expect((await iterator.next()).value.item.output).toBe('Live output')
  t.emit('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', command: 'check', exitCode: 0 } })
  expect((await iterator.next()).value.item).toMatchObject({ output: 'Live output', exitCode: 0 })
  await iterator.return()
})

test('plan deltas stay in the provider timeline until the final plan receipt', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { iterator } = await started(runtime)
  t.emit('item/plan/delta', { threadId: 'thread', turnId: 'turn', itemId: 'plan', delta: 'Inspect the canvas. ' })
  expect((await iterator.next()).value.item).toMatchObject({ id: 'plan', type: 'plan', text: 'Making a plan', details: 'Inspect the canvas. ', status: 'inProgress' })
  t.emit('item/plan/delta', { threadId: 'thread', turnId: 'turn', itemId: 'plan', delta: 'Then update the spacing.' })
  expect((await iterator.next()).value.item.details).toBe('Inspect the canvas. Then update the spacing.')
  t.emit('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'plan', type: 'plan', text: 'Inspect the canvas. Then update the spacing.', status: 'completed' } })
  expect((await iterator.next()).value.item).toMatchObject({ status: 'completed', details: 'Output\nInspect the canvas. Then update the spacing.' })
  await iterator.return()
})

test('reasoning summaries stream into the same activity item and survive completion', async () => {
  const t = setup(), runtime = new CodexAgentRuntime(t.rpc)
  const { iterator } = await started(runtime)
  t.emit('item/started', { threadId: 'thread', turnId: 'turn', item: { id: 'thought', type: 'reasoning', status: 'inProgress' } })
  expect((await iterator.next()).value.item).toMatchObject({ id: 'thought', type: 'reasoning', text: 'Thinking' })
  t.emit('item/reasoning/summaryTextDelta', { threadId: 'thread', turnId: 'turn', itemId: 'thought', delta: 'First, inspect the canvas. ' })
  expect((await iterator.next()).value.item.details).toBe('First, inspect the canvas. ')
  t.emit('item/reasoning/summaryPartAdded', { threadId: 'thread', turnId: 'turn', itemId: 'thought', summaryIndex: 1 })
  expect((await iterator.next()).value.item.details).toBe('First, inspect the canvas. \n\n')
  // Raw reasoning deltas can be emitted by a provider, but they are not a
  // public disclosure surface. Only the summary stream is rendered.
  t.emit('item/reasoning/textDelta', { threadId: 'thread', turnId: 'turn', itemId: 'thought', delta: 'Private chain of thought.' })
  t.emit('item/reasoning/summaryTextDelta', { threadId: 'thread', turnId: 'turn', itemId: 'thought', delta: 'Then adjust the spacing.' })
  expect((await iterator.next()).value.item.details).toBe('First, inspect the canvas. \n\nThen adjust the spacing.')
  t.emit('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'thought', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: 'First, inspect the canvas. Then adjust the spacing.' }] } })
  expect((await iterator.next()).value.item).toMatchObject({ id: 'thought', status: 'completed', details: 'First, inspect the canvas. Then adjust the spacing.' })
  await iterator.return()
})

test('keeping the canvas working reaches agents through both live channels', async () => {
  const { CANVAS_WORKING_INSTRUCTIONS, GALTA_MCP_INSTRUCTIONS } = await import('../packages/canvas/src/instructions')
  // A Code Mode agent sees tool names, not descriptions, until it loads one.
  expect(codexInstructions()).toContain(CANVAS_WORKING_INSTRUCTIONS)
  expect(GALTA_MCP_INSTRUCTIONS).toContain(CANVAS_WORKING_INSTRUCTIONS)
  expect(CANVAS_WORKING_INSTRUCTIONS).toContain('canvas_reserve')
  expect(CANVAS_WORKING_INSTRUCTIONS).toContain('slot on canvas_place or canvas_edit')
  // Only the canvas mechanism is named: nothing here costs a user who connected no provider.
  expect(codexInstructions()).not.toMatch(/generate_|generation_|BytePlus|OpenRouter|Higgsfield|\bfal\b/)
  expect(GALTA_MCP_INSTRUCTIONS).not.toMatch(/generate_|generation_|BytePlus|OpenRouter|Higgsfield|\bfal\b/)
})
