import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { verifyCanvasWriteDeclaration, verifyCanvasReadDeclaration, verifyBrowserDeclarations } from './lib/canvas-contract-types'
import { CANVAS_TOOLS } from '../packages/canvas/src/tools'

// Capture what the official host actually sends to the model, with isolated
// state and deterministic local responses. No account, paid model or user
// canvas is needed; MCP discovery runs against the source under test.
const executable = process.env.GALTA_CODEX_BIN ?? Bun.which('codex')
if (!executable) throw new Error('Install Codex or set GALTA_CODEX_BIN')
const directory = await mkdtemp(join(tmpdir(), 'galta-canvas-contract-'))
const cwd = join(directory, 'workspace')
await mkdir(cwd)
const requests: any[] = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (request.method !== 'POST') return Response.json({ data: [] })
  requests.push(await request.json())
  const item = { type: 'message', id: `msg_${crypto.randomUUID()}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture response.', annotations: [] }] }
  const response = { id: `resp_${crypto.randomUUID()}`, object: 'response', created_at: 1, model: 'fixture', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
} })
await writeFile(join(directory, 'config.toml'), `model='fixture'
model_provider='fixture'
[mcp_servers.galta]
command=${JSON.stringify(process.execPath)}
args=[${JSON.stringify(resolve(import.meta.dir, '../native/mcp/main.ts'))}]
required=true
[model_providers.fixture]
name='Fixture'
base_url='http://127.0.0.1:${server.port}/v1'
wire_api='responses'
requires_openai_auth=false
supports_websockets=false
`)
const child = Bun.spawn([executable, 'app-server', '--stdio'], { cwd, env: { ...Bun.env, CODEX_HOME: directory, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'galta' }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
const errors = new Response(child.stderr).text()
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
const listeners = new Set<(message: any) => void>()
let id = 0
const send = (message: unknown) => { child.stdin.write(JSON.stringify(message) + '\n') }
function rpc(method: string, params: unknown = {}): Promise<any> {
  const key = ++id
  return new Promise((resolve, reject) => { pending.set(key, { resolve, reject }); send({ id: key, method, params }) })
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
  await rpc('initialize', { clientInfo: { name: 'galta', version: 'canvas-contract-verification' }, capabilities: { experimentalApi: true } })
  send({ method: 'initialized' })
  for (const codeMode of [false, true]) {
    const { thread } = await rpc('thread/start', { cwd, model: 'fixture', ephemeral: true, approvalPolicy: 'never', config: { features: { code_mode_only: codeMode } } })
    const completed = new Promise<void>((resolve, reject) => {
      const listener = (message: any) => {
        if (message.method === 'turn/completed' && message.params?.threadId === thread.id) {
          listeners.delete(listener)
          message.params.turn.status === 'completed' ? resolve() : reject(new Error(JSON.stringify(message.params.turn)))
        }
      }
      listeners.add(listener)
    })
    await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Inspect the available canvas tools. This is a discovery fixture; do not call tools.', text_elements: [] }] })
    await Promise.race([completed, child.exited.then(() => { throw new Error('App-server exited before completing the contract fixture') })])
  }
  await writeFile(join(directory, 'model-requests.json'), JSON.stringify(requests, null, 2))
  assert.equal(requests.length, 2)
  const direct = requests[0].tools.find((tool: any) => tool.name === 'mcp__galta')?.tools.find((tool: any) => tool.name === 'canvas_edit')
  assert(direct, 'Direct canvas_edit missing')
  const branches = (schema: any): any[] => schema.properties?.type ? [schema] :
    ['allOf', 'anyOf', 'oneOf'].flatMap(key => (schema[key] ?? []).flatMap(branches))
  const variants = branches(direct.parameters.properties.operations.items)
  for (const type of ['update_element', 'move', 'delete', 'bind_arrow', 'bind_text']) {
    const variant = variants.find((item: any) => item.properties?.type.enum?.[0] === type)
    assert(variant?.required.includes('elementId'), `${type} target must be required`)
    assert(!('id' in variant.properties), `${type} must not advertise a creation id`)
  }
  const modelTools = requests[0].tools.find((tool: any) => tool.name === 'mcp__galta').tools
  const browserAct = modelTools.find((tool: any) => tool.name === 'browser_act')
  assert(browserAct, 'Direct browser_act missing')
  const actionBranches = (schema: any): any[] => schema.properties?.action ? [schema] :
    ['allOf', 'anyOf', 'oneOf'].flatMap(key => (schema[key] ?? []).flatMap(actionBranches))
  const actions = actionBranches(browserAct.parameters)
  for (const [action, required] of [['click', 'ref'], ['fill', 'ref'], ['fill', 'text'], ['select', 'ref'], ['select', 'text'], ['navigate', 'url']] as const) {
    const variant = actions.find((item: any) => item.properties?.action.enum?.[0] === action)
    assert(variant?.required.includes('snapshotId'), `${action} must require snapshotId`)
    assert(variant?.required.includes(required), `${action} must require ${required}`)
  }
  const scrolls = actions.filter((item: any) => item.properties?.action.enum?.[0] === 'scroll')
  assert.equal(scrolls.length, 2)
  assert(scrolls.every((variant: any) => variant.required.includes('snapshotId') && (variant.required.includes('deltaX') || variant.required.includes('deltaY'))), 'scroll must require deltaX or deltaY')
  assert(browserAct.description.includes('+/-4000'), 'Scroll bounds missing from direct browser_act description')
  const code = JSON.stringify(requests[1])
  assert(requests[1].tools.some((tool: any) => tool.name === 'exec'), 'Code Mode was not enabled')
  assert(code.includes('Integer from 1 to 64'), 'Page bounds missing from model-visible Code Mode')
  const execDescription = requests[1].tools.find((tool: any) => tool.name === 'exec').description
  const declaration = execDescription.split('### `mcp__galta__canvas_edit`')[1].split('### `')[0]
  for (const type of ['create_text', 'create_element', 'update_element', 'move', 'delete', 'bind_arrow', 'bind_text']) assert(declaration.includes(`type: \"${type}\"`), `${type} erased by Code Mode`)
  assert(declaration.includes('elementId: string'), 'Required target identity erased by Code Mode')
  assert(!declaration.includes('elementId?:'), 'Target identity became optional')
  assert(declaration.includes('groupIds?: Array<string>') && declaration.includes('mediaPath?: string'), 'Native/media properties erased by Code Mode')
  assert(!declaration.includes('unknown | unknown'), 'Operation union erased by Code Mode')
  const typeChecks = await verifyCanvasWriteDeclaration(declaration, directory)
  const readDeclaration = execDescription.split('### `mcp__galta__canvas_inspect`')[1].split('### `')[0]
  const readTypeChecks = await verifyCanvasReadDeclaration(readDeclaration, directory)
  await writeFile(join(directory, 'code-mode-canvas-inspect.txt'), readDeclaration)
  const browserDeclaration = execDescription.split('### `mcp__galta__browser_act`')[1].split('### `')[0]
  const captureDeclaration = execDescription.split('### `mcp__galta__browser_capture`')[1].split('### `')[0]
  assert(browserDeclaration.includes('+/-4000'), 'Scroll bounds missing from Code Mode')
  const browserTypeChecks = await verifyBrowserDeclarations(browserDeclaration, captureDeclaration, directory)
  const status = modelTools.find((tool: any) => tool.name === 'canvas_inspect')
  assert(status.parameters.properties.limit.description.includes('1 to 64'), 'Page bounds must be visible even when the host strips maximum')
  for (const tool of CANVAS_TOOLS) assert(tool.outputSchema && typeof tool.outputSchema === 'object', `${tool.name} must declare an output schema at the MCP source`)
  const outputTypeChecks = Object.fromEntries(CANVAS_TOOLS.map(tool => {
    const section = execDescription.split(`### \`mcp__galta__${tool.name}\``)[1]?.split('### `')[0] ?? ''
    const typed = section.includes('Promise<CallToolResult<')
    assert(typed, `${tool.name} output type erased by Code Mode`)
    return [tool.name, typed]
  }))
  await writeFile(join(directory, 'model-canvas-tools.json'), JSON.stringify(modelTools.filter((tool: any) => tool.name.startsWith('canvas_')), null, 2) + '\n')
  await writeFile(join(directory, 'code-mode-canvas-write.txt'), declaration)
  await writeFile(join(directory, 'code-mode-browser-act.txt'), browserDeclaration)
  await writeFile(join(directory, 'code-mode-browser-capture.txt'), captureDeclaration)
  await writeFile(join(directory, 'model-browser-tools.json'), JSON.stringify(modelTools.filter((tool: any) => tool.name.startsWith('browser_')), null, 2) + '\n')
  const version = Bun.spawn([executable, '--version'], { stdout: 'pipe' })
  const receipt = { passed: true, codexVersion: (await new Response(version.stdout).text()).trim(), realModel: false, modelMetadata: 'fixture (host fallback)', realMcp: true, directSchema: true, browserActionSchema: true, structuredOutput: true, outputTypeChecks, codeMode: true, typeChecks, readTypeChecks, browserTypeChecks, pageMaximumRetainedByHost: status.parameters.properties.limit.maximum === 64, pageBoundsInDescription: true, scrollBoundsInDescription: true, directory }
  assert.equal(await version.exited, 0)
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt, null, 2))
} finally {
  clearTimeout(timeout); child.stdin.end(); child.kill(); await child.exited; await reading; server.stop(true)
  await writeFile(join(directory, 'model-requests.json'), JSON.stringify(requests, null, 2))
  await writeFile(join(directory, 'stderr.txt'), await errors)
  console.log(`Evidence: ${directory}`)
}
