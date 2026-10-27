import { join } from 'node:path'
import { REQUIRED_CAPABILITIES, type CompanionHealth } from '../../packages/runtime/src/lifecycle'
import { checkRuntimeFiles, codexExecutable, readRelease } from './release'

/** A bounded, offline executable check. Account/model readiness is checked in the browser. */
export async function inspectRelease(directory: string): Promise<CompanionHealth> {
  const { release, id } = await readRelease(directory)
  let runtime: CompanionHealth['runtime']
  try {
    await checkRuntimeFiles(directory, release)
    const child = Bun.spawn([join(directory, codexExecutable), '--version'], { stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
    try {
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0 || !/^codex-cli \S+\s*$/.test(stdout)) throw new Error('Bundled Codex did not pass its startup check')
      runtime = { available: true, version: stdout.trim().replace('codex-cli ', '') }
    } finally { clearTimeout(timeout) }
  } catch (error) { runtime = { available: false, error: error instanceof Error ? error.message : 'Runtime unavailable' } }
  return { protocol: release.protocol, version: release.version, releaseId: id, channel: release.channel, capabilities: [...REQUIRED_CAPABILITIES], runtime }
}
