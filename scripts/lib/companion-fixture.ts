import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CompanionHealth } from '../../packages/runtime/src/lifecycle'

/** Installation status is a fixture in isolated verification: these runs
 * exercise the canvas, Codex and MCP hosts, not the Mac app. package:verify
 * separately verifies activation and the real companion handshake. */
export const COMPANION_FIXTURE_HEALTH: CompanionHealth = {
  protocol: 1, version: '0.1.0', releaseId: 'native-test-adapter', channel: 'development',
  capabilities: ['canvas/1', 'codex/1', 'mcp/1'], runtime: { available: true }
}

/** Register `com.galta.companion` for an isolated Chrome profile. The host
 * answers status requests with the fixture health. */
export async function registerCompanionFixture(directory: string, hostDirectory: string, extensionId: string) {
  const wrapper = join(directory, 'companion.sh'), quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(import.meta.path)}\n`)
  await chmod(wrapper, 0o700)
  await writeFile(join(hostDirectory, 'com.galta.companion.json'), JSON.stringify({ name: 'com.galta.companion', description: 'Isolated verification companion fixture', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }))
}

if (import.meta.main) {
  let buffer = Buffer.alloc(0)
  for await (const chunk of Bun.stdin.stream()) {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
      const length = buffer.readUInt32LE(), request = JSON.parse(buffer.subarray(4, 4 + length).toString())
      buffer = buffer.subarray(4 + length)
      if (request.method !== 'status') throw new Error(`Unexpected companion request: ${request.method}`)
      const body = Buffer.from(JSON.stringify(COMPANION_FIXTURE_HEALTH)), header = Buffer.alloc(4)
      header.writeUInt32LE(body.length)
      process.stdout.write(Buffer.concat([header, body]))
    }
  }
}
