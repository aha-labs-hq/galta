import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import dependencies from '../../distribution/dependencies.json'
import type { CodexAvailability } from '../../packages/runtime/src/lifecycle'
import { galtaPaths } from '../paths'
import { lockActivation } from './lock'
import { atomicFile, runningCommands } from './system'
import { checksum, readRelease } from './release'

/** Chat in Galta runs on Codex. Galta uses the user's own when it is at least
 * the version Galta was tested with, and otherwise a copy of that official
 * package, downloaded into Galta's data directory only when the user asks.
 * Codex the user installed is only ever read, never changed. */
export type CodexPackage = { version: string; url: string; sha256: string; bytes: number }
export const codexPackage: CodexPackage = dependencies.codex
/** `directory` is where it was found: see `codexEnvironment`. */
export type FoundCodex = { path: string; directory: string; version: string; source: 'yours' | 'galta' }
type Options = { home?: string; directory?: string; env?: Readonly<Record<string, string | undefined>> }

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/
/** Where Mac apps up to 0.1.4 bundled Codex. */
const bundledPackage = 'Resources/codex'

/** Semantic version order, a prerelease before its release:
 * 0.162.0-alpha.17.2 < 0.162.0 < 0.165.0-alpha.1.2. */
export function compareCodexVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const dash = version.indexOf('-')
    return { core: (dash < 0 ? version : version.slice(0, dash)).split('.').map(Number), pre: dash < 0 ? [] : version.slice(dash + 1).split('.') }
  }
  const x = parse(a), y = parse(b)
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0)
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const m = /^\d+$/.test(p), n = /^\d+$/.test(q)
    if (m && n) return Number(p) - Number(q)
    if (m !== n) return m ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/** Where people install Codex on a Mac: inside ChatGPT or Codex for Mac, the
 * standalone installer, Homebrew, npm's usual prefixes (nvm, Volta, Bun, pnpm)
 * and this host's PATH. A browser starts Galta with a minimal PATH, so each is
 * looked up directly. GALTA_CODEX_CANDIDATES (colon-separated) replaces the
 * list, for verification on a Mac that has its own Codex. */
