/** Real official app-server, deterministic local WS/SSE peer. No account or inference. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { CODEX_OPENAI_TRANSPORT } from '../packages/runtime/src/codexConfig'
import { embeddedCodexEnvironment } from '../native/adapters/codex/environment'

const binary = process.env.GALTA_CODEX_BIN ?? Bun.which('codex')
if (!binary) throw new Error('Set GALTA_CODEX_BIN to the supported official app-server')
const directory = await mkdtemp(join(tmpdir(), 'galta-transport-'))
const cwd = join(directory, 'workspace')
await mkdir(cwd)
const LIMIT = 16 * 1024 * 1024
let scenario = '', wsCount = 0, httpCount = 0, toolCount = 0
const attempts: { transport: string; bytes: number; model: string }[] = []
function events(body: any) {
  const item = scenario === 'tool' && toolCount === 0
    ? { type: 'function_call', id: 'fc_once', call_id: 'call_once', name: 'fixture_once', arguments: '{}', status: 'completed' }
    : { type: 'message', id: 'msg_done', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'TRANSPORT_OK', annotations: [] }] }
  const response = { id: `resp_${crypto.randomUUID()}`, object: 'response', created_at: 1, model: body.model, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  return [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]
}
const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
  async fetch(request, server) {
    if (request.headers.get('upgrade') === 'websocket') return server.upgrade(request) ? undefined : new Response(null, { status: 400 })
    if (request.method !== 'POST') return Response.json({ data: [] })
    const raw = await request.text(), body = JSON.parse(raw)
    httpCount++; attempts.push({ transport: 'http', bytes: Buffer.byteLength(raw), model: body.model })
    // An accepted stream without response.completed exercises SSE recovery,
    // independently of HTTP's request-level retries.
    const messages = scenario === 'sse-recovery' && httpCount === 1 ? events(body).slice(0, 1) : events(body)
    return new Response(messages.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  },
  websocket: {
    maxPayloadLength: 32 * 1024 * 1024,
    message(ws, raw) {
      const body = JSON.parse(String(raw)), bytes = Buffer.byteLength(String(raw))
      if (body.generate === false) { for (const event of events(body)) ws.send(JSON.stringify(event)); return }
      wsCount++; attempts.push({ transport: 'ws', bytes, model: body.model })
      if (bytes > LIMIT || scenario === 'sse-recovery' || scenario === 'tool' && toolCount > 0) { ws.close(1009, 'fixture message limit'); return }
      if (scenario === 'transient' && wsCount === 1) { ws.close(1011, 'fixture temporary failure'); return }
      for (const event of events(body)) ws.send(JSON.stringify(event))
    }
  }
})
function paddedPng(bytes:number) {
  const crc=(b:Buffer)=>{let c=0xffffffff;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^0xffffffff)>>>0}
  const chunk=(type:string,data:Buffer)=>{const body=Buffer.concat([Buffer.from(type),data]);const size=Buffer.alloc(4);size.writeUInt32BE(data.length);const check=Buffer.alloc(4);check.writeUInt32BE(crc(body));return Buffer.concat([size,body,check])}
  const header=Buffer.alloc(13);header.writeUInt32BE(32);header.writeUInt32BE(32,4);header[8]=8;header[9]=2
  const pixels=Buffer.alloc(32*(1+32*3),255);for(let y=0;y<32;y++)pixels[y*97]=0
  const image=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('tEXt',Buffer.concat([Buffer.from('DiagnosticPadding\0'),Buffer.alloc(bytes,97)])),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))])
  return 'data:image/png;base64,'+image.toString('base64')
}
const receipt: any[] = []
async function run(name: string, retries: number) {
  scenario = name; wsCount = 0; httpCount = 0; toolCount = 0; attempts.length = 0
  const state = join(directory, `${name}-${retries}`), embedded = embeddedCodexEnvironment(state, process.env)
  await mkdir(embedded.directory, { recursive: true })
  const provider = { ...CODEX_OPENAI_TRANSPORT, name: 'Local transport fixture', requires_openai_auth: false,
    base_url: `http://127.0.0.1:${server.port}/v1`, stream_max_retries: retries }
  const args = ['app-server', '--stdio', '-c', 'model_provider="fixture"', '-c', 'model="fixture"', '-c', 'features.code_mode_only=false',
    ...Object.entries(provider).flatMap(([key, value]) => ['-c', `model_providers.fixture.${key}=${JSON.stringify(value)}`])]
  const child = Bun.spawn([binary!, ...args], { cwd, env: embedded.environment, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const stderr = new Response(child.stderr).text()
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  let id = 0, finished: ((turn: any) => void) | undefined, failTurn: ((error: Error) => void) | undefined
  const send = (message: any) => child.stdin.write(JSON.stringify(message) + '\n')
  const rpc = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); send({ id: key, method, params }) })
  const reader = (async () => {
    let buffer = ''; const decoder = new TextDecoder()
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true }); let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
        if (!message.method) { const entry = pending.get(message.id); pending.delete(message.id); message.error ? entry?.reject(new Error(message.error.message)) : entry?.resolve(message.result); continue }
        if (message.method === 'item/tool/call') {
          assert.equal(message.params.tool, 'fixture_once'); toolCount++
          send({ id: message.id, result: { contentItems: [{ type: 'inputText', text: 'EFFECT_ONCE' }], success: true } })
        } else if (message.id !== undefined) send({ id: message.id, error: { code: -32000, message: 'Unexpected interactive request' } })
        if (message.method === 'turn/completed') finished?.(message.params.turn)
      }
    }
  })()
  const deadline = setTimeout(() => {
    const error = new Error('Transport fixture timeout'); child.kill(); failTurn?.(error)
    for (const p of pending.values()) p.reject(error)
  }, 45000)
  const start = performance.now()
  try {
    await rpc('initialize', { clientInfo: { name: 'galta_transport_test', version: '1' }, capabilities: { experimentalApi: true } }); send({ method: 'initialized' })
    const { thread } = await rpc('thread/start', { cwd, model: 'fixture', ephemeral: true, approvalPolicy: 'never', sandbox: 'danger-full-access',
      ...(name === 'tool' ? { dynamicTools: [{ name: 'fixture_once', description: 'Execute exactly once.', inputSchema: { type: 'object', properties: {} } }] } : {}) })
    // Valid white PNGs with inert metadata reproduce the encoded-byte limit
    // without making the model task harder or using any private image.
    const complete = new Promise<any>((resolve, reject) => { finished = resolve; failTurn = reject })
    const input: any[] = [{ type: 'text', text: 'Transport fixture.', text_elements: [] }]
    if (name === 'oversize') { const url = paddedPng(7 * 1024 * 1024); input.push({ type: 'image', url }, { type: 'image', url }) }
    await rpc('turn/start', { threadId: thread.id, input })
    const turn = await complete
    assert.equal(turn.status, 'completed', JSON.stringify(turn.error))
    assert(attempts.every(attempt => attempt.model === 'fixture'))
    if (name === 'normal') { assert.equal(wsCount, 1); assert.equal(httpCount, 0) }
    if (name === 'transient') { assert.equal(wsCount, 2); assert.equal(httpCount, 0) }
    if (name === 'oversize') { assert.equal(wsCount, retries + 1); assert.equal(httpCount, 1); assert(attempts.every(attempt => attempt.bytes > LIMIT)) }
    if (name === 'sse-recovery') { assert.equal(wsCount, retries + 1); assert.equal(httpCount, 2) }
    if (name === 'tool') { assert.equal(toolCount, 1); assert.equal(wsCount, retries + 2); assert.equal(httpCount, 1) }
    receipt.push({ name, retries, wsCount, httpCount, toolCount, durationMs: Math.round(performance.now() - start), attempts: [...attempts] })
    console.log(JSON.stringify(receipt.at(-1)))
  } finally {
    clearTimeout(deadline); child.stdin.end(); child.kill(); await child.exited; await reader; await stderr
  }
}
try {
  await run('oversize', 5) // Confirm the original failure pattern at the actual transport seam.
  for (const name of ['normal', 'transient', 'oversize', 'sse-recovery', 'tool']) await run(name, CODEX_OPENAI_TRANSPORT.stream_max_retries)
  console.log(JSON.stringify({ passed: true, inference: false, cases: receipt.length }))
} finally { server.stop(true); await rm(directory, { recursive: true, force: true }) }
