import { REQUIRED_CAPABILITIES, type CompanionHealth } from '../../packages/runtime/src/lifecycle'
import { checkRuntimeFiles, readRelease } from './release'

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
  return { protocol: release.protocol, version: release.version, releaseId: id, channel: release.channel, capabilities: [...REQUIRED_CAPABILITIES], runtime }
}
