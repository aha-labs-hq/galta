import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NativeMessageDecoder, assertCodexEmbeddedConfig, CODEX_EXECUTION_POLICY } from '../packages/runtime/src/index'
import { nativeBinaryDirectory } from '../native/paths'

// Opt-in integration check: the installed host, actual app-server and selected
// model execute a disposable file operation. No browser or artwork is touched.
const binary = resolve(process.argv[2] ?? join(nativeBinaryDirectory, 'galta-codex-bridge'))
const directory = await mkdtemp(join(tmpdir(), 'galta-policy-'))
const configPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml')
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const originalConfig = await readFile(configPath)
const relevantConfig = (bytes: Uint8Array) => {
  const config = Bun.TOML.parse(Buffer.from(bytes).toString())
  return JSON.stringify([config.notify, config.approval_policy, config.sandbox_mode, config.apps])
}
const child = Bun.spawn([binary, 'chrome-extension://oocbicpnofichiglihkbmpkjegiakhgg/'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()
const events: any[] = []
const stderr = new Response(child.stderr).text()
let nextId = 0
function send(message: unknown) {
  const body = Buffer.from(JSON.stringify(message)), frame = Buffer.alloc(body.length + 4)
  frame.writeUInt32LE(body.length); body.copy(frame, 4); child.stdin.write(frame)
}
function request(method: string, params: unknown = {}): Promise<any> {
  const id = String(++nextId)
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ id, method, params }) })
}
const reading = (async () => {
  const decoder = new NativeMessageDecoder()
  let buffer = Buffer.alloc(0)
  for await (const chunk of child.stdout) {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
      const length = buffer.readUInt32LE(), part = JSON.parse(buffer.subarray(4, length + 4).toString())
      buffer = buffer.subarray(length + 4)
      const message = decoder.push(part) as any
      if (!message) continue
      if (message.method) {
        events.push(message)
        if (message.id !== undefined) send({ id: message.id, error: { code: -32000, message: 'Unexpected interactive request in policy verification' } })
      } else {
        const waiter = pending.get(String(message.id)); pending.delete(String(message.id))
        if (message.error) waiter?.reject(new Error(message.error.message))
        else waiter?.resolve(message.result)
      }
    }
  }
  for (const waiter of pending.values()) waiter.reject(new Error('Native host closed'))
})()
const deadline = setTimeout(() => child.kill(), 180_000)
const startedAt = new Date().toISOString()
try {
  await request('initialize', { clientInfo: { name: 'galta-policy-verification', version: '1' }, capabilities: { experimentalApi: true } })
  send({ method: 'initialized', params: {} })
  const configuration = await request('config/read', { includeLayers: false })
  assertCodexEmbeddedConfig(configuration)
  const models = (await request('model/list')).data
  const model = configuration.config.model
    ? models.find((model: any) => model.id === configuration.config.model)
    : models.find((model: any) => model.isDefault)
  if (!model) throw new Error('No configured model available')
  const thread = await request('thread/start', {
    model: model.id, cwd: directory, ephemeral: true,
    approvalPolicy: CODEX_EXECUTION_POLICY.approvalPolicy, sandbox: CODEX_EXECUTION_POLICY.sandbox,
    baseInstructions: 'Perform only the requested local verification. Do not use browsers, external apps, or other files.',
    developerInstructions: 'Use the built-in command tool. No approvals are required for this disposable directory.'
  })
  const threadId = thread.thread.id
  const receipts = []
  for (let index = 0; index < 2; index++) {
    const token = randomUUID(), path = join(directory, `receipt-${index}.txt`), start = events.length
    const { turn } = await request('turn/start', {
      threadId, model: model.id, effort: 'low', cwd: directory,
      approvalPolicy: CODEX_EXECUTION_POLICY.approvalPolicy, sandboxPolicy: CODEX_EXECUTION_POLICY.sandboxPolicy,
      input: [{ type: 'text', text: `Use one shell command to write the exact text ${token} into ${path}, then read it back. Do no other work. Reply with that exact text.`, text_elements: [] }]
    })
    let complete: any
    while (!(complete = events.slice(start).find(event => event.method === 'turn/completed' && event.params?.turn?.id === turn.id))) {
      if (child.exitCode !== null) throw new Error('Host closed before turn completion')
      await Bun.sleep(100)
    }
    if (complete.params.turn.status !== 'completed') throw new Error(`Verification turn failed: ${JSON.stringify(complete.params.turn.error)}`)
    if ((await readFile(path, 'utf8')).trim() !== token) throw new Error('Command did not create the expected file')
    const observed = events.slice(start)
    if (observed.some(event => event.id !== undefined)) throw new Error('The turn emitted an interactive server request')
    if (!observed.some(event => event.method === 'item/completed' && event.params?.item?.type === 'commandExecution')) throw new Error('No completed command execution')
    receipts.push({ turnId: turn.id, status: 'completed', commandVerified: true, interactiveRequests: 0 })
    console.log(JSON.stringify({ stage: index ? 'continued' : 'new', ...receipts.at(-1) }))
  }
  // Keep the process alive across end-of-turn notification dispatch.
  await Bun.sleep(500)
  assertCodexEmbeddedConfig(await request('config/read', { includeLayers: false, cwd: directory }))
  const finalConfig = await readFile(configPath)
  if (relevantConfig(finalConfig) !== relevantConfig(originalConfig)) throw new Error('Global notification or approval settings changed during verification')
  console.log(JSON.stringify({ passed: true, startedAt, completedAt: new Date().toISOString(), binary, binarySha256: hash(await readFile(binary)), model: model.id, threadId, ephemeral: true, notify: configuration.config.notify, approvalPolicy: thread.approvalPolicy, sandbox: thread.sandbox, appApproval: configuration.config.apps._default.default_tools_approval_mode, globalNotificationAndApprovalSettingsUnchanged: true, globalConfigFileUnchanged: hash(finalConfig) === hash(originalConfig), receipts }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ passed: false, startedAt, error: error instanceof Error ? error.message : String(error) }))
  throw error
} finally {
  clearTimeout(deadline); child.stdin.end(); child.kill()
  await child.exited; await reading; await stderr
  await rm(directory, { recursive: true, force: true })
}
