#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { companionSources, copyCompanionResources } from './distribution/companion'
import { root, minimumMacOS, run } from './distribution/config'

if (process.platform !== 'darwin') throw new Error('Native companion preview requires macOS')
// Browser buttons open this extension's canvas; pass the ID of a loaded Galta to open its real page.
const extensionId = Bun.argv[2] ?? 'a'.repeat(32)
if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Usage: bun run companion:preview [extension-id]')
const app = join(root, 'output/companion-preview/Galta Preview.app')
const contents = join(app, 'Contents')
await mkdir(join(contents, 'MacOS'), { recursive: true })
await mkdir(join(contents, 'Resources'), { recursive: true })
await copyCompanionResources(join(contents, 'Resources'))
const sources = (await companionSources()).filter(file => !file.startsWith('native/companion/App/'))
run(['/usr/bin/swiftc', '-parse-as-library', '-warnings-as-errors', '-target', `arm64-apple-macosx${minimumMacOS}`, ...sources, 'tests/native/CompanionFixtures.swift', 'tests/native/CompanionPreview.swift', '-o', join(contents, 'MacOS/GaltaPreview')])
const iconset = join(root, 'output/companion-preview/Galta.iconset')
run(['/usr/bin/swift', 'scripts/render-icons.swift', join(root, 'output/companion-preview/icons'), iconset])
run(['/usr/bin/iconutil', '-c', 'icns', iconset, '-o', join(contents, 'Resources/AppIcon.icns')])
await Bun.write(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.galta.companion.preview</string><key>CFBundleName</key><string>Galta Preview</string><key>CFBundleExecutable</key><string>GaltaPreview</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>${minimumMacOS}</string><key>CFBundleIconFile</key><string>AppIcon</string><key>NSHighResolutionCapable</key><true/><key>GaltaPreviewExtensionID</key><string>${extensionId}</string></dict></plist>`)
run(['/usr/bin/codesign', '--force', '--sign', '-', app])
console.log(`Built ${app}\nOpen this app for native UI acceptance. The Preview menu selects isolated fixture states. Browser buttons open chrome-extension://${extensionId}/canvas/index.html in the selected browser; the preview never installs or changes canvas data.`)
