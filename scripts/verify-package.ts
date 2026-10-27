#!/usr/bin/env bun
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { assertCodexEmbeddedConfig } from '../packages/runtime/src/codexConfig'
import { assessCompanion } from '../packages/runtime/src/lifecycle'
import { checksum, codexExecutable, codexExecutables, readRelease, runtimeBundle, runtimeBundleIdentifier, runtimeExecutable } from '../native/companion/release'
import { run } from './distribution/config'
import { NativeClient } from './distribution/native-client'
import { verifyToolExecution } from './distribution/verify-tool-execution'
import { readCodeIdentity } from './distribution/signing'

const output = resolve(Bun.argv[2] ?? 'output/development')
const requiredModels = Bun.argv.slice(3)
const receipt = await Bun.file(join(output, 'package-receipt.json')).json()
if (receipt.schema !== 2) throw new Error('Rebuild the package: expected receipt schema 2')
for (const artifact of [receipt.extension, receipt.companion, receipt.diskImage]) {
  if (typeof artifact.file !== 'string' || artifact.file.includes('/') || checksum(await readFile(join(output, artifact.file))) !== artifact.sha256) throw new Error('Package checksum mismatch')
}
const extensionZip = join(output, receipt.extension.file), companionZip = join(output, receipt.companion.file)
run(['/usr/bin/unzip', '-tq', extensionZip]); run(['/usr/bin/hdiutil', 'verify', join(output, receipt.diskImage.file)])
const manifest = JSON.parse(run(['/usr/bin/unzip', '-p', extensionZip, 'manifest.json']))
if (manifest.version !== receipt.version || manifest.manifest_version !== 3) throw new Error('Extension version is incorrect')
const files = run(['/usr/bin/unzip', '-Z1', extensionZip]).split('\n')
for (const file of ['canvas/index.html', 'sidepanel/index.html', ...Object.values(manifest.icons ?? {})]) if (!files.includes(String(file))) throw new Error(`Missing extension file: ${file}`)

