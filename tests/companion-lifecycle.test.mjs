import { test, expect, afterAll } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { checksum, runtimeFiles, runtimeBundle, runtimeExecutable } from '../native/companion/release.ts'
import dependencies from '../distribution/dependencies.json'
import { inspectRelease } from '../native/companion/health.ts'
import { assessCompanion } from '../packages/runtime/src/lifecycle.ts'
import { validateDistribution } from '../scripts/distribution/config.ts'

const project = resolve(import.meta.dir, '..')
const lockFixture = await mkdtemp(join(tmpdir(), 'galta-test-lock-'))
const lockBinary = join(lockFixture, 'galta-lock')
const compiled = process.platform === 'darwin' ? Bun.spawnSync(['/usr/bin/cc', '-O2', join(project, 'native/companion/activation-lock.c'), '-o', lockBinary]) : { exitCode: 0, stderr: '' }
if (compiled.exitCode) throw new Error(compiled.stderr.toString())
afterAll(() => rm(lockFixture, { recursive: true, force: true }))
const id = 'abcdefghijklmnopabcdefghijklmnop'
/** A process running from `directory`, as a browser host started by its launcher would be. */
// The trailing no-op keeps sh from exec'ing sleep, so its command line still names the release.
const occupy = directory => Bun.spawn(['/bin/sh', '-c', 'sleep 60; :', join(directory, 'Resources/galta-canvas-bridge')])
const roots = home => ({ root: join(home, 'Library/Application Support/Galta'), registry: join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts') })
// A Mac with no Codex of its own: this machine's installations stay out of sight.
const isolatedEnv = home => { const env = { ...process.env, HOME: home, GALTA_CODEX_CANDIDATES: '' }; delete env.GALTA_CODEX_BIN; return env }
const fakeCodex = version => `#!/bin/sh\necho codex-cli ${version}\n`
/** Codex as Mac apps up to 0.1.4 bundled it, recorded in the release. */
const bundledCodex = version => ({
  'Resources/codex/bin/codex': fakeCodex(version),
  'Resources/codex/codex-package.json': JSON.stringify({ layoutVersion: 1, version, target: 'aarch64-apple-darwin', variant: 'codex', entrypoint: 'bin/codex', resourcesDir: 'codex-resources', pathDir: 'codex-path' }),
})
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "galta lifecycle '")))
  const release = async (build = 1, options = {}) => {
    const directory = join(home, `payload-${build}`), files = {}
    const extra = options.bundledCodex ? bundledCodex(options.bundledCodex) : {}
    for (const name of [...runtimeFiles, ...Object.keys(extra)]) {
      await mkdir(dirname(join(directory, name)), { recursive: true })
      const bytes = name === 'MacOS/galta-lock' ? await readFile(lockBinary) : Buffer.from(extra[name] ?? `#!/bin/sh\necho release-${build}\n`)
      // A broken release has a runtime executable that cannot run.
      await writeFile(join(directory, name), bytes, { mode: options.broken && name === 'Resources/galta-companion' ? 0o644 : 0o755 }); files[name] = checksum(bytes)
    }
    await writeFile(join(directory, 'Resources/release.json'), JSON.stringify({ schema: 1, protocol: 1, version: '0.1.0', build, channel: 'development', extensionId: id, files }))
    return directory
  }
  const command = async (role, directory) => {
    const child = Bun.spawn([process.execPath, 'native/companion/main.ts', role, directory], { cwd: project, env: isolatedEnv(home), stdout: 'pipe', stderr: 'pipe' })
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, output, error }
  }
  const inspect = async directory => {
    const result = await command('inspect', directory)
    expect(result.code, result.error).toBe(0)
    return JSON.parse(result.output)
  }
  /** One browser request to the companion host started from `directory`, as its launcher would. */
  const host = async (directory, request) => {
    const child = Bun.spawn([process.execPath, 'native/companion/main.ts', 'companion', `chrome-extension://${id}/`], { cwd: project, env: { ...isolatedEnv(home), GALTA_RELEASE_DIRECTORY: directory }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    const body = Buffer.from(JSON.stringify(request)), header = Buffer.alloc(4)
    header.writeUInt32LE(body.length)
    child.stdin.write(Buffer.concat([header, body])); child.stdin.end()
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer()])
    const bytes = Buffer.from(output)
    return { code, reply: bytes.length >= 4 ? JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32LE(0)).toString()) : undefined }
  }
  return { home, ...roots(home), release, command, host, install: directory => command('install', directory), inspect, close: () => rm(home, { recursive: true, force: true }) }
}

