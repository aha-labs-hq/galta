import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { galtaPaths } from '../paths'
import { prepareGaltaDataDirectory } from '../dataDirectory'
import { adoptBundledCodex, inspectCodex } from './codex'
import { hostRoles, readRelease } from './release'
import { inspectRelease } from './health'
import { lockActivation } from './lock'
import { atomicFile, runningCommands } from './system'
import { registeredExtensionId, registrationDirectory } from './registration'

type SavedFile = { path: string; contents: string | null }
type Journal = { schema: 1; previous: string | null; files: SavedFile[] }
const root = galtaPaths.dataDirectory
const current = join(root, 'current')
const lock = join(root, '.activation-lock')
const journalPath = join(root, '.activation.json')
const registry = registrationDirectory
const registrations = Object.keys(hostRoles).map(kind => join(registry, `com.galta.${kind}.json`))

async function exists(path: string) {
  try { await lstat(path); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
}
async function optionalFile(path: string) {
  try { return await readFile(path, 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}
async function selectedRelease() {
  try {
    if (!(await lstat(current)).isSymbolicLink()) throw new Error('Galta current release must be a symbolic link')
    return await readlink(current)
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}
async function selectRelease(target: string | null) {
  if (target === null) { await rm(current, { force: true }); return }
  const temporary = join(root, `.current-${crypto.randomUUID()}`)
  try { await symlink(target, temporary); await rename(temporary, current) }
  finally { await rm(temporary, { force: true }) }
}
async function restore(journal: Journal) {
  if (journal.schema !== 1 || journal.files.length !== registrations.length
    || journal.files.some((file, index) => file.path !== registrations[index])
    || (journal.previous !== null && !/^releases\/[\w.-]+$/.test(journal.previous))) throw new Error('Invalid activation recovery journal')
  await selectRelease(journal.previous)
  for (const file of journal.files) {
    if (file.contents === null) await rm(file.path, { force: true })
    else await atomicFile(file.path, file.contents)
  }
  await rm(journalPath)
}

/** After a switch, under the lock: remove every other release, and the
 * temporaries an interrupted activation left, that no process runs from.
 * Launchers resolve `current` once, so nothing new starts from a release that
 * is not selected; renaming before deleting keeps a launch from racing it. */
async function removeUnusedReleases(releases: string, selected: string) {
  const running = await runningCommands()
  const removed: string[] = []
  for (const name of await readdir(releases)) {
    const directory = join(releases, name)
    if (name === selected || running.includes(`${directory}/`)) continue
    const removing = join(releases, `.removing-${crypto.randomUUID()}`)
    await rename(directory, removing)
    await rm(removing, { recursive: true, force: true })
    if (!name.startsWith('.')) removed.push(name)
  }
  return removed
}

/** One switch selects a complete, verified release. Running processes keep their resolved release. */
export async function activateRelease(source: string) {
  if (process.platform !== 'darwin') throw new Error('The companion currently supports macOS')
  const { release, bytes, id } = await readRelease(source, true)
  const health = await inspectRelease(source)
  if (!health.runtime.available) throw new Error(health.runtime.error ?? 'The Galta runtime is incomplete')
  await prepareGaltaDataDirectory()
  const unlock = await lockActivation(lock, join(source, 'MacOS/galta-lock'))
  let staging: string | undefined
  try {
    await mkdir(registry, { recursive: true })
    const pending = await optionalFile(journalPath)
    if (pending) await restore(JSON.parse(pending) as Journal)
    const previous = await selectedRelease()
    if (previous) {
      // A selected release that is missing or unreadable is repaired; its
      // registrations still say which extension this installation serves.
      const active = await readRelease(join(root, previous)).catch(() => undefined)
      if ((active?.release.extensionId ?? await registeredExtensionId() ?? release.extensionId) !== release.extensionId) throw new Error('This Mac is connected to a different Galta extension. Keep development and published installations in separate macOS accounts.')
      if (active && release.channel !== 'development' && (release.build < active.release.build || (release.build === active.release.build && id !== active.id))) {
        throw new Error('This app is older than the installed release. Download the current Galta app.')
      }
    }
    // Refuse directories, symlinks and unreadable registrations before changing anything.
    const files: SavedFile[] = []
    for (const path of registrations) {
      try { if (!(await lstat(path)).isFile()) throw new Error(`Cannot replace native registration: ${path}`) }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      files.push({ path, contents: await optionalFile(path) })
    }
    await mkdir(join(root, 'releases'), { recursive: true, mode: 0o700 })
    const releases = await realpath(join(root, 'releases')), target = join(releases, id)
    // An immutable release is never written into. A damaged copy of this
    // build is set aside, and removed once nothing runs from it.
    if (await exists(target) && !await readRelease(target, true).then(() => true, () => false)) await rename(target, join(releases, `.damaged-${crypto.randomUUID()}`))
    if (!await exists(target)) {
      staging = join(releases, `.stage-${crypto.randomUUID()}`)
      for (const file of Object.keys(release.files)) {
        await mkdir(dirname(join(staging, file)), { recursive: true, mode: 0o700 })
        await copyFile(join(source, file), join(staging, file), constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
      }
      await writeFile(join(staging, 'Resources/release.json'), bytes, { mode: 0o600 })
      await readRelease(staging, true)
      await rename(staging, target)
      staging = undefined
    }
    const journal: Journal = { schema: 1, previous, files }
    await atomicFile(journalPath, JSON.stringify(journal))
    try {
      for (const [kind, role] of Object.entries(hostRoles)) await atomicFile(join(registry, `com.galta.${kind}.json`), JSON.stringify({
        name: `com.galta.${kind}`, description: `Galta ${kind}`, type: 'stdio',
        path: join(current, 'Resources', `galta-${role}`), allowed_origins: [`chrome-extension://${release.extensionId}/`],
      }, null, 2) + '\n')
      await selectRelease(`releases/${id}`)
      await rm(journalPath)
    } catch (error) { await restore(journal); throw error }
    // Keeping a bundled Codex and cleanup never undo a completed switch; their outcomes are reported with it.
    const adoption = previous && previous !== `releases/${id}` ? await adoptBundledCodex(join(root, previous)).then(version => version ? { adoptedCodex: version } : {}, (error: unknown) => ({ adoptionError: error instanceof Error ? error.message : String(error) })) : {}
    const cleanup = await removeUnusedReleases(releases, id).then(removedReleases => ({ removedReleases }), (error: unknown) => ({ removedReleases: [], cleanupError: error instanceof Error ? error.message : String(error) }))
    return { ...health, codex: await inspectCodex(), directory: await realpath(current), installation: { state: 'current' as const }, mcpCommand: join(current, 'Resources/galta-mcp'), ...adoption, ...cleanup }
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true })
    await unlock()
  }
}