export async function codexCandidates({ home = homedir(), env = process.env }: Options = {}) {
  if (env.GALTA_CODEX_CANDIDATES !== undefined) return env.GALTA_CODEX_CANDIDATES.split(':').filter(Boolean)
  const nvm = join(home, '.nvm/versions/node'), onPath = Bun.which('codex', { PATH: env.PATH ?? '' })
  return [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    join(home, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'),
    '/Applications/Codex.app/Contents/Resources/codex',
    join(home, 'Applications/Codex.app/Contents/Resources/codex'),
    join(home, '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(home, '.npm-global/bin/codex'),
    join(home, '.volta/bin/codex'),
    join(home, '.bun/bin/codex'),
    join(home, 'Library/pnpm/codex'),
    ...(await readdir(nvm).catch(() => [] as string[])).sort().map(version => join(nvm, version, 'bin/codex')),
    ...(onPath ? [onPath] : [])
  ]
}

/** Run a Codex the user installed as they would. A browser gives Galta a
 * minimal PATH, and an npm install is a `#!/usr/bin/env node` script whose
 * interpreter sits beside it, so the directory it was found in comes first. */
export const codexEnvironment = (directory: string, env: Readonly<Record<string, string | undefined>> = process.env) =>
  ({ ...env, PATH: `${directory}:${env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}` })

/** The version an executable reports, if it is Codex and starts within 5 s. */
export async function codexVersion(path: string, directory = dirname(path)): Promise<string | undefined> {
  try {
    const child = Bun.spawn([path, '--version'], { env: codexEnvironment(directory), stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
    try {
      const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
      const version = /^codex-cli (\S+)\s*$/.exec(output)?.[1]
      return code === 0 && version && VERSION.test(version) ? version : undefined
    } finally { clearTimeout(timeout) }
  } catch { return undefined }
}

const newest = <T extends { version: string }>(list: T[]) => list.reduce<T | undefined>((best, item) => !best || compareCodexVersions(item.version, best.version) > 0 ? item : best, undefined)
const supported = (found: { version: string }) => compareCodexVersions(found.version, codexPackage.version) >= 0

/** The user's newest supported Codex, else Galta's own copy. `outdated` is the
 * newest Codex found, the user's or Galta's, when none is new enough. */
export async function findCodex(options: Options = {}): Promise<{ codex?: FoundCodex; outdated?: FoundCodex }> {
  const directory = options.directory ?? galtaPaths.codexDirectory
  /** Each installation once, as first listed; a link is run as itself, since
   * some (Volta's shims) need the name they were called by. */
  const inspect = async (paths: string[]) => {
    const real = await Promise.all(paths.map(path => realpath(path).catch(() => undefined)))
    const unique = paths.filter((path, index) => real[index] && real.indexOf(real[index]) === index)
    return (await Promise.all(unique.map(async path => {
      const version = await codexVersion(path)
      return version ? { path, directory: dirname(path), version } : undefined
    }))).filter(found => found !== undefined)
  }
  const yours = await inspect(await codexCandidates(options))
  const own = newest(yours.filter(supported))
  if (own) return { codex: { ...own, source: 'yours' } }
  const copies = (await readdir(directory).catch(() => [] as string[])).filter(name => VERSION.test(name))
  // A copy below the pin is one an older Galta downloaded.
  const mine = (await inspect(copies.map(name => join(directory, name, 'bin/codex')))).map(found => ({ ...found, source: 'galta' as const }))
  const galta = newest(mine.filter(supported))
  const outdated = newest([...yours.map(found => ({ ...found, source: 'yours' as const })), ...mine])
  return { ...(galta ? { codex: galta } : {}), ...(outdated ? { outdated } : {}) }
}

type DownloadState = { pid: number; received: number; error?: string }
const stateFile = (directory: string) => join(directory, '.download.json')
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } }

async function readDownload(directory: string): Promise<{ received: number } | { error: string } | undefined> {
  let state: DownloadState, modified: number
  try { state = JSON.parse(await readFile(stateFile(directory), 'utf8')); modified = (await stat(stateFile(directory))).mtimeMs }
  catch { return undefined }
  if (state.error) return { error: state.error }
  // A running download rewrites its state while bytes arrive and fails within a
  // minute when they stop. An older state is a worker that died, whatever
  // process now has its ID.
  return alive(state.pid) && Date.now() - modified < 120_000 ? { received: state.received } : { error: 'The Codex download stopped before it finished. Try again.' }
}

const writeDownload = (directory: string, state: DownloadState) => atomicFile(stateFile(directory), JSON.stringify(state))

/** What Chat in Galta would run, for the browser and the Mac app. */
export async function inspectCodex(options: Options = {}): Promise<CodexAvailability> {
  const env = options.env ?? process.env, directory = options.directory ?? galtaPaths.codexDirectory
  const download = { version: codexPackage.version, bytes: codexPackage.bytes }
  // A developer's explicit choice is authoritative, whatever its version.
  if (env.GALTA_CODEX_BIN) {
    const version = await codexVersion(env.GALTA_CODEX_BIN)
    return version ? { state: 'ready', version, source: 'override' } : { state: 'failed', error: 'GALTA_CODEX_BIN does not start Codex.', download }
  }
  // While a download runs, its progress is the answer; the browser asks every
  // second, and starting each Codex the user installed every time is waste.
  const progress = await readDownload(directory)
  if (progress && 'received' in progress) return { state: 'downloading', received: progress.received, download }
  const { codex, outdated } = await findCodex(options)
  if (codex) return { state: 'ready', version: codex.version, source: codex.source }
  if (progress) return { state: 'failed', error: progress.error, download }
  if (outdated) return { state: 'outdated', version: outdated.version, source: outdated.source, minimum: codexPackage.version, download }
  return { state: 'missing', download }
}

/** The user asked for Codex: start one detached download that outlives this
 * browser request, and wait briefly until it reports, so the reply shows it. */
export async function startCodexDownload(command: string[], options: Options = {}) {
  const directory = options.directory ?? galtaPaths.codexDirectory
  const before = await readDownload(directory)
  if (before && 'received' in before) return
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: 'ignore', env: { ...process.env, ...options.env } })
  let exited = false
  child.once('exit', () => { exited = true }); child.once('error', () => { exited = true })
  child.unref()
  for (const deadline = Date.now() + 3_000; Date.now() < deadline && !exited;) {
    const state = await readDownload(directory)
    if (state && 'received' in state) return
    await Bun.sleep(50)
  }
}

