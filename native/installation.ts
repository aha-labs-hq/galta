import { constants } from 'node:fs'
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { prepareGaltaDataDirectory } from './dataDirectory'
import { galtaPaths, nativeBinaryDirectory } from './paths'

const hosts = {
  codex: { binary: 'galta-codex-bridge', source: 'adapters/codex/galta-codex-bridge', description: "Galta Codex adapter for built-in chat" },
  canvas: { binary: 'galta-canvas-bridge', source: 'bridge/galta-canvas-bridge', description: 'Galta canvas bridge' },
} as const

/** Copy complete executables out of the checkout before registering a host. */
export async function installNativeHost(kind: keyof typeof hosts, extensionId: string | undefined, sourcePath?: string) {
  if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) throw new Error('A 32-character extension ID is required')
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Native host installation supports macOS and Linux')

  // Dia shares Chrome's registry. A packaged installation owns all registrations,
  // including repair after interrupted activation; never replace just one role.
  const registry = process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'google-chrome/NativeMessagingHosts')
  for (const marker of [join(galtaPaths.dataDirectory, 'current'), join(galtaPaths.dataDirectory, '.activation.json'), join(registry, 'com.galta.companion.json')]) {
    try { await lstat(marker) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    throw new Error('Galta for Mac manages this installation. Update the complete Mac app and choose “Connect browser”; standalone bridge installers cannot replace its runtime or registrations.')
  }

  const host = hosts[kind]
  const binaries: { source: string; name: string }[] = [{ source: resolve(sourcePath ?? join(import.meta.dir, host.source)), name: host.binary }]
  if (kind === 'canvas') binaries.push({ source: join(import.meta.dir, 'mcp/galta-mcp'), name: 'galta-mcp' })
  // Validate the entire payload before changing the installed runtime.
  for (const binary of binaries) await access(binary.source, constants.R_OK | constants.X_OK)
  const data = await prepareGaltaDataDirectory()
  await mkdir(nativeBinaryDirectory, { recursive: true, mode: 0o700 })
  const directory = await realpath(nativeBinaryDirectory)
  const staging = await mkdtemp(join(directory, '.install-'))
  try {
    for (const binary of binaries) {
      const temporary = join(staging, binary.name)
      await copyFile(binary.source, temporary, constants.COPYFILE_EXCL)
      await chmod(temporary, 0o700)
    }
    // Replacing directory entries keeps already-running binaries intact.
    for (const binary of binaries) await rename(join(staging, binary.name), join(directory, binary.name))
  } finally { await rm(staging, { recursive: true, force: true }) }

  await mkdir(registry, { recursive: true })
  const path = join(directory, host.binary), name = `com.galta.${kind}`
  const manifest = join(registry, `${name}.json`), temporary = join(registry, `.${name}-${crypto.randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify({ name, description: host.description, path, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, manifest)
  } finally { await rm(temporary, { force: true }) }
  return { manifest, path, dataDirectory: data.directory, migratedFrom: data.migratedFrom }
}
