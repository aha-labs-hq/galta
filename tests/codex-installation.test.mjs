import { test, expect, afterAll } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { codexCandidates, codexPackage, compareCodexVersions, downloadCodex, findCodex, inspectCodex } from '../native/companion/codex.ts'
import { lockActivation } from '../native/companion/lock.ts'
import { checksum } from '../native/companion/release.ts'

const project = resolve(import.meta.dir, '..')
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'galta-codex-install-')))
const lockBinary = join(scratch, 'galta-lock')
const compiled = process.platform === 'darwin' ? Bun.spawnSync(['/usr/bin/cc', '-O2', join(project, 'native/companion/activation-lock.c'), '-o', lockBinary]) : { exitCode: 0, stderr: '' }
if (compiled.exitCode) throw new Error(compiled.stderr.toString())
afterAll(() => rm(scratch, { recursive: true, force: true }))

const pinned = codexPackage.version
async function codex(path, version, { broken = false } = {}) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, broken ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\necho codex-cli ${version}\n`)
  await chmod(path, 0o755)
  return path
}
/** A Mac with no Codex of its own: this machine's installations stay out of sight. */
async function place() {
  const home = await mkdtemp(join(scratch, 'home-'))
  return { home, directory: join(home, 'galta-codex'), env: { GALTA_CODEX_CANDIDATES: '' } }
}

test('Codex versions order by semantic version, a prerelease before its release', () => {
  const ordered = ['0.154.0', '0.162.0-alpha.9', '0.162.0-alpha.17.2', '0.162.0-beta', '0.162.0', '0.165.0-alpha.1.2', '0.165.0', '1.0.0']
  for (let i = 1; i < ordered.length; i++) {
    expect(compareCodexVersions(ordered[i - 1], ordered[i])).toBeLessThan(0)
    expect(compareCodexVersions(ordered[i], ordered[i - 1])).toBeGreaterThan(0)
  }
  expect(compareCodexVersions(pinned, pinned)).toBe(0)
})

test('the user’s newest supported Codex is used; older or broken ones are skipped, and a link is one installation', async () => {
  const { home, directory, env } = await place()
  const newer = await codex(join(home, 'ChatGPT/codex'), '0.165.0-alpha.1.2')
  const link = join(home, 'link/codex')
  await mkdir(join(home, 'link')); await symlink(newer, link)
  const candidates = [await codex(join(home, 'brew/codex'), '0.150.0'), await codex(join(home, 'broken/codex'), '', { broken: true }), link, newer, await codex(join(home, 'pinned/codex'), pinned), join(home, 'missing/codex')]
  const found = await findCodex({ directory, env: { GALTA_CODEX_CANDIDATES: candidates.join(':') } })
  // The link is listed first, so that is the one run, as itself.
  expect(found.codex).toEqual({ path: link, directory: dirname(link), version: '0.165.0-alpha.1.2', source: 'yours' })
  expect(await inspectCodex({ directory, env: { GALTA_CODEX_CANDIDATES: candidates.join(':') } })).toEqual({ state: 'ready', version: '0.165.0-alpha.1.2', source: 'yours' })
  // Only an outdated Codex: say so, and offer the tested package.
  const download = { version: pinned, bytes: codexPackage.bytes }
  expect(await inspectCodex({ directory, env: { GALTA_CODEX_CANDIDATES: candidates[0] } })).toEqual({ state: 'outdated', version: '0.150.0', source: 'yours', minimum: pinned, download })
  expect(await inspectCodex({ directory, env: { ...env, GALTA_CODEX_CANDIDATES: '' } })).toEqual({ state: 'missing', download })
  // Galta's own copy serves when the user has no supported Codex, never ahead of theirs.
  const copy = await codex(join(directory, pinned, 'bin/codex'), pinned)
  expect((await findCodex({ directory, env: { GALTA_CODEX_CANDIDATES: candidates[0] } })).codex).toEqual({ path: copy, directory: dirname(copy), version: pinned, source: 'galta' })
  expect((await findCodex({ directory, env: { GALTA_CODEX_CANDIDATES: newer } })).codex?.source).toBe('yours')
  // A copy an older Galta downloaded, below today's pin, is outdated, not missing.
  const older = await place()
  await codex(join(older.directory, '0.150.0/bin/codex'), '0.150.0')
  expect(await inspectCodex({ directory: older.directory, env: { GALTA_CODEX_CANDIDATES: '' } })).toEqual({ state: 'outdated', version: '0.150.0', source: 'galta', minimum: pinned, download })
  // A developer's explicit executable is authoritative, and a broken one says so.
  expect(await inspectCodex({ directory, env: { GALTA_CODEX_BIN: candidates[0] } })).toEqual({ state: 'ready', version: '0.150.0', source: 'override' })
  expect(await inspectCodex({ directory, env: { GALTA_CODEX_BIN: join(home, 'missing/codex') } })).toMatchObject({ state: 'failed' })
})

test('an npm install runs with its interpreter beside it, and npm prefixes are searched', async () => {
  const { home, directory } = await place()
  // npm installs `#!/usr/bin/env node`; a browser's PATH has no node.
  const bin = join(home, '.nvm/versions/node/v22.11.0/bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'galta-test-node'), '#!/bin/sh\necho codex-cli 0.166.0\n'); await chmod(join(bin, 'galta-test-node'), 0o755)
  await writeFile(join(bin, 'codex'), '#!/usr/bin/env galta-test-node\n'); await chmod(join(bin, 'codex'), 0o755)
  const candidates = await codexCandidates({ home, env: { PATH: '/usr/bin:/bin' } })
  expect(candidates).toContain(join(bin, 'codex'))
  for (const prefix of ['.npm-global/bin/codex', '.volta/bin/codex', '.bun/bin/codex', 'Library/pnpm/codex', '.local/bin/codex']) expect(candidates).toContain(join(home, prefix))
  expect(await inspectCodex({ directory, env: { GALTA_CODEX_CANDIDATES: join(bin, 'codex'), PATH: '/usr/bin:/bin' } })).toEqual({ state: 'ready', version: '0.166.0', source: 'yours' })
})

