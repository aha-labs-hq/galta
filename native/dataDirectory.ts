import { chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { galtaPaths } from './paths'

type PrepareOptions = {
  dataDirectory?: string
  legacyDataDirectories?: readonly string[]
}

async function existingDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Galta data path is not a safe directory: ${path}`)
    return true
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error: any) { return error?.code !== 'ESRCH' }
}

async function refuseActiveLegacyBridges(root: string): Promise<void> {
  const directory = join(root, 'bridges')
  if (!await existingDirectory(directory)) return
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json')) continue
    try {
      const descriptor = JSON.parse(await readFile(join(directory, name), 'utf8'))
      if (Number.isInteger(descriptor?.pid) && descriptor.pid > 0 && processIsAlive(descriptor.pid)) {
        throw new Error('Close every open Galta canvas before upgrading its managed data directory')
      }
    } catch (error) {
      if (error instanceof SyntaxError) continue
      throw error
    }
  }
}

/**
 * Move the complete legacy data root exactly once. It never merges two roots:
 * that would make workspace ownership ambiguous and could silently overwrite
 * generated artifacts. Bridge descriptors are ephemeral and are discarded
 * only after proving that no legacy bridge process is still alive.
 */
export async function prepareGaltaDataDirectory({
  dataDirectory = galtaPaths.dataDirectory,
  legacyDataDirectories = galtaPaths.legacyDataDirectories
}: PrepareOptions = {}): Promise<{ directory: string; migratedFrom?: string }> {
  const destination = resolve(dataDirectory)
  const destinationExists = await existingDirectory(destination)
  const existingLegacy: string[] = []
  for (const candidate of legacyDataDirectories) {
    const legacy = resolve(candidate)
    if (legacy !== destination && await existingDirectory(legacy)) existingLegacy.push(legacy)
  }
  if (existingLegacy.length > 1) throw new Error(`Multiple legacy Galta data directories exist: ${existingLegacy.join(', ')}`)
  const legacy = existingLegacy[0]
  if (destinationExists && legacy) {
    if ((await readdir(destination)).length) throw new Error(`Galta data exists in both ${destination} and ${legacy}; resolve the conflict before installation`)
    await rmdir(destination)
  }
  if (!legacy) {
    await mkdir(destination, { recursive: true, mode: 0o700 })
    await chmod(destination, 0o700)
    return { directory: destination }
  }

  await refuseActiveLegacyBridges(legacy)
  await rm(join(legacy, 'bridges'), { recursive: true, force: true })
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await rename(legacy, destination)
  await chmod(destination, 0o700)
  return { directory: destination, migratedFrom: legacy }
}
