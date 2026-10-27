import { chromium } from '@playwright/test'
import { copyFile, chmod, mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

type Installation = { directory: string; bridgeDirectory: string; workspaceDirectory: string; runtimeDirectory: string; canvasHost: string; codexHost: string; mcp: string }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Candidate-only installation. Chrome and native hosts run in a disposable
 * profile outside the checkout; no user registration, canvas or auth file is
 * read or replaced. The real Codex process owns its existing authentication. */
export async function installedExtension(root: string, options: {
  prefix: string
  codexCommand?: (installation: Installation) => Promise<string[]>
} ) {
  const directory = await mkdtemp(join(tmpdir(), options.prefix))
  const installation: Installation = {
    directory, bridgeDirectory: join(directory, 'bridges'), workspaceDirectory: join(directory, 'workspaces'), runtimeDirectory: join(directory, 'runtime'),
    canvasHost: join(directory, 'galta-canvas-bridge'), codexHost: join(directory, 'galta-codex-bridge'), mcp: join(directory, 'galta-mcp')
  }
  await Promise.all([installation.bridgeDirectory, installation.workspaceDirectory, installation.runtimeDirectory].map(path => mkdir(path, { mode: 0o700 })))
  const hashes: Record<string, string> = {}
  for (const [source, target] of [
    ['native/bridge/galta-canvas-bridge', installation.canvasHost],
    ['native/adapters/codex/galta-codex-bridge', installation.codexHost],
    ['native/mcp/galta-mcp', installation.mcp]
  ]) {
    await copyFile(join(root, source!), target!); await chmod(target!, 0o700)
    hashes[source!] = createHash('sha256').update(await readFile(target!)).digest('hex')
  }
  const codexCommand = options.codexCommand ? await options.codexCommand(installation) : [installation.codexHost]
  const executablePath = process.env.GALTA_EXTENSION_CHROME_PATH ?? chromium.executablePath()
  const extension = resolve(process.env.GALTA_ACCEPTANCE_BUILD ?? join(root, 'apps/extension/release'))
  const browser = await chromium.launchPersistentContext(join(directory, 'profile'), { executablePath, headless: true, viewport: { width: 1200, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  try {
    const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker', { timeout: 15000 })
    const extensionId = new URL(worker.url()).host, origin = `chrome-extension://${extensionId}`
    const hostDirectory = join(directory, 'profile/NativeMessagingHosts'); await mkdir(hostDirectory, { recursive: true })
    const environment = {
      GALTA_BRIDGE_DIRECTORY: installation.bridgeDirectory, GALTA_WORKSPACE_DIRECTORY: installation.workspaceDirectory,
      GALTA_RUNTIME_DIRECTORY: installation.runtimeDirectory, GALTA_MCP_BIN: installation.mcp,
      ...(process.env.GALTA_CODEX_BIN ? { GALTA_CODEX_BIN: process.env.GALTA_CODEX_BIN } : {})
    }
    for (const [name, command] of [['canvas', [installation.canvasHost]], ['codex', codexCommand]] as const) {
      const wrapper = join(directory, `${name}.sh`)
      // Desktop parent-session IPC must not enter the independent Galta host.
      const content = `#!/bin/sh\ncd ${quote(directory)} || exit 1\nunset CODEX_APP_TOOLS_PIPE_PATH CODEX_THREAD_ID CODEX_SESSION_ID CODEX_INTERNAL_ORIGINATOR_OVERRIDE CODEX_PERMISSION_PROFILE\n${Object.entries(environment).map(([key, value]) => `export ${key}=${quote(value)}`).join('\n')}\nexec ${command.map(quote).join(' ')} "$@" 2>${quote(join(directory, `${name}.log`))}\n`
      await writeFile(wrapper, content); await chmod(wrapper, 0o700)
      await writeFile(join(hostDirectory, `com.galta.${name}.json`), JSON.stringify({ name: `com.galta.${name}`, description: 'Isolated candidate acceptance', path: wrapper, type: 'stdio', allowed_origins: [`${origin}/`] }))
    }
    return { ...installation, browser, worker, origin, extensionId, hashes }
  } catch (error) { await browser.close(); throw error }
}
