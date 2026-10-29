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
import { CODEX_EMBEDDED_ARGS } from '../../../packages/runtime/src/codexConfig'
import { galtaToolContract } from '../../../packages/canvas/src/contract'
import { EMBEDDED_MCP_ENV, EMBEDDED_TOOL_TIMEOUT_SECONDS } from '../../../packages/canvas/src/execution'
import { codexEnvironment, findCodex } from '../../companion/codex'

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
const galtaMcp = Bun.env.GALTA_MCP_BIN ?? join(nativeBinaryDirectory, 'galta-mcp')
if (!existsSync(galtaMcp)) throw new Error('Install the Galta canvas bridge before connecting Codex; the MCP executable is missing')
const child = Bun.spawn([codexBinary, 'app-server', '--stdio', ...CODEX_EMBEDDED_ARGS,
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
  // The user's own Codex runs with the PATH its installation needs.
  env: found ? codexEnvironment(found.directory) : process.env,
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'inherit'
})

const codexReader = child.stdout.getReader()

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
      if (message.method === 'galta/config/read') {
        try {
          const result = { toolContract: await galtaToolContract() }
          await sendToChrome({ id: message.id, result })
        } catch (error) {
          await sendToChrome({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Runtime configuration request failed' } })
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
      await sendToChrome(message)
    }
  }
}

// Either peer closing ends this relay. Waiting for both leaves an orphaned
// app-server when the browser closes the side panel or reloads the extension.
try {
  await Promise.race([readChrome(sendToCodex), readCodex()])
} finally {
  child.stdin.end()
  child.kill()
  // Promise.race does not cancel its other read loop. Without this, an exited
  // app-server leaves the relay alive waiting on the browser's still-open stdin.
  await Promise.all([chromeReader.cancel(), codexReader.cancel()])
}
