/** Source app + isolated local services. No extension, install, or fixture agent. */
import { mkdir, chmod } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { NativeCodexAdapter } from '../apps/extension/src/background/codexAdapter'
import { NativeCanvasBridge } from '../apps/extension/src/background/canvasBridge'
import { runtimePort } from '../apps/extension/src/shared/runtimePort'
import { mediaSettings } from '../native/media/settings'
import { nativePort } from './web/nativePort'
import { webAccount } from './web/account'
import { isSpeechGrantRequest } from '../packages/capture/src/cloudSpeech'
import { findCodex, codexEnvironment } from '../native/companion/codex'

const root = resolve(import.meta.dir, '..'), output = join(root, 'output/web-app')
const port = Number(Bun.env.GALTA_WEB_PORT ?? 4471), host = `127.0.0.1:${port}`, origin = `http://${host}`
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local web port')
await mkdir(output, { recursive: true, mode: 0o700 })
for (const name of ['bridge', 'workspaces', 'runtime']) { await mkdir(join(output, name), { recursive: true, mode: 0o700 }); await chmod(join(output, name), 0o700) }
async function run(command: string[]) { const child = Bun.spawn(command, { cwd: root, stdout: 'inherit', stderr: 'inherit' }); if (await child.exited) throw new Error(`Could not build ${command[0]}`) }
await run([process.execPath, 'build', 'native/mcp/main.ts', '--compile', '--outfile', join(output, 'galta-mcp')])
const found = (await findCodex()).codex
if (!found) throw new Error('A supported Codex installation is required. Open Codex on this Mac first.')
const env = { ...codexEnvironment(found.directory), GALTA_CODEX_BIN: found.path, GALTA_MCP_BIN: join(output, 'galta-mcp'),
  GALTA_BRIDGE_DIRECTORY: join(output, 'bridge'), GALTA_WORKSPACE_DIRECTORY: join(output, 'workspaces'), GALTA_RUNTIME_DIRECTORY: join(output, 'runtime') }
