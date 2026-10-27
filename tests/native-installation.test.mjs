import { test, expect } from 'bun:test'
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { galtaToolContract } from '../packages/canvas/src/contract'

const root = resolve(import.meta.dir, '..')
const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
const managedRoot = home => process.platform === 'darwin' ? join(home, 'Library/Application Support/Galta') : join(home, '.local/share/galta')

test('native installation copies and replaces a runtime independently of its source checkout', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "galta install 'home-")))
  const source = join(home, 'Documents', 'checkout', 'bridge')
  const installed = join(managedRoot(home), 'bin/galta-codex-bridge')
  const registry = process.platform === 'darwin' ? join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts') : join(home, '.config/google-chrome/NativeMessagingHosts')
  const manifestPath = join(registry, 'com.galta.codex.json')
  const install = async (id = extensionId, binary = source) => {
    const child = Bun.spawn([process.execPath, join(root, 'native/adapters/codex/install.ts'), id, binary], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') }, stdout: 'pipe', stderr: 'pipe',
    })
    return { code: await child.exited, error: await new Response(child.stderr).text() }
  }
  try {
    await mkdir(join(home, 'Documents/checkout'), { recursive: true })
    await writeFile(source, '#!/bin/sh\nprintf old\n', { mode: 0o700 })
    expect((await install()).code).toBe(0)
    const firstManifest = await readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(firstManifest)
    expect(manifest.path).toBe(installed)
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${extensionId}/`])
    expect((await lstat(installed)).isSymbolicLink()).toBe(false)
    await access(installed, constants.X_OK)
    const firstInode = (await lstat(installed)).ino

    await writeFile(source, '#!/bin/sh\nprintf updated\n')
    expect((await install()).code).toBe(0)
    expect((await lstat(installed)).ino).not.toBe(firstInode)
    expect(await readFile(installed, 'utf8')).toContain('updated')
    await rm(join(home, 'Documents'), { recursive: true })
    const running = Bun.spawn([installed], { stdout: 'pipe', stderr: 'pipe' })
    expect(await new Response(running.stdout).text()).toBe('updated')
    expect(await running.exited).toBe(0)

    expect((await install()).code).not.toBe(0)
    expect((await install('invalid', installed)).code).not.toBe(0)
    expect(await readFile(manifestPath, 'utf8')).toBe(firstManifest)
    expect(await readFile(installed, 'utf8')).toContain('updated')
    expect(await readdir(join(managedRoot(home), 'bin'))).toEqual(['galta-codex-bridge'])
  } finally { await rm(home, { recursive: true, force: true }) }
})

test.skipIf(process.platform !== 'darwin')('standalone installers cannot overwrite an active or interrupted Mac app installation', async () => {
  for (const marker of ['current', '.activation.json', 'companion']) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'galta-install-owner-')))
    const data = managedRoot(home)
    const registry = join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
    const source = join(home, 'replacement')
    try {
      await mkdir(join(data, 'bin'), { recursive: true })
      await mkdir(registry, { recursive: true })
      await writeFile(source, '#!/bin/sh\nprintf replacement\n', { mode: 0o700 })
      // A broken pointer or pending journal still belongs to the Mac app's repair flow.
      if (marker === 'current') await symlink('releases/missing', join(data, marker))
      else await writeFile(marker === 'companion' ? join(registry, 'com.galta.companion.json') : join(data, marker), 'managed installation')
      for (const role of ['codex', 'canvas']) {
        const binary = join(data, 'bin', `galta-${role}-bridge`)
        const manifest = join(registry, `com.galta.${role}.json`)
        await writeFile(binary, 'previous binary')
        await writeFile(manifest, 'managed registration')
        const child = Bun.spawn([process.execPath, join(root, `native/${role === 'codex' ? 'adapters/codex' : 'bridge'}/install.ts`), extensionId, source], {
          env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe',
        })
        const error = await new Response(child.stderr).text()
        expect(await child.exited).not.toBe(0)
        expect(error).toContain('Galta for Mac manages this installation')
        expect(await readFile(binary, 'utf8')).toBe('previous binary')
        expect(await readFile(manifest, 'utf8')).toBe('managed registration')
      }
      expect((await readdir(join(data, 'bin'))).sort()).toEqual(['galta-canvas-bridge', 'galta-codex-bridge'])
    } finally { await rm(home, { recursive: true, force: true }) }
  }
})

test('canvas installation includes MCP and refuses an incomplete payload before replacing files', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'galta-canvas-install-')))
  const source = join(home, 'Documents/native'), installed = join(managedRoot(home), 'bin')
  const install = async () => {
    const child = Bun.spawn([process.execPath, join(source, 'bridge/install.ts'), extensionId], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') }, stdout: 'ignore', stderr: 'pipe',
    })
    await new Response(child.stderr).text()
    return child.exited
  }
  try {
    await mkdir(join(source, 'bridge'), { recursive: true })
    await mkdir(join(source, 'mcp'))
    for (const file of ['paths.ts', 'dataDirectory.ts', 'installation.ts', 'bridge/install.ts']) await copyFile(join(root, 'native', file), join(source, file))
    await writeFile(join(source, 'bridge/galta-canvas-bridge'), '#!/bin/sh\nprintf canvas\n', { mode: 0o700 })
    await writeFile(join(source, 'mcp/galta-mcp'), '#!/bin/sh\nprintf mcp\n', { mode: 0o700 })
    expect(await install()).toBe(0)
    expect((await readdir(installed)).sort()).toEqual(['galta-canvas-bridge', 'galta-mcp'])
    const oldBridge = await readFile(join(installed, 'galta-canvas-bridge'), 'utf8')
    await writeFile(join(source, 'bridge/galta-canvas-bridge'), '#!/bin/sh\nprintf replacement\n')
    await rm(join(source, 'mcp/galta-mcp'))
    expect(await install()).not.toBe(0)
    expect(await readFile(join(installed, 'galta-canvas-bridge'), 'utf8')).toBe(oldBridge)
    expect(await readFile(join(installed, 'galta-mcp'), 'utf8')).toContain('printf mcp')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('Codex app-server starts in Galta runtime data even when the bridge inherits the checkout cwd', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'galta-startup-')))
  const fakeCodex = join(home, 'codex')
  // The bridge only names the MCP executable to Codex, so a stand-in does; the
  // compiled one exists only after `bun run bridge:build`.
  const fakeMcp = join(home, 'galta-mcp')
  let host
  try {
    await writeFile(fakeCodex, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ result: { cwd: process.cwd(), args: process.argv.slice(2) } }) + '\\n');\nfor await (const chunk of Bun.stdin.stream()) {}\n`)
    await chmod(fakeCodex, 0o700)
    await writeFile(fakeMcp, '#!/bin/sh\n', { mode: 0o700 })
    host = Bun.spawn([process.execPath, join(root, 'native/adapters/codex/host.ts'), `chrome-extension://${extensionId}/`], {
      cwd: join(root, 'native/adapters/codex'), env: { ...process.env, HOME: home, GALTA_CODEX_BIN: fakeCodex, GALTA_MCP_BIN: fakeMcp }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    const reader = host.stdout.getReader()
    let bytes = Buffer.alloc(0)
    while (bytes.length < 4 || bytes.length < bytes.readUInt32LE(0) + 4) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`Bridge exited before the startup receipt: ${await new Response(host.stderr).text()}`)
      bytes = Buffer.concat([bytes, value])
    }
    reader.releaseLock()
    const { result } = JSON.parse(bytes.subarray(4, bytes.readUInt32LE(0) + 4).toString())
    expect(result.cwd).toBe(join(managedRoot(home), 'runtime'))
    expect(result.args.slice(0, 2)).toEqual(['app-server', '--stdio'])
    const config = Object.fromEntries(result.args.slice(2).reduce((entries, argument, index, args) => {
      if (index % 2 === 0) {
        expect(argument).toBe('-c')
        const [key, ...value] = args[index + 1].split('=')
        entries.push([key, JSON.parse(value.join('='))])
      }
      return entries
    }, []))
    expect(config.notify).toEqual([])
    expect(config.approval_policy).toBe('never')
    expect(config.sandbox_mode).toBe('danger-full-access')
    expect(config['apps._default.default_tools_approval_mode']).toBe('approve')
    expect(config['features.memories']).toBe(false)
    expect(config['memories.generate_memories']).toBe(false)
    expect(config['features.code_mode.direct_only_tool_namespaces']).toBeUndefined()
    expect(config['mcp_servers.galta.command']).toBe(fakeMcp)
    expect(config['mcp_servers.galta.args']).toEqual([])
    const request = Buffer.from(JSON.stringify({ id: 'config', method: 'galta/config/read' }))
    const frame = Buffer.alloc(request.length + 4)
    frame.writeUInt32LE(request.length); request.copy(frame, 4)
    host.stdin.write(frame)
    const configReader = host.stdout.getReader()
    bytes = Buffer.alloc(0)
    while (bytes.length < 4 || bytes.length < bytes.readUInt32LE(0) + 4) {
      const { value, done } = await configReader.read()
      if (done) throw new Error(`Bridge exited before the configuration response: ${await new Response(host.stderr).text()}`)
      bytes = Buffer.concat([bytes, value])
    }
    configReader.releaseLock()
    expect(JSON.parse(bytes.subarray(4, bytes.readUInt32LE(0) + 4).toString())).toEqual({ id: 'config', result: { toolContract: await galtaToolContract() } })
    expect(await readdir(managedRoot(home))).not.toContain('workspaces')
    host.stdin.end()
    expect(await host.exited).toBe(0)
  } finally {
    host?.kill()
    if (host) await host.exited
    await rm(home, { recursive: true, force: true })
  }
}, 10_000)
