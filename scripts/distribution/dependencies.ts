import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checksum } from '../../native/companion/release'
import { root, run } from './config'

type Dependency = { version?: string; url: string; sha256: string }
/** Exact official artifacts, verified before extraction; nothing downloads at user install time. */
export async function prepareDependencies(cache: string) {
  const lock = await Bun.file(join(root, 'distribution/dependencies.json')).json() as Record<'sparkle' | 'codex' | 'codexLicense', Dependency>
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
  const sparkle = join(cache, `sparkle-${lock.sparkle.version}`), codex = join(cache, `codex-${lock.codex.sha256}`)
  await mkdir(sparkle, { recursive: true }); await mkdir(codex, { recursive: true })
  run(['/usr/bin/tar', '-xf', join(cache, 'sparkle'), '-C', sparkle])
  run(['/usr/bin/tar', '-xf', join(cache, 'codex'), '-C', codex])
  const manifest = await Bun.file(join(codex, 'codex-package.json')).json()
  if (manifest.layoutVersion !== 1 || manifest.version !== lock.codex.version || manifest.target !== 'aarch64-apple-darwin'
    || manifest.variant !== 'codex' || manifest.entrypoint !== 'bin/codex' || manifest.resourcesDir !== 'codex-resources' || manifest.pathDir !== 'codex-path') throw new Error('Unsupported Codex package layout')
  await writeFile(join(cache, 'resolved.json'), JSON.stringify(lock, null, 2))
  return { sparkle, codex, codexLicense: join(cache, 'codexLicense'), lock }
}
