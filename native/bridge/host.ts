#!/usr/bin/env bun
import { lstat, mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareGaltaDataDirectory } from '../dataDirectory'
import { galtaBridgeDirectory } from '../paths'
import { createNativeSender } from '../messaging'
import { CanvasRegistry } from './registry'
import { assertGaltaToolContract, galtaToolContract } from '../../packages/canvas/src/contract'
import { deliverArtifact, openCreativeWorkspace, removeCreativeWorkspace, readArtifactChunk, readHtmlArtifact, readImageArtifact, readVideoChunk, writeArtifact, writeImageArtifact } from './artifacts'
import { finalizeArtifacts, readDeliveryChunk } from './deliveries'

if (!Bun.argv[2]?.startsWith('chrome-extension://')) throw new Error('Expected a browser native-messaging connection')

const id = crypto.randomUUID(), token = crypto.randomUUID()
if (!Bun.env.GALTA_WORKSPACE_DIRECTORY) await prepareGaltaDataDirectory()
const directory = Bun.env.GALTA_BRIDGE_DIRECTORY ?? galtaBridgeDirectory
const descriptor = join(directory, `${id}.json`)
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void }
const pending = new Map<string, Pending>()
let closing = false
const send = createNativeSender()
async function dispatch(canvasId: string, method: string, params: Record<string, unknown>, signal?: AbortSignal) {
  if (closing) throw new Error('Canvas bridge disconnected')
  signal?.throwIfAborted()
  const requestId = crypto.randomUUID()
  const cancel = () => {
    pending.get(requestId)?.reject(new Error('Canvas operation cancelled'))
    void send({ method: 'canvas/cancel', params: { canvasId, requestId } }).catch(error => process.stderr.write(`${error}\n`))
  }
  const timeout = setTimeout(() => {
    pending.get(requestId)?.reject(new Error(`Canvas ${method} timed out`))
    void send({ method: 'canvas/cancel', params: { canvasId, requestId } }).catch(error => process.stderr.write(`${error}\n`))
  }, 60_000)
  try {
    return await new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      signal?.addEventListener('abort', cancel, { once: true })
      void send({ id: requestId, method: `canvas/${method}`, params: { ...params, canvasId } }).catch(reject)
    })
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
    pending.delete(requestId)
  }
}
const registry = new CanvasRegistry(dispatch, openCreativeWorkspace)
type Peer = { leases: Set<string>; calls: Map<string, AbortController> }
const peers = new Set<Peer>()
const server = Bun.serve<Peer>({
  hostname: '127.0.0.1', port: 0,
  fetch(request, server) {
    if (request.headers.has('origin') || request.headers.get('authorization') !== `Bearer ${token}` || new URL(request.url).pathname !== '/bridge') return new Response('Unauthorized', { status: 401 })
    const peer: Peer = { leases: new Set(), calls: new Map() }
    return server.upgrade(request, { data: peer }) ? undefined : new Response('WebSocket required', { status: 400 })
  },
  websocket: {
    maxPayloadLength: 48_000_000,
    open(ws) { peers.add(ws.data) },
    async message(ws, raw) {
      let request: any
      let requestId: string | undefined
      try {
        request = JSON.parse(String(raw))
        if (request.method === 'cancel') { ws.data.calls.get(request.params?.requestId)?.abort(); return }
        if (typeof request.id !== 'string' || ws.data.calls.has(request.id)) throw new Error('Invalid request identity')
        const abort = new AbortController()
        requestId = request.id
        ws.data.calls.set(request.id, abort)
        let result: unknown
        const p = request.params ?? {}
        if (['connect', 'call', 'execution/call', 'execution/workspace'].includes(request.method)) await assertGaltaToolContract(p.toolContract)
        if (request.method === 'list') result = registry.list()
        else if (request.method === 'execution/call') result = await registry.boundCall(p.leaseId, p.tool, p.args, abort.signal)
        else if (request.method === 'execution/active') result = registry.embeddedLeases()
        else if (request.method === 'execution/workspace') result = registry.embeddedWorkspace(p.leaseId)
        else if (request.method === 'connect') {
          const lease = await registry.connect(p.canvasId, typeof p.client === 'string' ? p.client.slice(0, 100) : 'MCP client', 'external', abort.signal)
          if (!peers.has(ws.data) || abort.signal.aborted) { await registry.release(lease.id); throw new Error('Client disconnected') }
          ws.data.leases.add(lease.id)
          result = lease
        } else {
          if (!ws.data.leases.has(p.leaseId)) throw new Error('This client does not own the canvas execution')
          if (request.method === 'call') result = await registry.call(p.leaseId, p.tool, p.args, abort.signal)
          else if (request.method === 'release') { await registry.release(p.leaseId); ws.data.leases.delete(p.leaseId); result = {} }
          else throw new Error('Unknown bridge request')
        }
        ws.send(JSON.stringify({ id: request.id, result }))
      } catch (error) {
        ws.send(JSON.stringify({ id: request?.id, error: { message: error instanceof Error ? error.message : String(error) } }))
      } finally { if (requestId) ws.data.calls.delete(requestId) }
    },
    async close(ws) {
      peers.delete(ws.data)
      for (const abort of ws.data.calls.values()) abort.abort()
      await Promise.all([...ws.data.leases].map(async leaseId => {
        try { await registry.release(leaseId) }
        catch (error) { console.error('Galta canvas cleanup failed', { bridgeId: id, leaseId, error: error instanceof Error ? error.message : String(error) }) }
      }))
    }
  }
})
await mkdir(directory, { recursive: true, mode: 0o700 })
const directoryInfo = await lstat(directory)
const currentUid = process.getuid?.()
if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (process.platform !== 'win32' && (directoryInfo.mode & 0o077 || (currentUid !== undefined && directoryInfo.uid !== currentUid)))) throw new Error('Unsafe Galta bridge directory permissions')
await writeFile(descriptor, JSON.stringify({ version: 1, id, port: server.port, token, pid: process.pid, toolContract: await galtaToolContract() }), { mode: 0o600, flag: 'wx' })