/** A package laid out like the official one, archived, with its own pin. */
async function archive(version, { broken = false, quarantined = false } = {}) {
  const source = await mkdtemp(join(scratch, 'package-'))
  await codex(join(source, 'bin/codex'), version, { broken })
  await writeFile(join(source, 'codex-package.json'), JSON.stringify({ layoutVersion: 1, version, target: 'aarch64-apple-darwin', variant: 'codex', entrypoint: 'bin/codex', resourcesDir: 'codex-resources', pathDir: 'codex-path' }))
  // tar carries a file's quarantine through the archive.
  if (quarantined) Bun.spawnSync(['/usr/bin/xattr', '-w', 'com.apple.quarantine', '0081;6ae23faf;Chrome;', join(source, 'codex-package.json')])
  const file = join(scratch, `codex-${crypto.randomUUID()}.tar.gz`)
  const tar = Bun.spawnSync(['/usr/bin/tar', '-czf', file, '-C', source, 'bin', 'codex-package.json'])
  if (tar.exitCode) throw new Error(tar.stderr.toString())
  const bytes = await readFile(file)
  return { version, url: pathToFileURL(file).href, sha256: checksum(bytes), bytes: bytes.length }
}

test.skipIf(process.platform !== 'darwin')('Download Codex installs the pinned package only after its digest and first start check', async () => {
  const { directory, env } = await place()
  const pkg = await archive(pinned)
  await downloadCodex({ directory, env, package: pkg, lockExecutable: lockBinary })
  expect((await readdir(directory)).sort()).toEqual(['.download-lock', pinned])
  expect(await inspectCodex({ directory, env: { GALTA_CODEX_CANDIDATES: '' } })).toEqual({ state: 'ready', version: pinned, source: 'galta' })

  // Different bytes are refused, with the step that helps, and leave nothing behind.
  const other = await place()
  await downloadCodex({ directory: other.directory, env, package: { ...pkg, sha256: '0'.repeat(64) }, lockExecutable: lockBinary })
  expect(await inspectCodex({ directory: other.directory, env: { GALTA_CODEX_CANDIDATES: '' } })).toMatchObject({ state: 'failed', error: 'The download didn’t match the Codex package Galta expects. Try again.' })
  expect((await readdir(other.directory)).sort()).toEqual(['.download-lock', '.download.json'])
  // A larger download is cut off at the pinned size.
  await downloadCodex({ directory: other.directory, env, package: { ...pkg, bytes: pkg.bytes - 1 }, lockExecutable: lockBinary })
  expect(await inspectCodex({ directory: other.directory, env: { GALTA_CODEX_CANDIDATES: '' } })).toMatchObject({ state: 'failed', error: expect.stringContaining('didn’t match') })
  // A package that does not start is not installed.
  const broken = await archive(pinned, { broken: true })
  await downloadCodex({ directory: other.directory, env, package: broken, lockExecutable: lockBinary })
  expect(await inspectCodex({ directory: other.directory, env: { GALTA_CODEX_CANDIDATES: '' } })).toMatchObject({ state: 'failed', error: 'The downloaded Codex didn’t start. Try again.' })
  // A retry that succeeds clears the failure.
  await downloadCodex({ directory: other.directory, env, package: pkg, lockExecutable: lockBinary })
  expect(await inspectCodex({ directory: other.directory, env: { GALTA_CODEX_CANDIDATES: '' } })).toEqual({ state: 'ready', version: pinned, source: 'galta' })
  expect((await readdir(other.directory)).sort()).toEqual(['.download-lock', pinned])
})

