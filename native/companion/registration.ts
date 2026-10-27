import { access, lstat, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { galtaPaths } from '../paths'
import { hostRoles } from './release'

export const registrationDirectory = join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
export const currentRelease = join(galtaPaths.dataDirectory, 'current')

/** The extension the registrations admit, when they can be read. It names an
 * installation whose selected release is missing or unreadable. */
export async function registeredExtensionId() {
  try {
    const entry = JSON.parse(await readFile(join(registrationDirectory, 'com.galta.companion.json'), 'utf8'))
    return /^chrome-extension:\/\/([a-p]{32})\/$/.exec(entry.allowed_origins?.[0] ?? '')?.[1]
  } catch { return undefined }
}

/** An activation replaced the release a running host started from; a new check reaches the current one. */
export class ReleaseChangedError extends Error {}

/** The app and native host use the same definition of a registered installation. */
export async function assertRegistration(directory: string, extensionId: string) {
  try {
    await access(join(galtaPaths.dataDirectory, '.activation.json'))
    throw new Error('An interrupted installation needs repair.')
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (!(await lstat(currentRelease)).isSymbolicLink()) throw new Error('Galta current release must be a symbolic link.')
  if (await realpath(currentRelease) !== await realpath(directory)) throw new ReleaseChangedError('The installed release changed. Check the connection again.')
  for (const [kind, role] of Object.entries(hostRoles)) {
    const entry = JSON.parse(await readFile(join(registrationDirectory, `com.galta.${kind}.json`), 'utf8'))
    if (entry.name !== `com.galta.${kind}` || entry.type !== 'stdio'
      || entry.path !== join(currentRelease, 'Resources', `galta-${role}`)
      || entry.allowed_origins?.length !== 1 || entry.allowed_origins[0] !== `chrome-extension://${extensionId}/`) {
      throw new Error('Browser registration needs repair.')
    }
  }
}
