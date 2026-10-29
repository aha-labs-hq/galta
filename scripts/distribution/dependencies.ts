import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { checksum } from '../../native/companion/release'
import { root, run } from './config'

type Dependency = { version?: string; url: string; sha256: string }
/** Exact official artifacts, verified before extraction. Codex is not
 * packaged: its archive is cached for package verification, which installs it
 * the way the runtime's download does. */
export async function prepareDependencies(cache: string) {
  const lock = await Bun.file(join(root, 'distribution/dependencies.json')).json() as Record<'sparkle' | 'codex' | 'dmgbuild' | 'dsStore' | 'macAlias', Dependency>
  await mkdir(cache, { recursive: true })
  for (const [name, dependency] of Object.entries(lock)) {
    const file = join(cache, name)
    let valid = false
    try { valid = checksum(await readFile(file)) === dependency.sha256 } catch {}
    if (valid) continue
    const temporary = `${file}.download`
    try {
      run(['/usr/bin/curl', '--fail', '--location', '--silent', '--show-error', dependency.url, '-o', temporary])
      if (checksum(await readFile(temporary)) !== dependency.sha256) throw new Error(`Dependency checksum failed: ${name}`)
      await rename(temporary, file)
    } finally { await rm(temporary, { force: true }) }
  }
  const sparkle = join(cache, `sparkle-${lock.sparkle.version}`)
  await mkdir(sparkle, { recursive: true })
  run(['/usr/bin/tar', '-xf', join(cache, 'sparkle'), '-C', sparkle])
  // The install window's builder and its two libraries, as pip expects wheels named.
  const wheels = join(cache, 'wheels'); await mkdir(wheels, { recursive: true })
  const dmgbuild = await Promise.all((['dmgbuild', 'dsStore', 'macAlias'] as const).map(async name => {
    const wheel = join(wheels, basename(new URL(lock[name].url).pathname)); await copyFile(join(cache, name), wheel); return wheel
  }))
  await writeFile(join(cache, 'resolved.json'), JSON.stringify(lock, null, 2))
  return { sparkle, codexArchive: join(cache, 'codex'), dmgbuild, lock }
}
