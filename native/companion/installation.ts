import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { galtaPaths } from '../paths'
import { inspectCodex } from './codex'
import { inspectRelease } from './health'
import { assertRegistration, currentRelease, registeredExtensionId, registrationDirectory } from './registration'
import { hostRoles, readRelease } from './release'

export type Installation = {
  state: 'absent' | 'current' | 'update-available' | 'repair-required' | 'conflict' | 'unavailable'
  detail?: string
}

async function exists(path: string) {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

/** Read-only inspection. Opening the app must not rewrite a healthy installation. */
export async function inspectInstallation(source: string) {
  const health = await inspectRelease(source)
  const { release } = await readRelease(source)
  let installation: Installation
  try {
    const pending = await exists(join(galtaPaths.dataDirectory, '.activation.json'))
    const selected = await exists(currentRelease)
    const registered = (await Promise.all(Object.keys(hostRoles).map(kind => exists(join(registrationDirectory, `com.galta.${kind}.json`))))).some(Boolean)
    if (!selected && !pending && !registered) installation = { state: 'absent' }
    else {
      if (pending) throw new Error('An interrupted installation needs repair.')
      if (!selected) throw new Error('The browser registration has no selected runtime. Repair the connection.')
      // Only a selected release that is not a symbolic link is beyond repair.
      if (!(await lstat(currentRelease)).isSymbolicLink()) return { ...health, installation: { state: 'unavailable' as const, detail: 'The installed release cannot be read. Galta current release must be a symbolic link.' } }
      let active: Awaited<ReturnType<typeof readRelease>>
      try { active = await readRelease(currentRelease) }
      catch (error) {
        const registered = await registeredExtensionId()
        if (registered && registered !== release.extensionId) return { ...health, installation: { state: 'conflict' as const, detail: 'This Mac is registered to a different Galta extension. Use the matching Mac app.' } }
        return { ...health, installation: { state: 'repair-required' as const, detail: `The installed runtime is missing or unreadable. Repair the connection to install it again. ${error instanceof Error ? error.message : ''}`.trim() } }
      }
      if (active.release.extensionId !== release.extensionId) {
        installation = { state: 'conflict', detail: 'This Mac is registered to a different Galta extension. Use the matching Mac app.' }
      } else if (release.channel !== 'development' && (release.build < active.release.build || (release.build === active.release.build && health.releaseId !== active.id))) {
        installation = { state: 'conflict', detail: 'A newer Galta runtime is installed. Open the latest Mac app.' }
      } else {
        await assertRegistration(currentRelease, release.extensionId)
        installation = { state: active.id === health.releaseId ? 'current' : 'update-available' }
        if (installation.state === 'current') {
          const activeHealth = await inspectRelease(currentRelease)
          if (!activeHealth.runtime.available) installation = { state: 'repair-required', detail: `The installed runtime is damaged. Repair the connection to install it again. ${activeHealth.runtime.error ?? ''}`.trim() }
        }
      }
    }
  } catch (error) {
    installation = { state: 'repair-required', detail: error instanceof Error ? error.message : 'The installation could not be checked.' }
  }
  return { ...health, codex: await inspectCodex(), installation, ...(installation.state === 'current' && health.runtime.available ? { mcpCommand: join(currentRelease, 'Resources/galta-mcp') } : {}) }
}
