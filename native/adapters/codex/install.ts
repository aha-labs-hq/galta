#!/usr/bin/env bun

import { installNativeHost } from '../../installation'

const extensionId = Bun.argv[2]
const browser = (Bun.argv[4] ?? 'dia').toLowerCase()
if (!['chrome', 'dia'].includes(browser)) {
  console.error('Browser must be chrome or dia')
  process.exit(2)
}

const { manifest, path, dataDirectory, migratedFrom } = await installNativeHost('codex', extensionId, Bun.argv[3])
console.log(`Installed Galta Codex adapter: ${path}\nManaged data: ${dataDirectory}${migratedFrom ? `\nMigrated managed data from: ${migratedFrom}` : ''}\nNative host manifest: ${manifest}\nReload the extension to use this build.`)
