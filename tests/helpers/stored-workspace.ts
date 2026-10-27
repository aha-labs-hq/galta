import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

// Test code executes the public repository against real IndexedDB, without
// depending on its physical record layout or adding production debug globals.
const storage = execFileSync('bun', ['build', resolve('tests/helpers/storage-entry.ts'), '--target=browser', '--format=iife'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) + '\nconst Repository = globalThis.__galtaTestRepository, portable = globalThis.__galtaTestPortable; delete globalThis.__galtaTestRepository; delete globalThis.__galtaTestPortable;'

export async function storedWorkspaces(page: Page) {
  return page.evaluate(`(async () => { ${storage}\nconst repo = new Repository(); return Promise.all((await repo.list()).map(item => repo.load(item.id).then(portable))); })()`)
}

/** Digest real persisted bytes in the browser; large-media acceptance must not
 * base64-encode every historical source just to transfer an assertion. */
export async function storedHeadMediaHashes(page: Page): Promise<Record<string, Array<{ mimeType: string; bytes: number; sha256: string }>>> {
  return page.evaluate(`(async () => { ${storage}\nconst repo = new Repository(), result = {}; for (const item of await repo.list()) { const workspace = await repo.load(item.id), files = Object.values(workspace.snapshots[workspace.project.headCommitId].document.files); result[item.id] = await Promise.all(files.map(async file => ({ mimeType: file.mimeType, bytes: file.blob.size, sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.blob.arrayBuffer())), n => n.toString(16).padStart(2, '0')).join('') }))); } return result; })()`)
}

export async function storedWorkspace(page: Page, id = 'default-project') {
  return page.evaluate(`(async () => { ${storage}\nreturn new Repository().load(${JSON.stringify(id)}).then(portable); })()`)
}

/** Ask the real repository to delete a canvas; returns its refusal, if any. */
export async function removeStoredWorkspace(page: Page, id: string): Promise<string | null> {
  return page.evaluate(`(async () => { ${storage}\ntry { await new Repository().remove(${JSON.stringify(id)}); return null } catch (error) { return String(error.message ?? error) } })()`)
}

export async function seedWorkspace(page: Page, bundle: any) {
  await page.evaluate(`(async () => { ${storage}\nawait new Repository().save(${JSON.stringify(bundle)}); })()`)
}
