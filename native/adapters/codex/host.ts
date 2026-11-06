#!/usr/bin/env bun

/**
 * Native messaging relay for Galta.
 *
 * Chrome owns the length-prefixed stdin/stdout framing. Codex app-server uses
 * newline-delimited JSON-RPC. This process translates framing and configures the Galta MCP server;
 * the independent canvas bridge owns artifacts. Codex owns all credentials.
 */

const extensionOrigin = Bun.argv[2]
if (!extensionOrigin?.startsWith('chrome-extension://')) {
  process.stderr.write('Galta Codex adapter: unexpected extension origin\n')
  process.exit(1)
}

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { prepareGaltaDataDirectory } from '../../dataDirectory'
import { galtaRuntimeDirectory, nativeBinaryDirectory } from '../../paths'
import { createNativeSender } from '../../messaging'
import { CODEX_EMBEDDED_ARGS, CODEX_OPENAI_PROVIDER } from '../../../packages/runtime/src/codexConfig'
import { galtaToolContract } from '../../../packages/canvas/src/contract'
import { EMBEDDED_MCP_ENV, EMBEDDED_TOOL_TIMEOUT_SECONDS } from '../../../packages/canvas/src/execution'
import { codexEnvironment, findCodex } from '../../companion/codex'
import { embeddedCodexEnvironment } from './environment'
import { modelTransport } from './transport'

// An explicit installation is authoritative. Let spawn report an invalid path
// instead of silently running another Codex with different configuration.
// Otherwise the user's own supported Codex, else the copy Galta downloaded.
const found = Bun.env.GALTA_CODEX_BIN ? undefined : (await findCodex()).codex
const codexBinary = Bun.env.GALTA_CODEX_BIN ?? found?.path
const chromeReader = Bun.stdin.stream().getReader()
const sendToChrome = createNativeSender()
if (!codexBinary) {
  // Every request gets the next step; the browser ends this relay by disconnecting.
  await readChrome(async message => {
    if (message.id !== undefined) await sendToChrome({ id: message.id, error: { code: -32001, message: 'Galta couldn’t find Codex on this Mac. Open Settings › Chat in Galta to set it up.' } })
  })
  process.exit(0)
}

// Do not inherit the browser's host directory as Codex's startup workspace.
if (!Bun.env.GALTA_WORKSPACE_DIRECTORY) await prepareGaltaDataDirectory()
const runtimeDirectory = Bun.env.GALTA_RUNTIME_DIRECTORY
  ?? (Bun.env.GALTA_WORKSPACE_DIRECTORY ? join(dirname(Bun.env.GALTA_WORKSPACE_DIRECTORY), 'runtime') : galtaRuntimeDirectory)
await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
const embedded = embeddedCodexEnvironment(runtimeDirectory, found ? codexEnvironment(found.directory) : process.env)
await mkdir(embedded.directory, { recursive: true, mode: 0o700 })
const galtaMcp = Bun.env.GALTA_MCP_BIN ?? join(nativeBinaryDirectory, 'galta-mcp')
if (!existsSync(galtaMcp)) throw new Error('Install the Galta canvas bridge before connecting Codex; the MCP executable is missing')
const child = Bun.spawn([codexBinary, 'app-server', '--stdio', ...CODEX_EMBEDDED_ARGS,
  '-c', `sqlite_home=${JSON.stringify(embedded.directory)}`,
  '-c', `mcp_servers.galta.command=${JSON.stringify(galtaMcp)}`,
  '-c', 'mcp_servers.galta.args=[]',
  '-c', 'mcp_servers.galta.enabled=true',
  '-c', 'mcp_servers.galta.required=true',
  '-c', `mcp_servers.galta.tool_timeout_sec=${EMBEDDED_TOOL_TIMEOUT_SECONDS}`,
  '-c', `mcp_servers.galta.env.${EMBEDDED_MCP_ENV}="1"`,
  ...(Bun.env.GALTA_BRIDGE_DIRECTORY ? ['-c', `mcp_servers.galta.env.GALTA_BRIDGE_DIRECTORY=${JSON.stringify(Bun.env.GALTA_BRIDGE_DIRECTORY)}`] : []),
  '-c', 'mcp_servers.galta.default_tools_approval_mode="approve"'
], {
  cwd: runtimeDirectory,
  env: embedded.environment,
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'inherit'
})

