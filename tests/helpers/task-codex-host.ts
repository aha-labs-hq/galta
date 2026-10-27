import { compatibleCodexConfig } from './codex-config'
import { galtaToolContract } from '../../packages/canvas/src/contract'

// Deterministic app-server boundary for installed-extension lifecycle tests.
// Canvas tools still use the real native bridge, MCP and IndexedDB.
const toolContract = await galtaToolContract()
const threads = new Map<string, any>(), requests: any[] = [], responses: any[] = []
let interrupts = 0, active: { threadId: string; turn: any; executionId: string; cwd: string } | undefined
let holdInterrupt = false, awaitingApproval = false
const send = (message: unknown) => {
  const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4)
  header.writeUInt32LE(body.length); process.stdout.write(Buffer.concat([header, body]))
}
const finish = (status = 'completed') => {
  if (!active) throw new Error('No fixture turn is active')
  active.turn.status = status
  send({ method: 'turn/completed', params: { threadId: active.threadId, turn: active.turn } })
}
const resolveApproval = () => {
  if (!awaitingApproval) return
  awaitingApproval = false
  send({ method: 'serverRequest/resolved', params: { threadId: active!.threadId, requestId: 'approval' } })
}
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const action = new URL(request.url).pathname
  if (action === '/finish') finish()
  if (action === '/ask') {
    awaitingApproval = true
    send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: active!.threadId, turnId: active!.turn.id, itemId: 'command', command: 'fixture command' } })
  }
  if (action === '/resolve') resolveApproval()
  if (action === '/hold-interrupt') holdInterrupt = true
  if (action === '/finish-interrupt') {
    const item = { id: 'interrupted-command', type: 'commandExecution', command: 'fixture command', status: 'failed', exitCode: 130, aggregatedOutput: 'Stopped after cleanup' }
    active!.turn.items.push(item)
    send({ method: 'item/completed', params: { threadId: active!.threadId, turnId: active!.turn.id, item } })
    finish('interrupted'); holdInterrupt = false
  }
  if (action === '/fail') send({ method: 'error', params: { threadId: active!.threadId, turnId: active!.turn.id, willRetry: false, error: { message: 'Fixture stream failure' } } })
  if (action === '/finish-failed') { active!.turn.error = { message: 'Fixture terminal failure' }; finish('failed') }
  return Response.json({ active, interrupts, requests, responses })
} })
await Bun.write(process.argv[2]!, String(server.port))
let buffer = Buffer.alloc(0)
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
    const size = buffer.readUInt32LE(0), message = JSON.parse(buffer.subarray(4, size + 4).toString())
    buffer = buffer.subarray(size + 4)
    if (!message.method) { responses.push(message); if (message.id === 'approval') resolveApproval(); continue }
    if (message.id === undefined) continue
    requests.push(message)
    let result: any = {}
    const p = message.params ?? {}
    switch (message.method) {
      case 'initialize': break
      case 'config/read': result = compatibleCodexConfig(); break
      case 'account/read': result = { account: { type: 'apiKey' }, requiresOpenaiAuth: false }; break
      case 'model/list': result = { data: [{ id: 'fixture-model', displayName: 'Fixture', isDefault: true }] }; break
      case 'galta/config/read': result = { toolContract }; break
      case 'thread/start': case 'thread/fork': {
        const thread = { id: crypto.randomUUID(), turns: [], cwd: p.cwd }; threads.set(thread.id, thread); result = { thread }; break
      }
      case 'thread/read': case 'thread/resume': result = { thread: threads.get(p.threadId) }; break
      case 'thread/name/set': break
      case 'thread/unsubscribe': case 'thread/archive': break
      case 'galta/project/name/set': break
      case 'turn/start': {
        const thread = threads.get(p.threadId), turn = { id: crypto.randomUUID(), status: 'inProgress', items: [] }
        thread.turns.push(turn); result = { turn }
        if (!p.additionalContext?.execution) {
          setTimeout(() => {
            const item = { id: crypto.randomUUID(), type: 'agentMessage', text: JSON.stringify({ conversationTitle: 'Background study', canvasTitle: null }) }
            thread.turns.at(-1).items.push(item); turn.status = 'completed'
            send({ method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item } })
            send({ method: 'turn/completed', params: { threadId: thread.id, turn } })
          }, 0)
          break
        }
        active = { threadId: p.threadId, turn, executionId: JSON.parse(p.additionalContext.execution.value).id, cwd: thread.cwd }
        send({ method: 'turn/started', params: { threadId: thread.id, turn } }); break
      }
      case 'turn/interrupt': interrupts++; resolveApproval(); if (!holdInterrupt) finish('interrupted'); break
      default: send({ id: message.id, error: { message: `Unexpected fixture RPC: ${message.method}` } }); continue
    }
    send({ id: message.id, result })
  }
})
process.stdin.on('end', () => { server.stop(true); process.exit(0) })