const token = crypto.randomUUID(), peers = new Set<Bun.ServerWebSocket<Peer>>()
type Peer = { ports: Map<string, ReturnType<typeof runtimePort>>; owners: Set<string> }
const children = new Set<chrome.runtime.Port>()
const transport = {
  lastError: undefined,
  connectNative(name: string) {
    const path = name === 'com.galta.codex' ? 'native/adapters/codex/host.ts' : name === 'com.galta.canvas' ? 'native/bridge/host.ts' : undefined
    if (!path) throw new Error('Unsupported local service')
    const child = nativePort([process.execPath, join(root, path), 'chrome-extension://galta-local-web/'], env, () => children.delete(child)); children.add(child); return child
  },
  sendMessage: (async (message: unknown) => { for (const peer of peers) peer.send(JSON.stringify({ type: 'notification', value: message })) }) as typeof chrome.runtime.sendMessage
}
const codex = new NativeCodexAdapter(transport), canvas = new NativeCanvasBridge(transport)
const account = webAccount(output, () => { void transport.sendMessage({ type: 'account-changed' }) })
const owners = new Map<string, Peer>()
function claimOwner(owner: unknown, peer: Peer) {
  if (typeof owner !== 'string' || !owner || owner.length > 100 || owners.has(owner) && owners.get(owner) !== peer) throw new Error('This page does not own the Codex connection')
  if (!owners.has(owner)) { owners.set(owner, peer); peer.owners.add(owner); codex.attachClient(owner) }
}
function releaseOwner(owner: string, peer: Peer) {
  if (owners.get(owner) !== peer) return
  owners.delete(owner); peer.owners.delete(owner); codex.detachClient(owner)
}
const server = Bun.serve<Peer>({ hostname: '127.0.0.1', port: 0,
  fetch(request, server) {
    const url = new URL(request.url), protocols = request.headers.get('sec-websocket-protocol')?.split(',').map(p => p.trim())
    if (url.pathname !== '/runtime' || request.headers.get('host') !== `127.0.0.1:${server.port}` || request.headers.get('origin') !== origin || protocols?.[0] !== 'galta-local' || protocols?.[1] !== token) return new Response('Forbidden', { status: 403 })
    return server.upgrade(request, { headers: { 'Sec-WebSocket-Protocol': 'galta-local' }, data: { ports: new Map(), owners: new Set() } }) ? undefined : new Response('WebSocket required', { status: 400 })
  }, websocket: {
    maxPayloadLength: 48_000_000,
    open(ws) { peers.add(ws) },
    async message(ws, raw) {
      let message: any
      const send = (value: unknown) => ws.send(JSON.stringify(value))
      try {
        message = JSON.parse(String(raw))
        if (typeof message.id !== 'string' || message.id.length > 200) throw new Error('Invalid request')
        const { id } = message
        if (message.type === 'port-open') {
          if (ws.data.ports.has(id) || ws.data.ports.size >= 64) throw new Error('Invalid port')
          const name = String(message.name)
          const channel = runtimePort(name, value => send({ type: 'port-message', id, value }), () => { ws.data.ports.delete(id); send({ type: 'port-close', id }) })
          ws.data.ports.set(id, channel)
          if (name.startsWith('galta-canvas:')) canvas.attach(channel.port)
          else if (name.startsWith('galta-codex-client:')) {
            const owner = name.slice('galta-codex-client:'.length); claimOwner(owner, ws.data)
            channel.port.onDisconnect.addListener(() => { releaseOwner(owner, ws.data) })
          } else if (name === 'galta-task-host') channel.port.onDisconnect.addListener(() => { void transport.sendMessage({ type: 'task-host-closed' }) })
          else throw new Error('Unsupported local port')
        } else if (message.type === 'port-message') ws.data.ports.get(id)?.receive(message.value)
        else if (message.type === 'port-close') { ws.data.ports.get(id)?.ended(); ws.data.ports.delete(id) }
        else if (message.type === 'request') {
          const request = message.message; let value: unknown
          if (request.type === 'codex-connect') value = await codex.connect()
          else if (request.type === 'media-settings') {
            const response = await mediaSettings(request.request)
            if (response.ok && request.request?.action !== 'status') codex.refreshTools()
            value = response
          }
          else if (request.type === 'account') value = await account.handleAccount(request.request)
          else if (request.type === 'speech-authorize' && isSpeechGrantRequest(request.request)) value = await account.speechGrant(request.request)
          else if (request.type === 'codex-rpc' || request.type === 'codex-respond') {
            claimOwner(request.ownerId, ws.data)
            if (request.type === 'codex-rpc') value = { ok: true, result: await codex.requestForOwner(request.ownerId, request.method, request.params) }
            else { codex.respond(request.ownerId, request.id, request.result, request.error); value = { ok: true } }
          } else if (request.type === 'codex-login') value = { ok: false, error: 'Sign in to this local preview with bun run web:login, then reload this page.' }
          else if (request.type === 'setup-status') value = { state: 'ready', health: { protocol: 1, version: 'source', releaseId: 'local-web', channel: 'development', capabilities: ['canvas/1', 'codex/1', 'mcp/1'], runtime: { available: true }, codex: { state: 'ready', version: found.version, source: found.source } } }
          else throw new Error('Unsupported local request')
          send({ type: 'response', id, value })
        } else throw new Error('Unsupported transport message')
      } catch (error) { if (message?.id) send({ type: 'response', id: message.id, error: error instanceof Error ? error.message : String(error) }) }
    },
    close(ws) { peers.delete(ws); for (const channel of ws.data.ports.values()) channel.ended(); for (const owner of ws.data.owners) releaseOwner(owner, ws.data) }
  }
})
const vite = Bun.spawn([process.execPath, 'run', 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: join(root, 'apps/extension'), env: { ...process.env, GALTA_WEB_APP: '1', GALTA_WEB_HOST: host, GALTA_WEB_SOCKET: `ws://127.0.0.1:${server.port}/runtime`, GALTA_WEB_TOKEN: token }, stdout: 'inherit', stderr: 'inherit'
})
let closing = false
function close() { if (closing) return; closing = true; vite.kill(); for (const peer of peers) peer.close(); for (const child of children) child.disconnect(); server.stop(true) }
process.on('SIGTERM', close); process.on('SIGINT', close)
console.log(`Galta web app: ${origin}/canvas/index.html\nUses local Codex ${found.version}. Keep this process and the canvas tab open while an agent works.`)
await vite.exited; close()