test('runtime commands report a failure as one readable line', async () => {
  const f = await fixture()
  try {
    const missing = join(f.home, 'missing')
    const result = await f.command('inspect', missing)
    expect(result.code).toBe(1)
    expect(result.error).toBe(`ENOENT: no such file or directory, open '${join(missing, 'Resources/release.json')}'\n`)
    expect((await f.command('unknown', missing)).error).toBe('Expected canvas, codex, mcp, companion, install, inspect or codex-download\n')
  } finally { await f.close() }
})

test.skipIf(process.platform !== 'darwin')('the companion host answers every request, naming the problem and the step that fixes it', async () => {
  const f = await fixture()
  try {
    const first = await f.release(1)
    expect((await f.install(first)).code).toBe(0)
    const pinned = await realpath(join(f.root, 'current'))
    const healthy = await f.host(pinned, { method: 'status' })
    expect(healthy.code).toBe(0)
    // Canvas access is ready without Codex; Chat offers the pinned download.
    expect(assessCompanion(healthy.reply)).toMatchObject({ state: 'ready', health: { mcpCommand: join(f.root, 'current/Resources/galta-mcp'), codex: { state: 'missing', download: { version: dependencies.codex.version, bytes: dependencies.codex.bytes } } } })
    expect((await f.host(pinned, { method: 'media/settings', params: { action: 'status' } })).reply).toMatchObject({ ok: true })
    expect((await f.host(pinned, { method: 'future' })).reply).toEqual({ error: 'Update Galta for Mac to use this.' })

    const registration = join(f.registry, 'com.galta.canvas.json'), saved = await readFile(registration, 'utf8')
    await writeFile(registration, JSON.stringify({ name: 'com.galta.canvas', type: 'stdio', path: '/wrong', allowed_origins: [`chrome-extension://${id}/`] }))
    const repair = 'Galta for Mac needs to repair this browser’s connection. Open Galta on your Mac and choose “Repair connection”.'
    expect(assessCompanion((await f.host(pinned, { method: 'status' })).reply)).toEqual({ state: 'unavailable', detail: repair })
    expect((await f.host(pinned, { method: 'media/settings', params: { action: 'status' } })).reply).toEqual({ ok: false, error: repair })
    await writeFile(registration, saved)

    // A host launched just before an update still answers from its own release.
    const session = occupy(pinned)
    expect((await f.install(await f.release(2))).code).toBe(0)
    expect((await f.host(pinned, { method: 'status' })).reply).toEqual({ error: 'Galta for Mac was just updated. Try again.' })
    session.kill(); await session.exited
    expect(assessCompanion((await f.host(await realpath(join(f.root, 'current')), { method: 'status' })).reply).state).toBe('ready')
  } finally { await f.close() }
})

