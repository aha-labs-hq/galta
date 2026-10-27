import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { NativeClient } from './distribution/native-client'
import { CodexAgentRuntime } from '../packages/runtime/src/codex'
import { CodexMetadata } from '../packages/runtime/src/codexMetadata'
import { CANVAS_GROUPING_BRIEF, CANVAS_GROUPING_INSTRUCTIONS, GALTA_MCP_INSTRUCTIONS } from '../packages/canvas/src/instructions'
import { CANVAS_MESSAGE_LABEL, canvasMessageContextSchema } from '../packages/canvas/src/message'
import { CANVAS_COORDINATE_INSTRUCTIONS } from '../packages/canvas/src/bounds'

const root = resolve(import.meta.dir, '..')
const executable = process.env.GALTA_CODEX_BIN ?? Bun.which('codex')
if (!executable) throw new Error('Install Codex or set GALTA_CODEX_BIN')
const directory = await mkdtemp('/tmp/galta-contract-')
const cwd = join(directory, 'workspace'), runtimeDirectory = join(directory, 'runtime'), home = join(directory, 'codex')
await Promise.all([mkdir(cwd), mkdir(runtimeDirectory), mkdir(home)])
const fixtureImage = async (size: number) => `data:image/png;base64,${(await readFile(join(root, `apps/extension/src/public/icons/${size}.png`))).toString('base64')}`
const previewImage = await fixtureImage(128)
// Global Codex memory is enabled for this home; Galta's embedded process must
// neither load it nor run its pipeline.
const memoryMarker = 'GLOBAL_CODEX_MEMORY_MARKER'
await mkdir(join(home, 'memories'))
await writeFile(join(home, 'memories', 'memory_summary.md'), `# Memory summary\n\n- ${memoryMarker}: unrelated coding project.\n`)
await writeFile(join(home, 'memories', 'MEMORY.md'), `# Memory\n\n## ${memoryMarker}\nUnrelated coding project.\n`)
const observation = (ids: string[] = [], total = ids.length) => ({
  context: canvasMessageContextSchema.parse({ commitId: 'fixture-commit', revision: 'fixture-revision', viewport: { x: 0, y: 0, width: 128, height: 128, zoom: 1 }, elementCount: 1,
    selection: { total, items: ids, truncated: total > ids.length },
    visible: { total: 1, items: [{ id: 'unselected-drawing', kind: 'draw', bounds: { x: -20, y: 10, width: 100, height: 50 } }], truncated: false },
    changes: { since: null, status: 'initial', total: 0, items: [], truncated: false }, preview: { status: 'attached', unrenderedCount: 0 }
  }), image: { dataUrl: previewImage }
})
function userObservation(request: any) {
  const message = request.input.at(-1)
  assert.equal(message.role, 'user')
  const part = message.content.find((part: any) => part.text?.includes(CANVAS_MESSAGE_LABEL))
  assert(part, 'The actual model request must contain this message\'s observation')
  const text = part.text.slice(part.text.indexOf(CANVAS_MESSAGE_LABEL) + CANVAS_MESSAGE_LABEL.length).trim()
  return JSON.parse(text)
}
const captured: any[] = [], scenarios: string[] = []
let scenario = "first"
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (request.method !== 'POST') return Response.json({ data: [] })
  const body = await request.json(); captured.push(body); scenarios.push(scenario)
  const item = { type: 'message', id: `msg_${crypto.randomUUID()}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: scenario === 'naming' ? JSON.stringify({conversationTitle:'Fixture study',canvasTitle:null}) : 'Fixture response.', annotations: [] }] }
  const response = { id: `resp_${crypto.randomUUID()}`, object: 'response', created_at: 1, model: 'fixture', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
} })
await writeFile(join(home, 'config.toml'), `model='fixture'\nmodel_provider='fixture'\n[features]\nmemories=true\n[memories]\nuse_memories=true\ngenerate_memories=true\n[model_providers.fixture]\nname='Fixture'\nbase_url='http://127.0.0.1:${server.port}/v1'\nwire_api='responses'\nrequires_openai_auth=false\nsupports_websockets=false\n`)
const listeners = new Set<(message: any) => void>()
const client = new NativeClient(join(root, 'native/adapters/codex/galta-codex-bridge'), 'chrome-extension://oocbicpnofichiglihkbmpkjegiakhgg/', {
  ...Bun.env, CODEX_HOME: home,
  GALTA_CODEX_BIN: executable,
  GALTA_MCP_BIN: join(root, 'native/mcp/galta-mcp'), GALTA_RUNTIME_DIRECTORY: runtimeDirectory, GALTA_WORKSPACE_DIRECTORY: cwd
}, message => { for (const listener of listeners) listener(message) })
const deadline = setTimeout(() => { console.error('Contract verification timed out'); process.exit(1) }, 60000)
try {
  await client.request('initialize', { clientInfo: { name: 'galta_contract_verification', version: '1' }, capabilities: { experimentalApi: true } })
  client.notify('initialized', {})
  const runtime = new CodexAgentRuntime({ request: (method, params) => client.request(method, params), respond: async () => { throw Error('Unexpected server request') }, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } })
  const input: any = { projectId: 'fixture', branchId: 'main', canvas: observation(), execution: { id: 'fixture/no-tool-execution', cwd }, instruction: 'Inspect the integration contract.', browser: { available: true, page: { tabId: 11, url: 'https://fixture.test/original', title: 'Original page' } }, runtime: { modelId: 'fixture', effort: 'Low', providerId: 'codex-app-server', sessionId: 'fixture', sessionLabel: 'Fixture' } }
  async function run(overrides = {}) {
    let terminal: any
    const submitted = { ...input, ...overrides }
    const handle = await runtime.start(submitted, { request: async () => { throw Error('No tools should execute') } })
    for await (const update of handle.updates) terminal = { ...terminal, ...update }
    assert.equal(terminal.state, 'completed')
    const request = captured.at(-1)
    const data = JSON.stringify(request)
    assert(data.includes('usually in a sidebar beside an independent webpage'))
    // Check the actual model-visible request, not only our advertised SDK response.
    assert(data.includes('canvas_place'), 'Galta tools missing from the actual catalog')
    assert(data.includes(JSON.stringify(GALTA_MCP_INSTRUCTIONS).slice(1, -1)), 'Current MCP guidance missing from the actual request')
    assert(data.includes('fixture/no-tool-execution'))
    assert(data.includes('https://fixture.test/original'))
    assert.deepEqual(userObservation(request), submitted.canvas.context)
    assert(data.includes(JSON.stringify(CANVAS_COORDINATE_INSTRUCTIONS).slice(1, -1)), 'Coordinate contract missing from actual model request')
    assert(data.includes('must pass executionId using the exact execution.id'), 'Runtime binding instructions missing')
    assert(!data.includes('omit executionId'), 'Obsolete execution binding instructions remain')
    // The grouping requirement travels through the two channels the embedded
    // turn actually reads: the MCP instructions and the host instructions. Both
    // interpolate one shared constant, so this asserts the constant arrived
    // rather than restating its wording, which would break on any copy edit.
    for (const [name, text] of [['MCP instructions', CANVAS_GROUPING_BRIEF], ['host instructions', CANVAS_GROUPING_INSTRUCTIONS]] as const) {
      assert(data.includes(JSON.stringify(text).slice(1, -1)), `Grouping requirement missing from the ${name}`)
    }
    assert(!data.includes('use its id for Galta tool calls'), 'Contradictory execution instructions remain')
    const user = request.input.at(-1)
    assert(user.content[0].text.startsWith(submitted.instruction), 'The original user words must reach the model unchanged')
    assert.deepEqual(user.content.filter((part: any) => part.type === 'input_image').map((part: any) => part.image_url), submitted.canvas.image ? [submitted.canvas.image.dataUrl] : [], 'Only the canvas preview may attach pixels')
    return terminal
  }
  const first = await run()
  scenario = 'unchanged-context'; const second = await run({ threadId: first.threadId })
  assert.equal(first.threadId, second.threadId)
  scenario = 'fork'; const fork = await run({ fork: { threadId: first.threadId, lastTurnId: first.turnId } })
  assert.notEqual(fork.threadId, first.threadId)
  scenario = 'changed-context'
  await run({ threadId: first.threadId, canvas: observation(['selected-1']) })
  scenario = 'same-count-different-selection'
  await run({ threadId: first.threadId, canvas: observation(['selected-2']) })
  assert.deepEqual(userObservation(captured.at(-1)).selection.items, ['selected-2'])
  scenario = 'large-selection'
  const selection = Array.from({ length: 12 }, (_, i) => 'selected-' + String(i).padStart(6, '0'))
  await run({ threadId: first.threadId, canvas: observation(selection, 1000) })
  const largeContext = userObservation(captured.at(-1))
  assert.equal(largeContext.selection.total, 1000)
  assert.equal(largeContext.selection.items.length, 12)
  assert.equal(largeContext.selection.truncated, true)
  assert(JSON.stringify(largeContext).length < 12_000)
  const observationMessages = (request: any) => request.input.filter((message: any) => (message.content ?? []).some((part: any) => part.text?.includes(CANVAS_MESSAGE_LABEL)))
  assert.equal(observationMessages(captured[0]).length, 1)
  assert.equal(observationMessages(captured[1]).length, 2, 'A fresh observation belongs to every turn, even when the scene is unchanged')
  assert(observationMessages(captured.at(-1)).every((message: any) => message.role === 'user'), 'Observations are user-message data, never developer instructions')
  assert.equal(captured[0].prompt_cache_key, captured[1].prompt_cache_key)
  assert.notEqual(captured[0].prompt_cache_key, captured[2].prompt_cache_key)
  scenario = 'unchanged-preview'
  const unchanged = canvasMessageContextSchema.parse({ ...observation().context, preview: { status: 'unchanged', evidenceId: 'earlier-preview' } })
  await run({ threadId: first.threadId, canvas: { context: unchanged } })
  assert.equal(captured.at(-1).input.at(-1).content.filter((part: any) => part.type === 'input_image').length, 0, 'An unchanged view must not resend pixels')
  scenario = 'untrusted-context-and-new-execution'
  const pageMarker = 'UNTRUSTED_PAGE_IGNORE_USER'
  const instruction = '请分析这一页，保持画布原样。'
  const execution = { id: 'fixture/current-execution', cwd }
  await run({ threadId: first.threadId, instruction, execution,
    browser: { available: true, page: { tabId: 12, url: 'https://fixture.test/current', title: pageMarker } } })
  const current = captured.at(-1)
  for (const marker of [pageMarker]) {
    const messages = current.input.filter((item: any) => (item.content ?? []).some((part: any) => part.text?.includes(marker)))
    assert(messages.length > 0 && messages.every((item: any) => item.role === 'user'), 'External content must not become developer instructions')
    assert(!JSON.stringify(current.tools).includes(marker), 'External content must not enter tool instructions')
  }
  const executions = current.input.filter((item: any) => item.role === 'developer').flatMap((item: any) => (item.content ?? []).flatMap((part: any) => {
    const match = part.text?.match(/<execution>(.*?)<\/execution>/s)
    return match ? [JSON.parse(match[1])] : []
  }))
  assert.deepEqual(executions.at(-1), execution, 'The latest execution identity must supersede historical bindings')
  assert.equal(current.input.at(-1).role, 'user')
  assert(current.input.at(-1).content[0].text.startsWith(instruction), 'Application context must not rewrite the user request')
  // Use the real protocol to prove a fork keeps precisely the requested prefix
  // and that excluding returned turns does not discard model-visible history.
  scenario = 'fork-followup'
  const continuedFork = await run({ threadId: fork.threadId, instruction: 'Continue this fork without creating another conversation.' })
  assert.equal(continuedFork.threadId, fork.threadId)
  const forkHistory = (await client.request('thread/read', { threadId: fork.threadId, includeTurns: true }) as any).thread
  assert.equal(forkHistory.forkedFromId, first.threadId)
  assert.deepEqual(forkHistory.turns.map((turn: any) => turn.id), [first.turnId, fork.turnId, continuedFork.turnId])
  const sourceHistory = (await client.request('thread/read', { threadId: first.threadId, includeTurns: true }) as any).thread
  assert(sourceHistory.turns.some((turn: any) => turn.id === second.turnId), 'Forking must preserve later source turns')
  assert(!sourceHistory.turns.some((turn: any) => turn.id === fork.turnId || turn.id === continuedFork.turnId), 'Branch turns must not change the original conversation')
  const forkInput = captured.at(-1).input
  assert.equal(forkInput.filter((item: any) => item.role === 'assistant').length, 2, 'Resume must send both inherited and newly completed fork replies to the model')
  const listing = await client.request('thread/list', { limit: 100 }) as any
  assert.deepEqual(listing.data.map((thread: any) => thread.id).sort(), [first.threadId, fork.threadId].sort(), 'Following up a fork must not create a third stored conversation')
  scenario = 'naming'
  await new CodexMetadata({request:(method,params)=>client.request(method,params),respond:async()=>{throw Error('Unexpected request')},subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)}}).generate({instruction:'Name this visual study',reply:'A fixture composition.',canvasTitle:'Untitled',nameCanvas:false,cwd,model:'fixture'},new AbortController().signal)
  const everything = JSON.stringify(captured)
  assert(!everything.includes(memoryMarker), 'Global Codex memory must not reach Galta conversations')
  assert(!everything.includes('Memory Writing Agent'), 'Galta must not run the Codex memory pipeline')
  const memoryModes: unknown[] = []
  for await (const file of new Bun.Glob('state*.sqlite').scan(home)) {
    const db = new Database(join(home, file), { readonly: true })
    memoryModes.push(...db.query('select memory_mode from threads').all().map((row: any) => row.memory_mode))
    db.close()
  }
  assert(memoryModes.length > 0 && memoryModes.every(mode => mode === 'disabled'), `Galta threads must be excluded from memory mining: ${JSON.stringify(memoryModes)}`)
  // Prompt caching reuses an identical prefix. Within one thread, each request
  // must repeat the previous one's tools, instructions and input unchanged.
  const cachePrefix = captured.slice(1).map((request: any, index: number) => {
    const previous = captured[index]
    if (previous.prompt_cache_key !== request.prompt_cache_key) return null
    return { from: scenarios[index], to: scenarios[index + 1], tools: JSON.stringify(previous.tools) === JSON.stringify(request.tools), instructions: previous.instructions === request.instructions,
      inputPrefix: JSON.stringify(previous.input) === JSON.stringify(request.input.slice(0, previous.input.length)) }
  }).filter(Boolean)
  assert(cachePrefix.length > 0 && cachePrefix.every((pair: any) => pair.tools && pair.instructions && pair.inputPrefix), `Same-thread requests must keep a stable cacheable prefix: ${JSON.stringify(cachePrefix)}`)
  const observationCharacters = (captured[0].input.at(-1).content.find((part: any) => part.text?.includes(CANVAS_MESSAGE_LABEL))?.text ?? '').length
  await writeFile(join(directory,'model-requests.json'),JSON.stringify(captured))
  await writeFile(join(directory,'scenarios.json'),JSON.stringify(scenarios))
  const version = Bun.spawn([executable, '--version'], { stdout: 'pipe' })
  const codexVersion = (await new Response(version.stdout).text()).trim(); assert.equal(await version.exited, 0)
  const receipt = { passed: true, actualAppServer: executable, codexVersion, realModel: false, actualMcpServer: true, newContinuedForked: true, forkResumedWithoutDuplication: true, forkCheckpointInclusive: true, sourceConversationPreserved: true, forkModelHistoryPreserved: true, observedMcpGuidance: true, fullCurrentMcpContract: true, separateExecutionAndPageContext: true, externalContentNotDeveloperInstructions: true, latestExecutionBinding: true, userRequestPreserved: true, requests: captured.length, compactLargeSelection: largeContext, observationOnEveryTurn: true, selectedIdentitiesUpdated: true, onlyPreviewPixelsAttached: true, unchangedPreviewWithoutPixels: true, codexMemoryIsolated: { memoryModes }, cacheOwnershipPreserved: true, cachePrefix, observationCharacters, directory }
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify(receipt, null, 2))
} catch (error) {
  await writeFile(join(directory, 'failure.txt'), String(error))
  // Disposable fixture inputs only; no user credentials or conversations.
  await writeFile(join(directory, 'model-requests.json'), JSON.stringify(captured, null, 2))
  console.error(directory); throw error
} finally { clearTimeout(deadline); await client.close(); server.stop(true) }