/** A message for the user, as opposed to an unexpected failure. */
class DownloadProblem extends Error {}

/** The detached download: the pinned package, checked against its digest
 * while it streams, unpacked and started once before it takes its place. A
 * kernel lock keeps it to one at a time. Only Galta's directory changes. */
export async function downloadCodex(options: Options & { lockExecutable?: string; package?: CodexPackage; stallMs?: number } = {}) {
  const env = options.env ?? process.env, pkg = options.package ?? codexPackage
  const directory = options.directory ?? galtaPaths.codexDirectory
  // Verification serves the pinned bytes from a local file; the digest still decides.
  const url = env.GALTA_CODEX_PACKAGE_URL ?? pkg.url
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let unlock: () => Promise<void>
  try { unlock = await lockActivation(join(directory, '.download-lock'), options.lockExecutable ?? join(env.GALTA_RELEASE_DIRECTORY ?? '', 'MacOS/galta-lock')) }
  catch (error) {
    // Another download holds the lock and reports its own progress; never
    // write over it. Any other failure is this download's to report.
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    if (!message.includes('in progress')) await writeDownload(directory, { pid: process.pid, received: 0, error: 'Codex couldn’t be downloaded. Open Galta on your Mac to check its installation.' })
    return
  }
  const id = crypto.randomUUID(), archive = join(directory, `.archive-${id}`), stage = join(directory, `.stage-${id}`)
  let received = 0, step: 'download' | 'unpack' = 'download'
  // A connection that stops delivering ends the download, so the user can try again.
  const stalled = new AbortController()
  let stall: ReturnType<typeof setTimeout> | undefined
  const progressed = () => { clearTimeout(stall); stall = setTimeout(() => stalled.abort(), options.stallMs ?? 60_000) }
  try {
    // Holding the lock, anything temporary here is an interrupted download's.
    for (const name of await readdir(directory)) if (/^\.(archive|stage|removing)-/.test(name)) await rm(join(directory, name), { recursive: true, force: true })
    // Codex may have arrived since the user asked: their own, or a download
    // that finished meanwhile. Then there is nothing to fetch.
    if ((await findCodex({ ...options, directory })).codex) { await rm(stateFile(directory), { force: true }); return }
    await writeDownload(directory, { pid: process.pid, received })
    progressed()
    const response = url.startsWith('file:') ? new Response(Bun.file(fileURLToPath(url))) : await fetch(url, { signal: stalled.signal })
    if (!response.ok || !response.body) throw new DownloadProblem(`Codex couldn’t be downloaded (HTTP ${response.status}). Try again later.`)
    const file = await open(archive, 'wx', 0o600), hash = createHash('sha256')
    try {
      let reported = 0
      for await (const chunk of response.body) {
        progressed()
        received += chunk.byteLength
        if (received > pkg.bytes) break
        hash.update(chunk)
        await file.write(chunk)
        if (Date.now() - reported >= 250) { reported = Date.now(); await writeDownload(directory, { pid: process.pid, received }) }
      }
    } finally { await file.close() }
    clearTimeout(stall)
    if (received !== pkg.bytes || hash.digest('hex') !== pkg.sha256) throw new DownloadProblem('The download didn’t match the Codex package Galta expects. Try again.')
    step = 'unpack'
    await writeDownload(directory, { pid: process.pid, received })
    await mkdir(stage, { mode: 0o700 })
    const tar = Bun.spawn(['/usr/bin/tar', '-xf', archive, '-C', stage], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
    const [code, errors] = await Promise.all([tar.exited, new Response(tar.stderr).text()])
    if (code !== 0) throw new Error(errors.trim())
    await rm(archive, { force: true })
    await unquarantine(stage)
    await verifyCodexPackage(stage, pkg.version)
    await place(stage, join(directory, pkg.version), pkg.version)
    await rm(stateFile(directory), { force: true })
    await removeUnusedCopies(directory, pkg.version).catch(() => undefined)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    const message = error instanceof DownloadProblem ? error.message
      : stalled.signal.aborted ? 'The Codex download stopped making progress. Check your internet connection and try again.'
      : (error as NodeJS.ErrnoException).code === 'ENOSPC' ? 'This Mac is out of disk space for Codex. Free up some space and try again.'
      : step === 'download' ? 'Codex couldn’t be downloaded. Check your internet connection and try again.'
      : 'The downloaded Codex didn’t start. Try again.'
    await writeDownload(directory, { pid: process.pid, received, error: message })
  } finally {
    clearTimeout(stall)
    await rm(archive, { force: true })
    await rm(stage, { recursive: true, force: true })
    await unlock()
  }
}

/** A browser starts Galta, so macOS quarantines everything Galta writes as
 * the browser's download, and Gatekeeper would stop Codex's first start to ask
 * the user, failing the start. These are the pinned package's bytes, checked
 * by digest; Galta vouches for them, as Sparkle does for an update it verified. */
async function unquarantine(directory: string) {
  const xattr = Bun.spawn(['/usr/bin/xattr', '-dr', 'com.apple.quarantine', directory], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
  const [code, errors] = await Promise.all([xattr.exited, new Response(xattr.stderr).text()])
  if (code !== 0) throw new Error(`Codex could not leave quarantine: ${errors.trim()}`)
}

/** The official layout, at the expected version, and it starts. */
export async function verifyCodexPackage(directory: string, version: string) {
  const manifest = JSON.parse(await readFile(join(directory, 'codex-package.json'), 'utf8'))
  if (manifest.layoutVersion !== 1 || manifest.version !== version || manifest.target !== 'aarch64-apple-darwin' || manifest.variant !== 'codex'
    || manifest.entrypoint !== 'bin/codex' || manifest.resourcesDir !== 'codex-resources' || manifest.pathDir !== 'codex-path') throw new Error('Unsupported Codex package layout')
  if (await codexVersion(join(directory, 'bin/codex')) !== version) throw new Error('The Codex package did not start')
}

/** Rename a verified package into place. A valid copy already there (another
 * download, or one kept from the app) stays; a damaged one is replaced. */
async function place(stage: string, target: string, version: string) {
  try { await rename(stage, target); return }
  catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
  if (await verifyCodexPackage(target, version).then(() => true, () => false)) return
  const damaged = join(dirname(target), `.removing-${crypto.randomUUID()}`)
  await rename(target, damaged)
  await rename(stage, target)
  await rm(damaged, { recursive: true, force: true })
}

/** Older copies Galta kept, once nothing runs from them. */
async function removeUnusedCopies(directory: string, keep: string) {
  const running = await runningCommands()
  for (const name of await readdir(directory)) {
    if (name === keep || !VERSION.test(name) || running.includes(`${join(directory, name)}/`)) continue
    const removing = join(directory, `.removing-${crypto.randomUUID()}`)
    await rename(join(directory, name), removing)
    await rm(removing, { recursive: true, force: true })
  }
}

/** A Mac app that bundled Codex leaves it in the release it replaces. When the
 * user has no supported Codex, Galta keeps that copy, verified against the
 * release's digests, so Chat keeps working without a download. Runs under the
 * activation lock, before the old release is removed. */
export async function adoptBundledCodex(release: string, options: Options = {}): Promise<string | undefined> {
  const directory = options.directory ?? galtaPaths.codexDirectory
  let version: unknown
  try { version = JSON.parse(await readFile(join(release, bundledPackage, 'codex-package.json'), 'utf8')).version }
  catch { return undefined }
  if (typeof version !== 'string' || !VERSION.test(version) || !supported({ version }) || (await findCodex(options)).codex) return undefined
  const { release: manifest } = await readRelease(release)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const name of await readdir(directory)) if (name.startsWith('.adopting-')) await rm(join(directory, name), { recursive: true, force: true })
  const stage = join(directory, `.adopting-${crypto.randomUUID()}`)
  try {
    for (const [file, hash] of Object.entries(manifest.files)) {
      if (!file.startsWith(`${bundledPackage}/`)) continue
      const target = join(stage, file.slice(bundledPackage.length + 1))
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await copyFile(join(release, file), target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
      if (checksum(await readFile(target)) !== hash) throw new Error(`Bundled Codex checksum failed: ${file}`)
    }
    await verifyCodexPackage(stage, version)
    await place(stage, join(directory, version), version)
    return version
  } finally { await rm(stage, { recursive: true, force: true }) }
}