test.skipIf(process.platform !== 'darwin')('app inspection reads the actual installation without writing registrations or selecting an update', async () => {
  const f = await fixture()
  try {
    const first = await f.release(1)
    expect((await f.inspect(first)).installation.state).toBe('absent')
    expect((await f.install(first)).code).toBe(0)
    const registration = join(f.registry, 'com.galta.canvas.json')
    const before = await stat(registration)
    const current = await realpath(join(f.root, 'current'))
    const ready = await f.inspect(first)
    expect(ready.installation.state).toBe('current')
    expect(ready.mcpCommand).toBe(join(f.root, 'current/Resources/galta-mcp'))
    expect((await stat(registration)).mtimeMs).toBe(before.mtimeMs)
    const second = await f.release(2)
    expect((await f.inspect(second)).installation.state).toBe('update-available')
    expect(await realpath(join(f.root, 'current'))).toBe(current)
    await writeFile(registration, JSON.stringify({ name: 'com.galta.canvas', type: 'stdio', path: '/wrong', allowed_origins: [`chrome-extension://${id}/`] }))
    const damaged = await f.inspect(first)
    expect(damaged.installation.state).toBe('repair-required')
    expect(damaged.mcpCommand).toBeUndefined()
    expect((await f.install(first)).code).toBe(0)
    expect((await f.inspect(first)).installation.state).toBe('current')
    await chmod(join(current, 'Resources/galta-mcp'), 0o644)
    expect((await f.inspect(first)).installation.state).toBe('repair-required')
    // A new healthy payload can still replace a damaged older runtime.
    expect((await f.inspect(second)).installation.state).toBe('update-available')
    await rm(join(f.root, 'current'))
    expect((await f.inspect(second)).installation.state).toBe('repair-required')
    expect((await f.install(second)).code).toBe(0)
    await rm(join(f.root, 'current'))
    await mkdir(join(f.root, 'current'))
    expect((await f.inspect(second)).installation.state).toBe('unavailable')
  } finally { await f.close() }
})

test.skipIf(process.platform !== 'darwin')('app inspection distinguishes interrupted activation, conflicting identity and a broken runtime', async () => {
  const f = await fixture()
  try {
    const first = await f.release(1)
    expect((await f.install(first)).code).toBe(0)
    const next = await f.release(2)
    const manifest = join(next, 'Resources/release.json')
    const value = JSON.parse(await readFile(manifest, 'utf8'))
    await writeFile(manifest, JSON.stringify({ ...value, extensionId: 'b'.repeat(32) }))
    expect((await f.inspect(next)).installation.state).toBe('conflict')
    await writeFile(join(f.root, '.activation.json'), '{}')
    expect((await f.inspect(first)).installation.state).toBe('repair-required')
    const broken = await f.inspect(await f.release(3, { broken: true }))
    expect(broken.runtime.available).toBe(false)
    expect(broken.mcpCommand).toBeUndefined()
  } finally { await f.close() }
})

test('compatibility requires a complete contract and a working runtime', () => {
  const healthy = { protocol: 1, version: '0.1.0', releaseId: 'id', channel: 'beta', capabilities: ['canvas/1', 'codex/1', 'mcp/1'], runtime: { available: true } }
  expect(assessCompanion(healthy).state).toBe('ready')
  expect(assessCompanion({ ...healthy, mcpCommand: '/Applications/Galta.app/Contents/Resources/galta-mcp' }).state).toBe('ready')
  for (const invalid of [null, {}, { ...healthy, protocol: 2 }, { ...healthy, capabilities: ['canvas/1'] }, { ...healthy, runtime: {} }, { ...healthy, mcpCommand: 42 }, { ...healthy, mcpCommand: 'relative/path' }, { ...healthy, mcpCommand: '/tmp/bad\npath' }]) expect(assessCompanion(invalid).state).toBe('incompatible')
  // Codex availability is optional (apps that bundled Codex report none). One
  // this extension cannot read concerns Chat only: the Mac app stays ready.
  const download = { version: '0.162.0-alpha.17.2', bytes: 132097637 }
  for (const codex of [{ state: 'ready', version: '0.165.0', source: 'yours' }, { state: 'missing', download }, { state: 'outdated', version: '0.150.0', source: 'galta', minimum: download.version, download }, { state: 'downloading', received: 0, download }, { state: 'failed', error: 'Try again.', download }]) expect(assessCompanion({ ...healthy, codex })).toEqual({ state: 'ready', health: { ...healthy, codex } })
  for (const codex of [null, {}, { state: 'updating', download }, { state: 'ready', version: '0.165.0', source: 'elsewhere' }, { state: 'missing' }, { state: 'outdated', version: '0.150.0', minimum: download.version, download }, { state: 'downloading', download }, { state: 'failed', error: 'x'.repeat(401), download }]) expect(assessCompanion({ ...healthy, codex })).toEqual({ state: 'ready', health: { ...healthy, codex: { state: 'unrecognized' } } })
  expect(assessCompanion({ ...healthy, runtime: { available: false } }).state).toBe('runtime-unavailable')
  expect(assessCompanion({ error: 'Galta for Mac was just updated. Try again.' })).toEqual({ state: 'unavailable', detail: 'Galta for Mac was just updated. Try again.' })
  for (const invalid of [{ error: '' }, { error: 42 }, { error: 'x'.repeat(401) }, { ...healthy, error: 'ignored' }]) expect(assessCompanion(invalid).state).not.toBe('unavailable')
  expect(() => validateDistribution({ channel: 'beta', build: 1, extensionId: id })).toThrow('verified store key')
})

