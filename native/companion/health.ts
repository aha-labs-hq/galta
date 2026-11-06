import { REQUIRED_CAPABILITIES, type CompanionHealth } from '../../packages/runtime/src/lifecycle'
import { checkRuntimeFiles, readRelease, speechExecutable } from './release'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

/** A bounded, offline check of the release's own executables. Codex is
 * reported separately (`inspectCodex`): canvas access never depends on it.
 * Account/model readiness is checked in the browser. */
export async function inspectRelease(directory: string): Promise<CompanionHealth> {
  const { release, id } = await readRelease(directory)
  let runtime: CompanionHealth['runtime']
  try {
    await checkRuntimeFiles(directory, release)
    runtime = { available: true }
  } catch (error) { runtime = { available: false, error: error instanceof Error ? error.message : 'Runtime unavailable' } }
  const capabilities: string[] = [...REQUIRED_CAPABILITIES]
  if (release.files[speechExecutable]) {
    try { await access(join(directory, speechExecutable), constants.X_OK); capabilities.push('speech/1') } catch { /* Optional speech must not block canvas access. */ }
  }
  return { protocol: release.protocol, version: release.version, releaseId: id, channel: release.channel, capabilities, runtime }
}