async function message(request: any) {
  if (!request.method) {
    const waiter = pending.get(request.id)
    request.error ? waiter?.reject(new Error(request.error.message)) : waiter?.resolve(request.result)
    return
  }
  try {
    const p = request.params ?? {}
    let result: unknown
    if (request.method === 'canvas/register') {
      await assertGaltaToolContract(p.toolContract)
      registry.register({ id: p.canvasId, projectId: p.projectId, title: p.title })
      result = { toolContract: await galtaToolContract() }
    }
    else if (request.method === 'canvas/unregister') { await registry.unregister(p.canvasId); result = {} }
    // Deleting a canvas: its files go only once nothing here still uses it.
    else if (request.method === 'workspace/remove') {
      if (registry.inUse(p.projectId)) throw new Error('This canvas is still open or an agent is using it. Close it everywhere, then delete it again.')
      result = { removed: await removeCreativeWorkspace(p.projectId) }
    }
    else if (request.method === 'canvas/acquire') result = { ...await registry.connect(p.canvasId, 'Galta', 'embedded'), bridgeId: id }
    else if (request.method === 'artifact/finalize') {
      const canvas = registry.registration(p.canvasId)
      result = await finalizeArtifacts(p.hrefs, await openCreativeWorkspace(canvas.projectId), { projectId: canvas.projectId, threadId: p.threadId, turnId: p.turnId, messageId: p.messageId }, p.declarations)
    }
    else if (request.method === 'artifact/read-file') {
      const canvas = registry.registration(p.canvasId)
      if (p.receipt && p.uri !== p.receipt.uri) throw new Error('The requested URI does not match the delivery receipt')
      result = p.receipt ? await readDeliveryChunk(p.receipt, await openCreativeWorkspace(canvas.projectId), canvas.projectId, p.offset, p.version)
        : await readArtifactChunk(p.uri, await openCreativeWorkspace(canvas.projectId), p.offset, p.version)
    }
    else {
      const lease = registry.lease(p.leaseId)
      if (lease.canvasId !== p.canvasId) throw new Error('Canvas execution belongs to another surface')
      if (request.method === 'canvas/release') { await registry.release(lease.id); result = {} }
      else if (request.method === 'artifact/read-image') result = await readImageArtifact(p.path, lease.cwd)
      else if (request.method === 'artifact/read-video') result = await readVideoChunk(p.path, lease.cwd, p.offset, p.version)
      else if (request.method === 'artifact/read-html') result = await readHtmlArtifact(p.path, lease.cwd)
      else if (request.method === 'artifact/write-image') { await writeImageArtifact(p.path, p.dataBase64, lease.cwd); result = {} }
      else if (request.method === 'artifact/write-file') { await writeArtifact(p.path, p.dataBase64, p.mimeType, lease.cwd); result = {} }
      else if (request.method === 'artifact/deliver') result = await deliverArtifact(p.source, p.destination, lease.cwd)
      else throw new Error('Unknown canvas bridge request')
    }
    if (request.id) await send({ id: request.id, result })
  } catch (error) {
    if (request.id) await send({ id: request.id, error: { message: error instanceof Error ? error.message : String(error) } })
  }
}

try {
  let buffer = Buffer.alloc(0)
  for await (const chunk of Bun.stdin.stream()) {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE()
      if (size > 64 * 1024 * 1024) throw new Error('Native message too large')
      if (buffer.length < size + 4) break
      const request = JSON.parse(buffer.subarray(4, size + 4).toString())
      buffer = buffer.subarray(size + 4)
      // Calls can return through this same stream; never block the read loop.
      void message(request).catch(error => { process.stderr.write(`${error}\n`); process.exitCode = 1 })
    }
  }
  if (buffer.length) throw new Error('Incomplete native message at disconnect')
} finally {
  closing = true
  for (const waiter of pending.values()) waiter.reject(new Error('Canvas bridge closed'))
  pending.clear()
  await registry.close()
  server.stop(true)
  await unlink(descriptor)
}
