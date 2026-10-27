#!/usr/bin/env bun
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checksum, readRelease, runtimeBundle, runtimeExecutable } from '../native/companion/release'
import { run } from './distribution/config'
import { NativeClient } from './distribution/native-client'
import { readCodeIdentity } from './distribution/signing'

// A real signed upgrade in a disposable home. TCC consent must be tested
// separately through a browser-owned host in a clean macOS account.
if (Bun.argv.length !== 4) throw new Error('Usage: bun run package:verify-upgrade <previous-package-directory> <next-package-directory>')
const isolated = await mkdtemp(join(tmpdir(), 'galta-upgrade-verify-'))
const clients: NativeClient[] = []
try {
  const candidates = []
  for (const [index, argument] of Bun.argv.slice(2).entries()) {
    const directory = resolve(argument), receipt = await Bun.file(join(directory, 'package-receipt.json')).json()
    const artifact = receipt.companion
    if (receipt.schema !== 2 || !receipt.signed || !artifact || typeof artifact.file !== 'string'
      || artifact.file.includes('/') || artifact.file === '..'
      || checksum(await readFile(join(directory, artifact.file))) !== artifact.sha256) throw new Error('Upgrade verification requires two intact certificate-signed packages')
    const staging = join(isolated, String(index))
    run(['/usr/bin/ditto', '-x', '-k', join(directory, artifact.file), staging])
    const app = join(staging, 'Galta.app'), contents = join(app, 'Contents')
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', app])
    const release = await readRelease(contents, true), identity = readCodeIdentity(join(contents, runtimeBundle))
    if (!identity.team || /\bcdhash\b/.test(identity.requirement)
      || JSON.stringify(identity) !== JSON.stringify(receipt.signing?.runtime)
      || release.release.build !== receipt.build || release.release.channel !== receipt.channel
      || release.release.extensionId !== receipt.extensionId) throw new Error('Package receipt differs from its signed runtime')
    candidates.push({ app, contents, release, identity })
  }
  const [previous, next] = candidates
  if (!previous || !next || next.release.release.build <= previous.release.release.build
    || next.release.release.channel !== previous.release.release.channel
    || next.release.release.extensionId !== previous.release.release.extensionId
    || next.identity.identifier !== previous.identity.identifier || next.identity.team !== previous.identity.team) throw new Error('Expected an increasing build with the same channel, extension and runtime identity')
  // An existing grant stores the old requirement; the new executable must
  // satisfy that requirement, not merely display the same bundle identifier.
  run(['/usr/bin/codesign', '--verify', '--strict', '-R', '=' + previous.identity.requirement, join(next.contents, runtimeBundle)])
  const home = join(isolated, 'home'); await mkdir(home)
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  for (const key of ['CODEX_HOME', 'GALTA_CODEX_BIN', 'GALTA_MCP_BIN', 'GALTA_RELEASE_DIRECTORY', 'GALTA_BUNDLED_CODEX_BIN', 'GALTA_WORKSPACE_DIRECTORY', 'GALTA_RUNTIME_DIRECTORY', 'GALTA_BRIDGE_DIRECTORY']) delete env[key]
  const data = join(home, 'Library/Application Support/Galta')
  const origin = `chrome-extension://${next.release.release.extensionId}/`
  const install = async (contents: string) => {
    const result = JSON.parse(run([join(contents, runtimeExecutable), 'install', contents], undefined, env))
    // Read back the selected payload so this checks both old and new CLI result shapes.
    if (!result.runtime.available || typeof result.directory !== 'string'
      || await realpath(join(data, 'current')) !== result.directory
      || (await readRelease(result.directory, true)).id !== result.releaseId) throw new Error('Activated runtime is not ready')
    return result as { directory: string; releaseId: string }
  }
  const connect = async () => {
    const client = new NativeClient(join(data, 'current/Resources/galta-codex-bridge'), origin, env)
    clients.push(client)
    await client.request('initialize', { clientInfo: { name: 'galta_upgrade_verification', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } })
    client.notify('initialized')
    return client
  }
  const checkPinned = async (client: NativeClient, directory: string) => {
    const { config } = await client.request('config/read', { includeLayers: false })
    if (config.mcp_servers?.galta?.command !== join(directory, 'Resources/galta-mcp')) throw new Error('A running connection changed its pinned release')
    if ((await client.request('account/read', { refreshToken: false })).account) throw new Error('Upgrade verification must not inherit an account')
  }
  const old = await install(previous.contents)
  const oldClient = await connect()
  await checkPinned(oldClient, old.directory)
  const marker = join(data, 'workspaces/upgrade-proof/keep.txt')
  await mkdir(join(data, 'workspaces/upgrade-proof'), { recursive: true }); await writeFile(marker, 'preserve-user-data\n')
  const current = await install(next.contents)
  if (old.directory === current.directory || await realpath(join(data, 'current')) !== current.directory) throw new Error('Upgrade did not select a new immutable release')
  await rm(previous.app, { recursive: true }); await rm(next.app, { recursive: true })
  for (const installation of [old, current]) {
    await readRelease(installation.directory, true)
    run(['/usr/bin/codesign', '--verify', '--strict', '-R', '=' + previous.identity.requirement, join(installation.directory, runtimeBundle)])
  }
  await checkPinned(oldClient, old.directory)
  await checkPinned(await connect(), current.directory)
  if (await readFile(marker, 'utf8') !== 'preserve-user-data\n') throw new Error('Upgrade changed existing workspace data')
  console.log(JSON.stringify({ previous: old.releaseId, next: current.releaseId, runtime: next.identity,
    newCodeMeetsPreviousRequirement: true, activeConnectionPreserved: true, newConnectionUsesNewRelease: true,
    sourceAppsRemoved: true, workspaceDataPreserved: true, macOSConsentVerified: false }, null, 2))
} finally {
  await Promise.all(clients.map(client => client.close()))
  await rm(isolated, { recursive: true, force: true })
}