test.skipIf(process.platform !== 'darwin')('activation verifies dependencies before switching; updates preserve the previous immutable release', async () => {
  const f = await fixture()
  try {
    const first = await f.release(1)
    const result = await f.install(first)
    expect(result.code, result.error).toBe(0)
    const pinned = await realpath(join(f.root, 'current'))
    const oldRegistration = await readFile(join(f.registry, 'com.galta.codex.json'), 'utf8')
    expect(JSON.parse(oldRegistration).allowed_origins).toEqual([`chrome-extension://${id}/`])
    expect((await f.install(await f.release(2, { broken: true }))).code).not.toBe(0)
    expect(await realpath(join(f.root, 'current'))).toBe(pinned)
    const second = await f.release(3)
    await writeFile(join(second, 'Resources/galta-mcp'), '#!/bin/sh\necho changed\n')
    expect((await f.install(second)).code).not.toBe(0)
    expect(await realpath(join(f.root, 'current'))).toBe(pinned)
    // A session started before the update keeps running from its release.
    const session = occupy(pinned)
    try {
      const next = await f.install(await f.release(4))
      expect(next.code, next.error).toBe(0)
      expect(await realpath(join(f.root, 'current'))).not.toBe(pinned)
      expect(await readFile(join(pinned, runtimeExecutable), 'utf8')).toContain('release-1')
      expect(await readFile(join(f.registry, 'com.galta.codex.json'), 'utf8')).toBe(oldRegistration)
      await rm(first, { recursive: true })
      const running = Bun.spawn([join(pinned, 'Resources/galta-mcp')], { stdout: 'pipe' })
      expect((await new Response(running.stdout).text()).trim()).toBe('release-1')
    } finally { session.kill(); await session.exited }
  } finally { await f.close() }
})

test.skipIf(process.platform !== 'darwin')('a missing or non-executable runtime executable fails readiness and cannot replace a working installation', async () => {
  const f = await fixture()
  try {
    expect((await f.install(await f.release(1))).code).toBe(0)
    const pinned = await realpath(join(f.root, 'current'))
    const host = 'Resources/galta-codex-bridge'
    for (const [index, damage] of [
      async directory => { const path = join(directory, 'Resources/release.json'), manifest = JSON.parse(await readFile(path, 'utf8')); delete manifest.files[host]; await writeFile(path, JSON.stringify(manifest)) },
      directory => rm(join(directory, host)),
      directory => chmod(join(directory, host), 0o644),
    ].entries()) {
      const candidate = await f.release(index + 2)
      await damage(candidate)
      expect((await inspectRelease(candidate)).runtime.available).toBe(false)
      expect((await f.install(candidate)).code).not.toBe(0)
      expect(await realpath(join(f.root, 'current'))).toBe(pinned)
    }
  } finally { await f.close() }
})

test.skipIf(process.platform !== 'darwin')('an update from an app that bundled Codex keeps that Codex when the user has none', async () => {
  const f = await fixture()
  try {
    const pinned = dependencies.codex.version
    expect((await f.install(await f.release(1, { bundledCodex: pinned }))).code).toBe(0)
    const old = await realpath(join(f.root, 'current'))
    const next = await f.install(await f.release(2))
    expect(next.code, next.error).toBe(0)
    expect(JSON.parse(next.output)).toMatchObject({ adoptedCodex: pinned, codex: { state: 'ready', version: pinned, source: 'galta' }, removedReleases: [basename(old)] })
    // Verified against the old release's digests, then the old release is gone.
    expect(await readFile(join(f.root, 'codex', pinned, 'bin/codex'), 'utf8')).toBe(fakeCodex(pinned))
    expect((await readdir(join(f.root, 'codex'))).filter(name => name.startsWith('.'))).toEqual([])
    expect((await f.inspect(await f.release(2))).codex).toEqual({ state: 'ready', version: pinned, source: 'galta' })
  } finally { await f.close() }
})

