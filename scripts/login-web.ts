/** Explicit sign-in for the local preview; credentials stay in its private home. */
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { findCodex, codexEnvironment } from '../native/companion/codex'
import { embeddedCodexEnvironment } from '../native/adapters/codex/environment'

const found = (await findCodex()).codex
if (!found) throw new Error('A supported Codex installation is required.')
const runtime = resolve(import.meta.dir, '../output/web-app/runtime')
const embedded = embeddedCodexEnvironment(runtime, codexEnvironment(found.directory))
await mkdir(embedded.directory, { recursive: true, mode: 0o700 })
const child = Bun.spawn([found.path, '-c', 'cli_auth_credentials_store="file"', '-c', `sqlite_home=${JSON.stringify(embedded.directory)}`, 'login'], {
  cwd: runtime, env: embedded.environment, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit'
})
process.exit(await child.exited)