const codexReader = child.stdout.getReader()
const internalPrefix = `galta-${crypto.randomUUID()}-`
let internalId = 0
const internalRequests = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()

function requestCodex(method: string, params: unknown): Promise<unknown> {
  const id = `${internalPrefix}${++internalId}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { internalRequests.delete(id); reject(new Error('Codex history read timed out')) }, 2_000)
    internalRequests.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    void sendToCodex({ id, method, params }).catch(error => { internalRequests.get(id)?.reject(error); internalRequests.delete(id) })
  })
}

async function sendToCodex(message: unknown): Promise<void> {
  await child.stdin.write(`${JSON.stringify(message)}\n`)
}

/** Chrome's length-prefixed frames; Galta's own requests are answered here. */
async function readChrome(forward: (message: { id?: unknown; method?: unknown }) => Promise<void>): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = new Uint8Array(0)
  while (true) {
    const chunk = await chromeReader.read()
    if (chunk.done) return
    const next = new Uint8Array(buffer.byteLength + chunk.value.byteLength)
    next.set(buffer)
    next.set(chunk.value, buffer.byteLength)
    buffer = next
    while (buffer.byteLength >= 4) {
      const length = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, true)
      if (length > 64 * 1024 * 1024) throw new Error('Incoming native message is too large')
      if (buffer.byteLength < length + 4) break
      const body = decoder.decode(buffer.slice(4, length + 4))
      buffer = buffer.slice(length + 4)
      const message = JSON.parse(body)
      if (codexBinary && message.method === 'galta/config/read') {
        try {
          const result = { toolContract: await galtaToolContract(), conversationStorage: 'galta', modelProvider: CODEX_OPENAI_PROVIDER, modelTransport: 1 }
          await sendToChrome({ id: message.id, result })
        } catch (error) {
          await sendToChrome({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Runtime configuration request failed' } })
        }
      } else if (codexBinary && message.method === 'galta/model/transport') {
        try {
          const result = await modelTransport(message.params, requestCodex)
          await sendToChrome({ id: message.id, result })
        } catch (error) {
          await sendToChrome({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Model transport request failed' } })
        }
      } else await forward(message)
    }
  }
}

async function readCodex(): Promise<void> {
  const decoder = new TextDecoder()
  let pending = ''
  while (true) {
    const chunk = await codexReader.read()
    if (chunk.done) return
    pending += decoder.decode(chunk.value, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      const internal = typeof message.id === 'string' ? internalRequests.get(message.id) : undefined
      if (!message.method && typeof message.id === 'string' && message.id.startsWith(internalPrefix)) {
        internalRequests.delete(message.id)
        if (message.error) internal?.reject(new Error(String(message.error.message)))
        else internal?.resolve(message.result)
        continue
      }
      await sendToChrome(message)
    }
  }
}

// Either peer closing ends this relay. Waiting for both leaves an orphaned
// app-server when the browser closes the side panel or reloads the extension.
let onShutdown!: () => void
const shutdown = new Promise<void>(resolve => { onShutdown = resolve })
process.once('SIGTERM', onShutdown)
process.once('SIGINT', onShutdown)
try {
  await Promise.race([readChrome(sendToCodex), readCodex(), shutdown])
} finally {
  for (const request of internalRequests.values()) request.reject(new Error('Codex connection closed'))
  internalRequests.clear()
  child.stdin.end()
  child.kill()
  const terminate = setTimeout(() => child.kill('SIGKILL'), 2_000)
  // Promise.race does not cancel its other read loop. Without this, an exited
  // app-server leaves the relay alive waiting on the browser's still-open stdin.
  // An errored stream rejects cancellation; it must not disarm the child deadline.
  try { await Promise.allSettled([chromeReader.cancel(), codexReader.cancel(), child.exited]) }
  finally { clearTimeout(terminate); process.off('SIGTERM', onShutdown); process.off('SIGINT', onShutdown) }
}