test.skipIf(process.platform !== 'darwin')('a bundled Codex older than Galta supports is not kept, and an update needs no Codex', async () => {
  const f = await fixture()
  try {
    expect((await f.install(await f.release(1, { bundledCodex: '0.154.0' }))).code).toBe(0)
    const next = await f.install(await f.release(2))
    expect(next.code, next.error).toBe(0)
    const result = JSON.parse(next.output)
    expect(result.adoptedCodex).toBeUndefined()
    expect(result.codex).toMatchObject({ state: 'missing' })
    expect(await Bun.file(join(f.root, 'codex', '0.154.0', 'bin/codex')).exists()).toBe(false)
  } finally { await f.close() }
})

test.skipIf(process.platform !== 'darwin')('a detached runtime upgrades to a complete app bundle and missing bundle metadata cannot replace it', async () => {
  const f = await fixture()
  try {
    expect((await f.install(await f.release(1))).code).toBe(0)
    const old = await realpath(join(f.root, 'current')), path = join(old, 'Resources/release.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    const binary = await readFile(join(old, runtimeExecutable))
    await writeFile(join(old, 'MacOS/galta-runtime'), binary, { mode: 0o755 })
    for (const file of Object.keys(manifest.files)) if (file.startsWith(runtimeBundle + '/')) delete manifest.files[file]
    manifest.files['MacOS/galta-runtime'] = checksum(binary)
    await writeFile(path, JSON.stringify(manifest))
    await rm(join(old, runtimeBundle), { recursive: true })
    const session = occupy(old)
    const upgraded = await f.install(await f.release(2))
    expect(upgraded.code, upgraded.error).toBe(0)
    const pinned = await realpath(join(f.root, 'current'))
    expect(await readFile(join(pinned, runtimeExecutable), 'utf8')).toContain('release-2')
    expect(await readFile(join(old, 'MacOS/galta-runtime'), 'utf8')).toContain('release-1')
    session.kill(); await session.exited
    for (const [index, file] of ['Contents/Info.plist', 'Contents/_CodeSignature/CodeResources'].entries()) {
      const candidate = await f.release(index + 3)
      await rm(join(candidate, runtimeBundle, file))
      expect((await inspectRelease(candidate)).runtime.available).toBe(false)
      expect((await f.install(candidate)).code).not.toBe(0)
      expect(await realpath(join(f.root, 'current'))).toBe(pinned)
    }
  } finally { await f.close() }
})

test.skipIf(process.platform !== 'darwin')('preflight rejects an obstructed registration without partial changes; an interrupted journal is recoverable', async () => {
  const f = await fixture()
  try {
    expect((await f.install(await f.release())).code).toBe(0)
    const current = await readlink(join(f.root, 'current'))
    const names = ['canvas', 'codex', 'companion']
    const files = await Promise.all(names.map(async kind => { const path = join(f.registry, `com.galta.${kind}.json`); return { path, contents: await readFile(path, 'utf8') } }))
    await rm(files[1].path); await mkdir(files[1].path)
    const second = await f.release(2)
    expect((await f.install(second)).code).not.toBe(0)
    expect(await readlink(join(f.root, 'current'))).toBe(current)
    expect(await readFile(files[0].path, 'utf8')).toBe(files[0].contents)
    await rm(files[1].path, { recursive: true }); await writeFile(files[1].path, files[1].contents)
    await writeFile(join(f.root, '.activation.json'), JSON.stringify({ schema: 1, previous: current, files }))
    await writeFile(files[0].path, '{}')
    const repaired = await f.install(second)
    expect(repaired.code, repaired.error).toBe(0)
    expect(await readFile(files[0].path, 'utf8')).toBe(files[0].contents)
    expect(await Bun.file(join(f.root, '.activation.json')).exists()).toBe(false)
  } finally { await f.close() }
})

test.skipIf(process.platform !== 'darwin')('kernel activation lock excludes another installer and is released when the owner dies', async () => {
  const f = await fixture(); let holder
  try {
    expect((await f.install(await f.release())).code).toBe(0)
    holder = Bun.spawn([process.execPath, '-e', `const {lockActivation}=await import('./native/companion/lock.ts'); await lockActivation(${JSON.stringify(join(f.root, '.activation-lock'))}, ${JSON.stringify(lockBinary)}); console.log('locked'); setInterval(()=>{},10000)`], { cwd: project, stdout: 'pipe', stderr: 'pipe' })
    const reader = holder.stdout.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain('locked'); reader.releaseLock()
    const second = await f.release(2), refused = await f.install(second)
    expect(refused.code).not.toBe(0); expect(refused.error).toContain('in progress')
    holder.kill(); await holder.exited
    const recovered = await f.install(second); expect(recovered.code, recovered.error).toBe(0)
  } finally { holder?.kill(); await f.close() }
})

test.skipIf(process.platform !== 'darwin')('activation removes releases and leftovers nothing runs from, and keeps one a process still uses', async () => {
  const f = await fixture(); let session
  try {
    expect((await f.install(await f.release(1))).code).toBe(0)
    const releases = join(f.root, 'releases'), first = await realpath(join(f.root, 'current'))
    session = occupy(first)
    await mkdir(join(releases, '.stage-interrupted/Resources'), { recursive: true })
    const second = await f.install(await f.release(2))
    expect(second.code, second.error).toBe(0)
    const kept = await realpath(join(f.root, 'current'))
    expect(JSON.parse(second.output)).toMatchObject({ removedReleases: [] })
    expect((await readdir(releases)).sort()).toEqual([basename(first), basename(kept)].sort())
    // Once the session ends, the next activation removes both superseded releases.
    session.kill(); await session.exited
    const third = await f.install(await f.release(3))
    expect(third.code, third.error).toBe(0)
    expect(JSON.parse(third.output).removedReleases.sort()).toEqual([basename(first), basename(kept)].sort())
    expect(await readdir(releases)).toEqual([basename(await realpath(join(f.root, 'current')))])
    expect((await f.inspect(await f.release(3))).installation.state).toBe('current')
  } finally { session?.kill(); await f.close() }
})

test.skipIf(process.platform !== 'darwin')('repair installs a missing or damaged runtime again without writing into a release', async () => {
  const f = await fixture()
  try {
    const app = await f.release(1)
    expect((await f.install(app)).code).toBe(0)
    const releases = join(f.root, 'releases'), pinned = await realpath(join(f.root, 'current'))
    await rm(pinned, { recursive: true })
    expect((await f.inspect(app)).installation).toMatchObject({ state: 'repair-required', detail: expect.stringContaining('missing or unreadable') })
    const restored = await f.install(app)
    expect(restored.code, restored.error).toBe(0)
    expect((await f.inspect(app)).installation.state).toBe('current')
    await chmod(join(pinned, 'Resources/galta-mcp'), 0o644)
    expect((await f.inspect(app)).installation).toMatchObject({ state: 'repair-required', detail: expect.stringContaining('damaged') })
    const repaired = await f.install(app)
    expect(repaired.code, repaired.error).toBe(0)
    expect((await f.inspect(app)).installation.state).toBe('current')
    // The damaged copy was set aside, then removed because nothing ran from it.
    expect(await readdir(releases)).toEqual([basename(pinned)])
    // An unreadable release registered for another extension is not repaired by this app.
    await rm(pinned, { recursive: true })
    const other = await f.release(2), manifest = join(other, 'Resources/release.json')
    await writeFile(manifest, JSON.stringify({ ...JSON.parse(await readFile(manifest, 'utf8')), extensionId: 'b'.repeat(32) }))
    expect((await f.inspect(other)).installation.state).toBe('conflict')
    expect((await f.install(other)).error).toContain('different Galta extension')
  } finally { await f.close() }
})