test.skipIf(process.platform !== 'darwin')('a downloaded Codex leaves quarantine before its first start', async () => {
  // A browser starts Galta, so macOS quarantines what Galta writes as the
  // browser's download, and Gatekeeper would stop Codex's first start to ask.
  // Here the quarantine rides on a file Codex never runs, so no prompt appears.
  const { directory, env } = await place()
  await downloadCodex({ directory, env, package: await archive(pinned, { quarantined: true }), lockExecutable: lockBinary })
  expect(await inspectCodex({ directory, env: { GALTA_CODEX_CANDIDATES: '' } })).toEqual({ state: 'ready', version: pinned, source: 'galta' })
  const listed = Bun.spawnSync(['/usr/bin/xattr', '-lr', join(directory, pinned)]).stdout.toString()
  expect(listed).not.toContain('com.apple.quarantine')
})

test.skipIf(process.platform !== 'darwin')('a download that stops making progress fails with the next step', async () => {
  const { directory, env } = await place()
  // Headers and a first chunk, then silence.
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024)) } })) })
  try {
    const started = Date.now()
    await downloadCodex({ directory, env, package: { version: pinned, url: `http://127.0.0.1:${server.port}/codex.tar.gz`, sha256: '0'.repeat(64), bytes: 4096 }, lockExecutable: lockBinary, stallMs: 300 })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await inspectCodex({ directory, env: { GALTA_CODEX_CANDIDATES: '' } })).toMatchObject({ state: 'failed', error: 'The Codex download stopped making progress. Check your internet connection and try again.' })
    expect((await readdir(directory)).sort()).toEqual(['.download-lock', '.download.json'])
  } finally { server.stop(true) }
})

test.skipIf(process.platform !== 'darwin')('one download at a time; an interrupted one is reported, and a new download replaces older copies', async () => {
  const { directory, env } = await place()
  const pkg = await archive(pinned)
  await mkdir(directory, { recursive: true })
  const unlock = await lockActivation(join(directory, '.download-lock'), lockBinary)
  try {
    // Another download holds the lock and has not reported yet: the second
    // one leaves the state to it, writing nothing.
    await downloadCodex({ directory, env, package: pkg, lockExecutable: lockBinary })
    expect(await readdir(directory)).toEqual(['.download-lock'])
    await writeFile(join(directory, '.download.json'), JSON.stringify({ pid: process.pid, received: 1024 }))
    await downloadCodex({ directory, env, package: pkg, lockExecutable: lockBinary })
    expect(await inspectCodex({ directory, env: { GALTA_CODEX_CANDIDATES: '' } })).toMatchObject({ state: 'downloading', received: 1024 })
    // A state nobody has refreshed for minutes belongs to a dead worker, even
    // when its process ID is in use again (here, by this test).
    const old = new Date(Date.now() - 180_000)
    await utimes(join(directory, '.download.json'), old, old)
    expect(await inspectCodex({ directory, env: { GALTA_CODEX_CANDIDATES: '' } })).toMatchObject({ state: 'failed', error: 'The Codex download stopped before it finished. Try again.' })
  } finally { await unlock() }
  await writeFile(join(directory, '.download.json'), JSON.stringify({ pid: 2 ** 22 + 1, received: 1024 }))
  expect(await inspectCodex({ directory, env: { GALTA_CODEX_CANDIDATES: '' } })).toMatchObject({ state: 'failed', error: 'The Codex download stopped before it finished. Try again.' })
  await codex(join(directory, '0.150.0/bin/codex'), '0.150.0')
  await mkdir(join(directory, '.stage-interrupted'))
  await downloadCodex({ directory, env, package: pkg, lockExecutable: lockBinary })
  expect((await readdir(directory)).sort()).toEqual(['.download-lock', pinned])
})

test.skipIf(process.platform !== 'darwin')('a download that finds Codex already there fetches nothing', async () => {
  const { home, directory } = await place()
  // A URL that would fail: reaching it would leave a failure behind.
  const pkg = { version: pinned, url: 'http://127.0.0.1:9/never', sha256: '0'.repeat(64), bytes: 1 }
  const own = await codex(join(home, 'ChatGPT/codex'), '0.165.0')
  await downloadCodex({ directory, env: { GALTA_CODEX_CANDIDATES: own }, package: pkg, lockExecutable: lockBinary })
  expect(await readdir(directory)).toEqual(['.download-lock'])
  // A copy that finished meanwhile counts too.
  await codex(join(directory, pinned, 'bin/codex'), pinned)
  await downloadCodex({ directory, env: { GALTA_CODEX_CANDIDATES: '' }, package: pkg, lockExecutable: lockBinary })
  expect((await readdir(directory)).sort()).toEqual(['.download-lock', pinned])
})
