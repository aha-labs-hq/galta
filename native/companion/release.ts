import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { COMPANION_PROTOCOL } from '../../packages/runtime/src/lifecycle'

export type Release = {
  schema: 1; version: string; build: number; protocol: number
  extensionId: string; channel: 'development' | 'beta' | 'stable'
  files: Record<string, string>
}
export const hostRoles = { canvas: 'canvas-bridge', codex: 'codex-bridge', companion: 'companion' } as const
export const runtimeBundle = 'Helpers/GaltaRuntime.app'
export const runtimeExecutable = `${runtimeBundle}/Contents/MacOS/galta-runtime`
export const runtimeBundleIdentifier = (channel: Release['channel']) => `com.galta.runtime${channel === 'development' ? '.development' : ''}`
export const runtimeExecutables = [runtimeExecutable, 'MacOS/galta-lock', 'Resources/galta-canvas-bridge', 'Resources/galta-codex-bridge', 'Resources/galta-mcp', 'Resources/galta-companion'] as const
export const runtimeFiles = [...runtimeExecutables, `${runtimeBundle}/Contents/Info.plist`, `${runtimeBundle}/Contents/_CodeSignature/CodeResources`] as const
export const checksum = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Cheap readiness check; activation also verifies every payload checksum. */
export async function checkRuntimeFiles(directory: string, release: Release) {
  for (const file of runtimeFiles) {
    if (!release.files[file]) throw new Error(`Incomplete release: ${file}`)
    await access(join(directory, file), constants.R_OK | (runtimeExecutables.includes(file as typeof runtimeExecutables[number]) ? constants.X_OK : 0))
  }
}

export async function readRelease(directory: string, verify = false) {
  const bytes = await readFile(join(directory, 'Resources/release.json'))
  const release = JSON.parse(bytes.toString()) as Release
  if (release.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(release.version) || !Number.isSafeInteger(release.build) || release.build < 1
    || release.protocol !== COMPANION_PROTOCOL || !/^[a-p]{32}$/.test(release.extensionId)
    || !['development', 'beta', 'stable'].includes(release.channel) || !release.files) throw new Error('Unsupported Galta release')
  // Metadata-only reads allow an older release to be identified during upgrade.
  // Incoming payloads and readiness checks always require the complete runtime.
  if (verify) await checkRuntimeFiles(directory, release)
  for (const [file, hash] of Object.entries(release.files)) {
    if (!/^(MacOS|Resources|Helpers)\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(file) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid release file')
    if (verify) {
      if (checksum(await readFile(join(directory, file))) !== hash) throw new Error(`Release checksum failed: ${file}`)
    }
  }
  return { release, bytes, id: `${release.version}-${release.build}-${checksum(bytes).slice(0, 16)}` }
}
