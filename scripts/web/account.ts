import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAccountService } from '../../apps/extension/src/shared/accountService'
import type { StoredAccount } from '../../apps/extension/src/shared/account'

/** The local preview owns its own Aha Labs session. It is unrelated to Codex
 * sign-in, and never copies a session from the user's installed extension. */
export function webAccount(directory: string, changed: () => void) {
  const path = join(directory, 'account.json')
  return createAccountService({
    async read(): Promise<StoredAccount> {
      try { return JSON.parse(await readFile(path, 'utf8')) as StoredAccount }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
    },
    async write(value) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = `${path}.tmp`
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
      await rename(temporary, path); changed()
    },
    readGoogle: async () => undefined,
    writeGoogle: async () => {},
    openGoogle: async () => { throw new Error('Continue with email in the local preview.') },
    showGoogle: async () => false,
    closeGoogle: async () => {},
  })
}
