#!/usr/bin/env bun
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { COMPANION_PROTOCOL } from '../packages/runtime/src/lifecycle'
import { checksum, codexExecutable, codexExecutables, codexPackageDirectory, runtimeBundle, runtimeBundleIdentifier, runtimeExecutable, type Release } from '../native/companion/release'
import { minimumMacOS, root, run, validateDistribution, type Distribution } from './distribution/config'
import { prepareDependencies } from './distribution/dependencies'
import { createAppcast } from './distribution/appcast'
import { readCodeIdentity } from './distribution/signing'
import { companionSources, copyCompanionResources } from './distribution/companion'
import { notarize, notaryCredentials } from './distribution/notarize'

const argument = Bun.argv[2]
if (!argument) throw new Error('Usage: bun scripts/package-macos.ts <release-config.json | development-extension-id> [output-directory]')
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This release target is macOS on Apple silicon')
const config = validateDistribution(/^[a-p]{32}$/.test(argument)
  ? { channel: 'development', extensionId: argument, build: 1 }
  : await Bun.file(resolve(argument)).json() as Distribution)
const production = config.channel !== 'development'
const output = resolve(Bun.argv[3] ?? join(root, `output/${config.channel}`))
const identity = Bun.env.GALTA_DEVELOPER_ID_APPLICATION
const notary = production ? notaryCredentials() : undefined
if (production && !identity?.startsWith('Developer ID Application:')) throw new Error('A distributable release requires Developer ID signing')
const signIdentity = production ? identity! : Bun.env.GALTA_DEVELOPMENT_SIGNING_IDENTITY?.trim()
if (!signIdentity) throw new Error('Set GALTA_DEVELOPMENT_SIGNING_IDENTITY to a certificate identity, or explicitly use - for a disposable ad-hoc test build')
if (signIdentity === '-') console.warn('Ad-hoc test build: its code identity changes on rebuild; permission persistence cannot be verified.')
if (production && run(['git', 'status', '--porcelain']).trim()) throw new Error('Commit and review the exact source before creating a distributable release')
const version = (await Bun.file(join(root, 'package.json')).json()).version as string
// Every distributed version tells its users what changed, in Sparkle's update window.
const releaseNotes = join(root, 'distribution/release-notes', `${version}.html`)
if (production && !await Bun.file(releaseNotes).exists()) throw new Error(`Write the release notes first: distribution/release-notes/${version}.html`)
if ((await Bun.file(join(root, 'apps/extension/src/public/manifest.json')).json()).version !== version) throw new Error('Extension and app versions differ')
const sourceCommit = run(['git', 'rev-parse', 'HEAD']).trim()
async function sourceFingerprint() {
  const paths = run(['git', 'ls-files', '-cz', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean).sort()
  const entries: string[] = []
  for (const path of paths) entries.push(path, checksum(await readFile(join(root, path))))
  return checksum(Buffer.from(JSON.stringify(entries)))
}
const sourceHash = await sourceFingerprint()
const dependencies = await prepareDependencies(join(root, 'output/dependencies'))
await mkdir(output, { recursive: true })
const staging = await mkdtemp(join(output, '.package-'))
const notaryEvidence = join(output, 'notarization', basename(staging).slice(1))
if (production) await mkdir(notaryEvidence, { recursive: true })
let completed = false
function sign(path: string, entitlements?: string, hardened = true) {
  run(['/usr/bin/codesign', '--force', '--sign', signIdentity!, '--options', hardened ? 'runtime' : '0', ...(production ? ['--timestamp'] : []), ...(entitlements ? ['--entitlements', entitlements] : []), path])
}
const xml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
try {
  console.log('Building the extension and a single native runtime…')
  run([process.execPath, 'run', 'build'], root, { ...process.env, GALTA_COMPANION_URL: config.downloadUrl ?? '' })
  const extensionDirectory = join(root, 'apps/extension/release')
  const manifest = await Bun.file(join(extensionDirectory, 'manifest.json')).json()
  if (config.extensionPublicKey) manifest.key = config.extensionPublicKey
  await writeFile(join(extensionDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  const app = join(staging, 'Galta.app'), contents = join(app, 'Contents')
  const runtime = contents, bin = join(contents, 'MacOS'), resources = join(contents, 'Resources')
  await mkdir(bin, { recursive: true }); await mkdir(resources); await mkdir(join(contents, 'Frameworks'))
  const runtimeApp = join(contents, runtimeBundle)
  await mkdir(join(runtimeApp, 'Contents/MacOS'), { recursive: true })
  run([process.execPath, 'build', 'native/companion/main.ts', '--compile', '--outfile', join(contents, runtimeExecutable)])
  await writeFile(join(runtimeApp, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${runtimeBundleIdentifier(config.channel)}</string><key>CFBundleName</key><string>Galta</string><key>CFBundleDisplayName</key><string>Galta</string><key>CFBundleExecutable</key><string>galta-runtime</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${config.build}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>${minimumMacOS}</string><key>LSUIElement</key><true/><key>NSDesktopFolderUsageDescription</key><string>Galta accesses Desktop files when your task uses files stored there.</string><key>NSDocumentsFolderUsageDescription</key><string>Galta accesses Documents files when your task uses files stored there.</string><key>NSDownloadsFolderUsageDescription</key><string>Galta accesses Downloads files when your task uses files stored there.</string></dict></plist>\n`)
  sign(runtimeApp, join(root, 'native/companion/runtime.entitlements.plist'))
  const runtimeIdentity = readCodeIdentity(runtimeApp)
  if (runtimeIdentity.identifier !== runtimeBundleIdentifier(config.channel)) throw new Error('Runtime signing identity differs from its bundle identity')
  if (signIdentity !== '-' && (!runtimeIdentity.team || /\bcdhash\b/.test(runtimeIdentity.requirement))) throw new Error('Certificate signing must produce an identity that survives runtime updates')
  run(['/usr/bin/clang', '-O2', '-Wall', '-Wextra', '-Werror', '-target', `arm64-apple-macosx${minimumMacOS}`, 'native/companion/activation-lock.c', '-o', join(bin, 'galta-lock')])
  sign(join(bin, 'galta-lock'))
  run(['/usr/bin/ditto', dependencies.codex, join(contents, codexPackageDirectory)])
  for (const file of codexExecutables) {
    await chmod(join(contents, file), 0o755)
    sign(join(contents, file), file.endsWith('/codex-code-mode-host') ? join(root, 'native/companion/code-mode.entitlements.plist') : undefined)
  }
  // Resolve the immutable release once. Existing hosts and their children keep it across updates.
  for (const [name, role] of [['canvas-bridge', 'canvas'], ['codex-bridge', 'codex'], ['mcp', 'mcp'], ['companion', 'companion']] as const) {
    const launcher = join(resources, `galta-${name}`)
    await writeFile(launcher, `#!/bin/sh\nset -eu\nGALTARELEASE="$(CDPATH= cd -P -- "$(dirname -- "$0")/.." && pwd -P)"\nexport GALTA_RELEASE_DIRECTORY="$GALTARELEASE"\nexport GALTA_BUNDLED_CODEX_BIN="$GALTARELEASE/${codexExecutable}"\nexport GALTA_MCP_BIN="$GALTARELEASE/Resources/galta-mcp"\nexec "$GALTARELEASE/${runtimeExecutable}" ${role} "$@"\n`, { mode: 0o755 })
  }
  await copyFile(dependencies.codexLicense, join(resources, 'Codex-LICENSE'))
  const files: Record<string, string> = {}
  async function recordFiles(directory: string) {
    for (const entry of await readdir(join(runtime, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`
      if (entry.isDirectory()) await recordFiles(file)
      else if (entry.isFile()) files[file] = checksum(await readFile(join(runtime, file)))
      else throw new Error(`Unexpected release entry: ${file}`)
    }
  }
  for (const directory of ['MacOS', 'Resources', 'Helpers']) await recordFiles(directory)
  const release: Release = { schema: 1, version, build: config.build, channel: config.channel, extensionId: config.extensionId, protocol: COMPANION_PROTOCOL, files }
  await writeFile(join(resources, 'release.json'), JSON.stringify(release, null, 2) + '\n')

  const framework = join(contents, 'Frameworks/Sparkle.framework')
  run(['/usr/bin/ditto', join(dependencies.sparkle, 'Sparkle.framework'), framework])
  for (const path of ['Versions/B/XPCServices/Downloader.xpc', 'Versions/B/XPCServices/Installer.xpc', 'Versions/B/Autoupdate', 'Versions/B/Updater.app', '']) sign(join(framework, path))
  await copyFile(join(dependencies.sparkle, 'LICENSE'), join(resources, 'Sparkle-LICENSE'))
  const iconset = join(staging, 'Galta.iconset')
  run(['/usr/bin/swift', 'scripts/render-icons.swift', join(staging, 'icons'), iconset]); run(['/usr/bin/iconutil', '-c', 'icns', iconset, '-o', join(resources, 'AppIcon.icns')])
  const swiftSources = await companionSources()
  await copyCompanionResources(resources)
  run(['/usr/bin/swiftc', '-parse-as-library', '-O', '-target', `arm64-apple-macosx${minimumMacOS}`, '-F', join(contents, 'Frameworks'), '-framework', 'Sparkle', '-Xlinker', '-rpath', '-Xlinker', '@executable_path/../Frameworks', ...swiftSources, '-o', join(contents, 'MacOS/Galta')])
  const update = production ? `<key>SUFeedURL</key><string>${xml(config.appcastUrl!)}</string><key>SUPublicEDKey</key><string>${xml(config.updatePublicKey!)}</string><key>SUEnableAutomaticChecks</key><true/><key>SUAutomaticallyUpdate</key><false/><key>SUVerifyUpdateBeforeExtraction</key><true/><key>SURequireSignedFeed</key><true/>` : ''
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.galta.companion${production ? '' : '.development'}</string><key>CFBundleName</key><string>Galta</string><key>CFBundleExecutable</key><string>Galta</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${config.build}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>${minimumMacOS}</string><key>CFBundleIconFile</key><string>AppIcon</string><key>NSHighResolutionCapable</key><true/>${update}</dict></plist>\n`)
  // Local ad-hoc identities have no Team ID for dyld library validation.
  // Distribution always uses hardened runtime; native roles do so in every build.
  sign(join(contents, 'MacOS/Galta'), undefined, signIdentity !== '-'); sign(app, undefined, signIdentity !== '-')
  run(['/usr/bin/codesign', '--verify', '--deep', '--strict', app])
  run([join(contents, 'MacOS/Galta'), '--verify-bundle'])
  const archive = join(staging, 'Galta.zip')
  const zip = () => run(['/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', app, archive])
  zip()
  if (production) {
    console.log('Notarizing the app…')
    await notarize(archive, notary!, notaryEvidence)
    run(['/usr/bin/xcrun', 'stapler', 'staple', app]); run(['/usr/bin/xcrun', 'stapler', 'validate', app]); zip(); run(['/usr/sbin/spctl', '-a', '-t', 'exec', app])
  }
  const label = `Galta-${version}${production ? `-${config.build}` : ''}-mac-arm64${production ? '' : '-local-candidate'}`
  const companion = join(output, `${label}.zip`), diskImage = join(output, `${label}.dmg`)
  const dmgRoot = join(staging, 'disk'); await mkdir(dmgRoot)
  run(['/usr/bin/ditto', app, join(dmgRoot, 'Galta.app')]); await symlink('/Applications', join(dmgRoot, 'Applications'))
  run(['/usr/bin/hdiutil', 'create', '-quiet', '-volname', 'Galta', '-fs', 'APFS', '-srcfolder', dmgRoot, '-format', 'UDZO', join(staging, 'Galta.dmg')])
  if (production) {
    sign(join(staging, 'Galta.dmg'))
    await notarize(join(staging, 'Galta.dmg'), notary!, notaryEvidence)
    run(['/usr/bin/xcrun', 'stapler', 'staple', join(staging, 'Galta.dmg')])
    run(['/usr/bin/xcrun', 'stapler', 'validate', join(staging, 'Galta.dmg')])
    run(['/usr/sbin/spctl', '-a', '-t', 'open', '--context', 'context:primary-signature', join(staging, 'Galta.dmg')])
  }
  const extension = join(output, `Galta-extension-${version}${production ? '' : '-local-candidate'}.zip`)
  run(['/usr/bin/zip', '-X', '-q', '-r', join(staging, 'extension.zip'), '.'], extensionDirectory)
  await rename(archive, companion); await rename(join(staging, 'Galta.dmg'), diskImage); await rename(join(staging, 'extension.zip'), extension)
  if (production) await copyFile(await createAppcast(companion, staging, dependencies.sparkle, config, releaseNotes), join(output, 'appcast.xml'))
  const artifact = async (path: string) => ({ file: basename(path), sha256: checksum(await readFile(path)) })
  if (await sourceFingerprint() !== sourceHash) throw new Error('Source changed during packaging; rebuild before distributing these artifacts')
  await writeFile(join(output, 'package-receipt.json'), JSON.stringify({
    schema: 2, version, build: config.build, channel: config.channel, extensionId: config.extensionId, minimumMacOS,
    sourceCommit, sourceHash, workingTreeClean: !run(['git', 'status', '--porcelain']).trim(), signed: signIdentity !== '-', notarized: production, updatesConfigured: production, dependencies: dependencies.lock,
    signing: { kind: production ? 'developer-id' : signIdentity === '-' ? 'ad-hoc' : 'development', runtime: runtimeIdentity },
    ...(production ? { appcast: await artifact(join(output, 'appcast.xml')) } : {}),
    extension: await artifact(extension), companion: await artifact(companion), diskImage: await artifact(diskImage),
  }, null, 2) + '\n')
  console.log(`Built ${label}. Verify with: bun run package:verify ${output}`)
  completed = true
} finally {
  if (completed || !production) await rm(staging, { recursive: true, force: true })
  else console.error(`Packaging stopped. Candidate files are retained at ${staging}; they are not a completed release. Inspect notarization records before resubmitting.`)
}
