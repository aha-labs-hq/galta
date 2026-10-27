#!/usr/bin/env bun
import { installNativeHost } from '../installation'
import { nativeBinaryDirectory } from '../paths'

const extensionId = Bun.argv[2]
const { manifest, path, dataDirectory, migratedFrom } = await installNativeHost('canvas', extensionId, Bun.argv[3])
console.log(`Installed Galta Canvas Bridge: ${path}\nMCP executable: ${nativeBinaryDirectory}/galta-mcp\nManaged data: ${dataDirectory}${migratedFrom ? `\nMigrated managed data from: ${migratedFrom}` : ''}\nNative host manifest: ${manifest}\nReload the extension to use this build.`)