const isolated = await mkdtemp(join(tmpdir(), 'galta-package-verify-'))
try {
  run(['/usr/bin/ditto', '-x', '-k', companionZip, isolated])
  const app = join(isolated, 'Galta.app'), contents = join(app, 'Contents')
  const release = await readRelease(contents, true)
  if (release.release.extensionId !== receipt.extensionId) throw new Error('Companion extension identity differs from the package receipt')
  if (run([join(contents, codexExecutable), '--version']).trim() !== `codex-cli ${receipt.dependencies.codex.version}`) throw new Error('Bundled Codex version differs from the package receipt')
  const identity = readCodeIdentity(join(contents, runtimeBundle))
  const info = JSON.parse(run(['/usr/bin/plutil', '-convert', 'json', '-o', '-', join(contents, runtimeBundle, 'Contents/Info.plist')]))
  if (identity.identifier !== runtimeBundleIdentifier(receipt.channel) || info.CFBundleIdentifier !== identity.identifier
    || info.CFBundleExecutable !== 'galta-runtime' || JSON.stringify(identity) !== JSON.stringify(receipt.signing?.runtime)) throw new Error('Runtime bundle identity does not match its release receipt')
  if (receipt.signed && (!identity.team || /\bcdhash\b/.test(identity.requirement))) throw new Error('Signed runtime identity changes with its code hash')
  run(['/usr/bin/codesign', '--verify', '--strict', join(contents, runtimeBundle)])
  for (const executable of ['MacOS/Galta', runtimeExecutable, ...codexExecutables]) {
    run(['/usr/bin/codesign', '--verify', '--strict', join(contents, executable)])
    const load = run(['/usr/bin/otool', '-l', join(contents, executable)])
    const minos = load.match(/\bminos\s+(\d+\.\d+)/)?.[1] ?? load.match(/LC_VERSION_MIN_MACOSX[\s\S]*?version\s+(\d+\.\d+)/)?.[1]
    if (!minos || Number(minos.split('.')[0]) > Number(receipt.minimumMacOS.split('.')[0])) throw new Error(`Invalid deployment target for ${executable}: ${minos}`)
  }
  run(['/usr/bin/codesign', '--verify', '--deep', '--strict', app])
  run([join(contents, 'MacOS/Galta'), '--verify-bundle'])
  const home = join(isolated, 'home'); await mkdir(home)
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  for (const key of ['CODEX_HOME', 'GALTA_CODEX_BIN', 'GALTA_MCP_BIN', 'GALTA_RELEASE_DIRECTORY', 'GALTA_BUNDLED_CODEX_BIN', 'GALTA_WORKSPACE_DIRECTORY', 'GALTA_RUNTIME_DIRECTORY', 'GALTA_BRIDGE_DIRECTORY']) delete env[key]
  const installed = JSON.parse(run([join(contents, runtimeExecutable), 'install', contents], undefined, env))
  if (installed.installation?.state !== 'current' || !installed.runtime.available) throw new Error('Installed runtime is not ready')
  const registry = join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
  const nativePaths: Record<string, string> = {}
  for (const kind of ['canvas', 'codex', 'companion']) {
    const entry = JSON.parse(await readFile(join(registry, `com.galta.${kind}.json`), 'utf8'))
    if (entry.allowed_origins?.length !== 1 || entry.allowed_origins[0] !== `chrome-extension://${receipt.extensionId}/`) throw new Error(`Incorrect ${kind} origin restriction`)
    nativePaths[kind] = entry.path
  }
  // Remove the downloaded app entirely: installed roles must be independent of it.
  await rm(app, { recursive: true })
  run(['/usr/bin/codesign', '--verify', '--strict', join(installed.directory, runtimeBundle)])
  if (JSON.stringify(readCodeIdentity(join(installed.directory, runtimeBundle))) !== JSON.stringify(identity)) throw new Error('Activation changed the runtime identity')
  const origin = `chrome-extension://${receipt.extensionId}/`
  const probe = Bun.spawn([nativePaths.companion!, origin], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const request = Buffer.from(JSON.stringify({ method: 'status' })), frame = Buffer.alloc(request.length + 4)
  frame.writeUInt32LE(request.length); request.copy(frame, 4); probe.stdin.write(frame); probe.stdin.end()
  const response = Buffer.from(await new Response(probe.stdout).arrayBuffer())
  const error = await new Response(probe.stderr).text()
  if (await probe.exited !== 0 || response.length < 4 || assessCompanion(JSON.parse(response.subarray(4).toString())).state !== 'ready') throw new Error(`Companion handshake failed: ${error}`)
  const codex = new NativeClient(nativePaths.codex!, origin, env)
  try {
    await codex.request('initialize', { clientInfo: { name: 'galta_verification', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } })
    codex.notify('initialized', {})
    assertCodexEmbeddedConfig(await codex.request('config/read', { includeLayers: false }))
    const account = await codex.request('account/read', { refreshToken: false })
    if (account.account) throw new Error('Package verification must not inherit an account')
    if (requiredModels.length) {
      const models = new Set<string>(), cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await codex.request('model/list', cursor ? { cursor } : {})
        for (const model of page.data) models.add(model.id)
        cursor = page.nextCursor ?? undefined
        if (cursor && cursors.has(cursor)) throw new Error('Bundled model catalog repeated a page cursor')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      for (const model of requiredModels) if (!models.has(model)) throw new Error(`Bundled Codex does not advertise required model: ${model}`)
    }
  } finally { await codex.close() }
  await verifyToolExecution(nativePaths.codex!, origin, env, home)
  const mcp = new Client({ name: 'galta-package-verification', version: '1' })
  const safeEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  try {
    await mcp.connect(new StdioClientTransport({ command: installed.mcpCommand, env: safeEnv }))
    const tools = (await mcp.listTools()).tools.map(tool => tool.name)
    for (const tool of ['canvas_list', 'canvas_connect', 'canvas_capture', 'canvas_edit']) if (!tools.includes(tool)) throw new Error(`Packaged MCP is missing ${tool}`)
  } finally { await mcp.close() }
  console.log('PASS: archive integrity, onboarding entry, deployment target, signatures, clean-home activation, native handshake, bundled Codex initialization, auth isolation, code-mode shell execution, and MCP discovery. Model responses were local fixtures; no paid inference or browser UI was exercised.')
} finally { await rm(isolated, { recursive: true, force: true }) }
