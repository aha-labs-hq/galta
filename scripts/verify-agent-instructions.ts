import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { codexTestHome } from './lib/codex-test-home'
import { CodexAgentRuntime, NativeMessageDecoder, type CodexRpcClient, type CodexJsonRpcNotification, type CodexAgentInput } from '../packages/runtime/src/index'

// Opt-in real app-server/model regression. Only disposable text conversations
// are used; no canvas, image generation, user file or user thread is changed.
const directory = await mkdtemp(join(tmpdir(), 'galta-instructions-'))
const runtimeDirectory = join(directory, 'runtime')
await mkdir(runtimeDirectory)
const binary = resolve(process.argv[2] ?? 'native/adapters/codex/galta-codex-bridge')
const isolated = await codexTestHome()
const child = Bun.spawn([binary, 'chrome-extension://oocbicpnofichiglihkbmpkjegiakhgg/'], {
  env: { ...process.env, ...isolated.environment, GALTA_WORKSPACE_DIRECTORY: join(directory, 'workspaces'), GALTA_RUNTIME_DIRECTORY: runtimeDirectory, GALTA_MCP_BIN: resolve('native/mcp/galta-mcp') },
  stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'
})
const stderr = new Response(child.stderr).text()
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()
const listeners = new Set<(notification: CodexJsonRpcNotification) => void>()
let nextId = 0
function send(message: unknown) {
  const body = Buffer.from(JSON.stringify(message)), frame = Buffer.alloc(body.length + 4)
  frame.writeUInt32LE(body.length); body.copy(frame, 4); child.stdin.write(frame)
}
const rpc: CodexRpcClient = {
  request(method, params) { const id = String(++nextId); return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ id, method, params }) }) },
  async respond(id, result, error) { send({ id, ...(error ? { error } : { result }) }) },
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }
}
const reading = (async () => {
  const decoder = new NativeMessageDecoder()
  let buffer = Buffer.alloc(0)
  for await (const chunk of child.stdout) {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
      const size = buffer.readUInt32LE(), part = JSON.parse(buffer.subarray(4, size + 4).toString())
      buffer = buffer.subarray(size + 4)
      const message = decoder.push(part) as any
      if (!message) continue
      if (message.method) { for (const listener of listeners) listener(message) }
      else {
        const waiter = pending.get(String(message.id)); pending.delete(String(message.id))
        if (message.error) waiter?.reject(new Error(message.error.message))
        else waiter?.resolve(message.result)
      }
    }
  }
  for (const waiter of pending.values()) waiter.reject(new Error('Native host closed'))
  for (const listener of listeners) listener({ method: 'galta/connection-lost', params: { message: 'Native verification host closed' } })
})()
const deadline = setTimeout(() => child.kill(), 240_000)
const receipts: any[] = []
const tracked = ['packages/canvas/src/instructions.ts', 'packages/canvas/src/tools.ts', 'packages/runtime/src/codexInstructions.ts', 'packages/runtime/src/codex.ts', 'native/adapters/codex/imageInstructions.ts', 'native/adapters/codex/host.ts']
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
try {
  await rpc.request('initialize', { clientInfo: { name: 'galta-instructions-verification', version: '1' }, capabilities: { experimentalApi: true } })
  send({ method: 'initialized', params: {} })
  const config = await rpc.request('config/read', { includeLayers: false }) as any
  const models = (await rpc.request('model/list', {}) as any).data
  const requestedModel = process.env.GALTA_VERIFY_MODEL ?? config.config.model
  const model = requestedModel ? models.find((m: any) => m.id === requestedModel) : models.find((m: any) => m.isDefault)
  if (!model) throw new Error('No configured model')
  const runtime = new CodexAgentRuntime(rpc)
  const projectId = `instruction-verification-${crypto.randomUUID()}`
  const cwd = join(directory, 'text-only-workspace')
  await mkdir(cwd)
  const input: CodexAgentInput = { projectId: projectId as CodexAgentInput['projectId'], branchId: 'verification', execution: { id: 'text-only-verification/no-tool-access', cwd }, instruction: '', runtime: { providerId: 'codex-app-server', sessionId: 'verification', sessionLabel: 'Instruction verification', modelId: model.id, effort: 'Low' } }
  const legacy = await rpc.request('thread/start', { model: model.id, cwd, ephemeral: false, developerInstructions: 'Keep all user-facing text in English.' }) as any
  const legacyId = legacy.thread.id
  // A newly allocated paginated thread has no persisted rollout until its
  // first turn. Establish the actual English-only failure before resuming it.
  const baselineMessages = new Map<string, string>()
  let finishBaseline: (value: string) => void
  const baselineDone = new Promise<string>(resolve => { finishBaseline = resolve })
  const offBaseline = rpc.subscribe(n => {
    if (n.params?.threadId !== legacyId) return
    const item = n.params.item as any
    if (n.method === 'item/completed' && item?.type === 'agentMessage') baselineMessages.set(item.id, item.text)
    if (n.method === 'turn/completed') finishBaseline((n.params.turn as any).status)
  })
  await rpc.request('turn/start', { threadId: legacyId, model: model.id, effort: 'low', input: [{ type: 'text', text: '你好，今天心情怎么样？一句话就好，不要使用任何工具。', text_elements: [] }] })
  const baselineState = await Promise.race([baselineDone, child.exited.then(() => 'host-exited')])
  offBaseline()
  const baselineAnswer = [...baselineMessages.values()].join('\n')
  const baselinePassed = baselineState === 'completed' && /[a-zA-Z]/.test(baselineAnswer) && !/[\u4e00-\u9fff]/.test(baselineAnswer)
  receipts.push({ label: 'legacy English-only baseline', threadId: legacyId, state: baselineState, answer: baselineAnswer, passed: baselinePassed })
  console.log(JSON.stringify(receipts.at(-1)))
  if (!baselinePassed) throw new Error('English-only legacy baseline did not reproduce')
  await rpc.request('thread/name/set', { threadId: legacyId, name: 'Galta instruction verification' })
  async function run(label: string, data: Partial<CodexAgentInput>, expected: RegExp) {
    const messages = new Map<string, string>()
    let threadId = '', turnId = '', state = '', toolCalls = 0
    const handle = await runtime.start({ ...input, ...data }, {
      async request() { toolCalls++; throw new Error('Unexpected tool interaction in text verification') }
    })
    for await (const update of handle.updates) {
      threadId = update.threadId ?? threadId; turnId = update.turnId ?? turnId; state = update.state
      if (update.item?.type === 'agentMessage') messages.set(update.item.id, update.item.text)
      else if (update.item && !['reasoning', 'contextCompaction'].includes(update.item.type)) toolCalls++
    }
    const answer = [...messages.values()].join('\n')
    const pass = state === 'completed' && expected.test(answer) && toolCalls === 0
    const receipt = { label, threadId, turnId, state, answer, toolCalls, passed: pass }
    receipts.push(receipt); console.log(JSON.stringify(receipt))
    if (!pass) throw new Error(`${label} failed`)
    return receipt
  }
  const first = await run('loaded legacy English thread now follows Chinese', { threadId: legacyId, instruction: '你好，今天心情怎么样？一句话就好，不要使用任何工具。' }, /[\u4e00-\u9fff]/)
  if (first.threadId !== legacyId) throw new Error('Legacy conversation was replaced')
  await run('fork uses current instructions and preserves conversation ancestry', { fork: { threadId: legacyId, lastTurnId: first.turnId }, instruction: '你好，请用一句话告诉我你能做什么，不要用任何工具。' }, /[\u4e00-\u9fff]/)
  await run('an English request follows English in the same conversation', { threadId: legacyId, instruction: 'How are you today? One short sentence, no tools.' }, /^[^\u4e00-\u9fff]*[a-zA-Z][^\u4e00-\u9fff]*$/)
  await run('an explicit language request takes precedence', { threadId: legacyId, instruction: '请用英语说一句简短的问候，不要用工具。' }, /^[^\u4e00-\u9fff]*[a-zA-Z][^\u4e00-\u9fff]*$/)
  await run('a Japanese request follows Japanese', { threadId: legacyId, instruction: 'こんにちは。今日はどんな気分ですか？一文だけ、ツールを使わずに答えて。' }, /[\u3040-\u30ff]/)
  await run('a new conversation uses current instructions', { instruction: '你好，今天怎么样？一句话就好，不要用工具。' }, /[\u4e00-\u9fff]/)
  const history = await runtime.readThread(legacyId) as any
  if (history.turns.length !== 5) throw new Error('Continuation changed the conversation history')
  const implementation = Object.fromEntries(await Promise.all(tracked.map(async path => [path, sha256(await readFile(path))])))
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ passed: true, verifiedAt: new Date().toISOString(), model: model.id, nativeBinarySha256: sha256(await readFile(binary)), implementation, receipts, boundaries: { realAppServer: true, realModel: true, noCanvasMutation: true, noImageGeneration: true, sameLegacyThread: true } }, null, 2))
  console.log(JSON.stringify({ passed: true, evidence: join(directory, 'receipt.json') }))
} catch (error) {
  await writeFile(join(directory, 'failure.json'), JSON.stringify({ passed: false, error: String(error), receipts }, null, 2))
  console.error(`Evidence: ${directory}`); throw error
} finally {
  clearTimeout(deadline); child.stdin.end(); child.kill(); await child.exited; await reading; await stderr
  await isolated.close()
}
