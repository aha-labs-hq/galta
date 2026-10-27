import { root } from './config'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Packaging and native preview compile the same shipping Swift sources. */
export async function companionSources() {
  return Array.fromAsync(new Bun.Glob('native/companion/**/*.swift').scan({ cwd: root })).then(files => files.sort())
}

/** Use the approved transparent outline as a system-tinted menu bar template. */
export async function copyCompanionResources(resources: string) {
  await copyFile(join(root, 'apps/extension/src/public/galta-logo-outline.svg'), join(resources, 'MenuBarIcon.svg'))
}
