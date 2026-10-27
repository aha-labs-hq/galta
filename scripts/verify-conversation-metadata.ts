import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexMetadata, type CodexRpcClient, type CodexJsonRpcNotification } from '../packages/runtime/src/index'

// Real installed protocol, isolated state, deterministic local model responses.
const executable = process.env.GALTA_CODEX_BIN ?? Bun.which('codex')
if (!executable) throw new Error('Install Codex or set GALTA_CODEX_BIN')
const directory = await mkdtemp(join(tmpdir(), 'galta-metadata-')), cwd = join(directory, 'workspace')
await mkdir(cwd)
const skillDirectory = join(cwd, '.agents', 'skills', 'naming-isolation-fixture')
await mkdir(skillDirectory, { recursive: true })
await writeFile(join(skillDirectory, 'SKILL.md'), '---\nname: naming-isolation-fixture\ndescription: NAMING_SKILL_MUST_NOT_LEAK\n---\nUnrelated fixture skill.\n')
await writeFile(join(cwd, 'AGENTS.md'), 'NAMING_PROJECT_INSTRUCTIONS_MUST_NOT_LEAK\n')
const mcpCommand = join(directory, 'mcp-must-not-start'), mcpMarker = join(directory, 'mcp-started')
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
await writeFile(mcpCommand, `#!/bin/sh\n: > ${shellQuote(mcpMarker)}\nexit 1\n`, { mode: 0o700 })
await mkdir(join(cwd, '.codex'))
await writeFile(join(cwd, '.codex', 'config.toml'), `[mcp_servers.'project.search']\ncommand=${JSON.stringify(mcpCommand)}\nrequired=true\n`)
const requests: any[] = []
let mcpRequests = 0
const names = { conversationTitle: 'Poster composition', canvasTitle: 'Summer exhibition' }
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (new URL(request.url).pathname === '/mcp') { mcpRequests++; return new Response('MCP must remain disabled', { status: 503 }) }
  if (request.method !== 'POST') return Response.json({ data: [] })
  const body = await request.json() as any
  requests.push(body)
  const text = JSON.stringify(names)
  const item = { type: 'message', id: `msg_${crypto.randomUUID()}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  const response = { id: `resp_${crypto.randomUUID()}`, object: 'response', created_at: 1, model: 'fixture', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
} })
await writeFile(join(directory, 'config.toml'), `model='fixture'\nmodel_provider='fixture'\n[features]\ncode_mode_only=true\n[projects.${JSON.stringify(cwd)}]\ntrust_level='trusted'\n[mcp_servers.'docs.search']\ncommand=${JSON.stringify(mcpCommand)}\nrequired=true\n[mcp_servers.'remote.search']\nurl='http://127.0.0.1:${server.port}/mcp'\nrequired=true\n[model_providers.fixture]\nname='Fixture'\nbase_url='http://127.0.0.1:${server.port}/v1'\nwire_api='responses'\nrequires_openai_auth=false\nsupports_websockets=false\n`)
const child = Bun.spawn([executable, 'app-server', '--stdio', '-c', `mcp_servers.must_not_start.command=${JSON.stringify(mcpCommand)}`, '-c', 'mcp_servers.must_not_start.required=true'], { env: { ...Bun.env, CODEX_HOME: directory, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'galta' }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
const errors = new Response(child.stderr).text(), pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
const listeners = new Set<(message: CodexJsonRpcNotification) => void>()
let id = 0
const send = (message: unknown) => { child.stdin.write(JSON.stringify(message) + '\n') }
const rpc: CodexRpcClient = {
  request(method, params) { const key = ++id; return new Promise((resolve, reject) => { pending.set(key, { resolve, reject }); send({ id: key, method, params }) }) },
  async respond(id, result, error) { send({ id, ...(error ? { error } : { result }) }) },
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }
}
const reading = (async () => {
  let buffer = ''; const decoder = new TextDecoder()
  for await (const bytes of child.stdout) {
    buffer += decoder.decode(bytes, { stream: true })
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      if (message.id !== undefined && !message.method) {
        const callback = pending.get(message.id); pending.delete(message.id)
        message.error ? callback?.reject(new Error(JSON.stringify(message.error))) : callback?.resolve(message.result)
      } else for (const listener of listeners) listener(message)
    }
  }
  for (const callback of pending.values()) callback.reject(new Error('App-server closed'))
})()
const timeout = setTimeout(() => child.kill(), 60_000)
try {
  await rpc.request('initialize', { clientInfo: { name: 'galta', version: 'metadata-verification' }, capabilities: { experimentalApi: true } }); send({ method: 'initialized' })
  const metadata = new CodexMetadata(rpc)
  const project = await metadata.project('canvas', cwd)
  assert.equal((await metadata.project('canvas', cwd)).id, project.id)
  await metadata.updateProject(project.id, 'My canvas', cwd)
  assert.equal((await metadata.project('canvas', cwd, project.id)).name, 'My canvas')
  await assert.rejects(metadata.project('another-canvas', cwd, project.id), /this canvas project/)
  assert.deepEqual(await metadata.generate({ instruction: 'Design the summer exhibition poster', reply: 'Created a composition.', canvasTitle: 'Untitled canvas', nameCanvas: true, cwd, model: 'fixture' }, new AbortController().signal), names)
  assert.equal(requests.length, 1)
  assert.equal(mcpRequests, 0)
  await assert.rejects(access(mcpMarker), { code: 'ENOENT' }, 'Disabled stdio servers must not launch')
  const inherited = (await rpc.request('config/read', { cwd, includeLayers: false }) as any).config
  assert.equal(inherited.features.code_mode_only, true, 'Naming must not change process configuration')
  for (const name of ['must_not_start', 'docs.search', 'remote.search', 'project.search']) assert.equal(inherited.mcp_servers[name].required, true)
  const namingPayload = JSON.stringify(requests[0])
  for (const unrelated of ['NAMING_SKILL_MUST_NOT_LEAK', 'NAMING_PROJECT_INSTRUCTIONS_MUST_NOT_LEAK', 'Available skills', '<skills_instructions>', '<environment_context>', '<permissions instructions>', '<collaboration_mode>']) {
    assert(!namingPayload.includes(unrelated), `Naming inherited unrelated context: ${unrelated}`)
  }
  const utilityTools = requests[0].tools.map((tool: any) => tool.name ?? tool.type)
  assert.deepEqual(utilityTools, ['request_user_input'], 'Naming must expose no file, execution, browsing or goal tools; host rejects interaction requests')
  assert.equal(requests[0].text.format.type, 'json_schema')
  const list = await rpc.request('thread/list', { limit: 100 }) as any
  assert.equal(list.data.length, 0, 'Ephemeral naming must not appear in history')
  const started = await rpc.request('thread/start', { cwd, model: 'fixture', ephemeral: false, config: { mcp_servers: { must_not_start: { command: mcpCommand, enabled: false, required: false }, 'docs.search': { command: mcpCommand, enabled: false, required: false }, 'remote.search': { url: `http://127.0.0.1:${server.port}/mcp`, enabled: false, required: false }, 'project.search': { command: mcpCommand, enabled: false, required: false } } } }) as any
  const threadId = started.thread.id
  // Establish a durable user thread before checking metadata publication.
  const completed = new Promise<void>(resolve => {
    const unsubscribe = rpc.subscribe(n => { if (n.method === 'turn/completed' && n.params?.threadId === threadId) { unsubscribe(); resolve() } })
  })
  await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Fixture user request', text_elements: [] }] }); await completed
  const ordinaryPayload = JSON.stringify(requests[1])
  const ordinaryTools = requests[1].tools.map((tool: any) => tool.name ?? tool.type)
  assert.equal(mcpRequests, 0)
  await assert.rejects(access(mcpMarker), { code: 'ENOENT' })
  assert(ordinaryTools.includes('exec') && ordinaryTools.includes('wait'), 'Normal agent retains the inherited Code Mode configuration')
  assert(ordinaryPayload.includes('NAMING_SKILL_MUST_NOT_LEAK'), 'Normal agent still receives its skills')
  assert(ordinaryPayload.includes('NAMING_PROJECT_INSTRUCTIONS_MUST_NOT_LEAK'), 'Normal agent still receives project instructions')
  await metadata.assignThread(threadId, project.id)
  await metadata.nameThread(threadId, 'My conversation')
  const restored = (await rpc.request('thread/read', { threadId, includeTurns: true }) as any).thread
  assert.equal(restored.projectId, project.id); assert.equal(restored.name, 'My conversation'); assert.equal(restored.turns.length, 1)
  await rpc.request('thread/archive', { threadId })
  await assert.rejects(metadata.nameThread(threadId, 'Archived name'), /no rollout found/)
  assert((await metadata.archivedThreads(cwd, new AbortController().signal)).has(threadId), 'Archived history remains discoverable through the public API')
  assert.equal((await rpc.request('thread/read', { threadId, includeTurns: true }) as any).thread.turns.length, 1)
  await rpc.request('thread/unarchive', { threadId })
  assert(!(await metadata.archivedThreads(cwd, new AbortController().signal)).has(threadId))
  await metadata.nameThread(threadId, 'Restored conversation')
  assert.equal((await rpc.request('thread/read', { threadId }) as any).thread.name, 'Restored conversation')
  const version = Bun.spawn([executable, '--version'], { stdout: 'pipe' })
  const codexVersion = (await new Response(version.stdout).text()).trim(); assert.equal(await version.exited, 0)
  const receipt = { passed: true, codexVersion, directory, localResponsesFixture: true, realModel: false, idempotentProject: true, threadAssignment: true, archivedNameWriteRejected: true, archivedHistoryReadable: true, restoredNameWritable: true, ephemeralNamingHidden: true, namingTools: utilityTools, namingContextIsolated: true, mainAgentContextPreserved: true, inheritedCodeModeIsolated: true, dottedMcpNameDisabled: true, stdioAndHttpMcpDisabled: true, workspaceMcpDisabled: true, inheritedProcessConfigPreserved: true }
  await writeFile(join(directory, 'model-requests.json'), JSON.stringify(requests))
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(receipt, null, 2))
} finally {
  clearTimeout(timeout); child.stdin.end(); child.kill(); await child.exited; await reading; server.stop(true)
  await writeFile(join(directory, 'stderr.txt'), await errors)
}
