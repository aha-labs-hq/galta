import { chromium, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtemp, mkdir, writeFile, chmod, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// A real extension and Chrome Native Messaging test. The native manifest and
// document store stay inside a disposable profile; no user's artwork is opened.
const root = resolve(import.meta.dir, '..'), temporary = await mkdtemp(join(tmpdir(), 'galta-native-mcp-'))
const directory = join(temporary, 'bridges'); await mkdir(directory, { mode: 0o700 })
const executablePath = process.env.GALTA_EXTENSION_CHROME_PATH ?? chromium.executablePath()
const extension = join(root, 'apps/extension/release')
const browser = await chromium.launchPersistentContext(join(temporary, 'profile'), { executablePath, headless: true, viewport: { width: 1200, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
const hostDirectory = join(temporary, 'profile/NativeMessagingHosts')
const manifestPath = join(hostDirectory, 'com.galta.canvas.json')
const client = new Client({ name: 'Native extension acceptance', version: '1' })
try {
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker', { timeout: 15000 })
  const extensionId = new URL(worker.url()).host
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const wrapper = join(temporary, 'host.sh')
  await writeFile(wrapper, `#!/bin/sh\nexport GALTA_BRIDGE_DIRECTORY=${quote(directory)}\nexport GALTA_WORKSPACE_DIRECTORY=${quote(join(temporary, 'workspaces'))}\nexec ${quote(join(root, 'native/bridge/galta-canvas-bridge'))} "$@"\n`)
  await chmod(wrapper, 0o700); await mkdir(hostDirectory, { recursive: true })
  await writeFile(manifestPath, JSON.stringify({ name: 'com.galta.canvas', description: 'Galta native acceptance', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }))
  const page = await browser.newPage(), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`chrome-extension://${extensionId}/canvas/index.html`)
  await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  try { await expect.poll(async () => (await readdir(directory)).length, { timeout: 15000 }).toBe(1) }
  catch (error) {
    const diagnostic = await worker.evaluate(() => new Promise(resolve => {
      const port = chrome.runtime.connectNative('com.galta.canvas')
      port.onDisconnect.addListener(() => resolve(chrome.runtime.lastError?.message))
      setTimeout(() => { port.disconnect(); resolve('Host connected') }, 1000)
    }))
    console.error({ diagnostic, hostDirectory, extensionId }); throw error
  }
  await client.connect(new StdioClientTransport({ command: join(root, 'native/mcp/galta-mcp'), env: { GALTA_BRIDGE_DIRECTORY: directory }, stderr: 'inherit' }))
  const call = async (name: string, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError).not.toBe(true)
    return JSON.parse((result.content as any[]).find(item => item.type === 'text').text)
  }
  const [canvas] = await call('canvas_list')
  await call('canvas_connect', { canvasId: canvas.id })
  const { revision } = await call('canvas_inspect')
  await call('canvas_edit', { revision, operations: [{ type: 'create_text', text: 'Native MCP · editable and saved', x: 300, y: 300, props: { fontFamily: 2, fontSize: 28 } }] })
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await call('canvas_disconnect')
  await page.reload()
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await page.screenshot({ path: join(temporary, 'native.png') })
  expect(errors).toEqual([])
  const receipt = { extensionId, realNativeMessaging: true, productionExtension: true, persistedAfterReload: true, errors, passed: true }
  await writeFile(join(temporary, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ evidence: temporary, ...receipt }, null, 2))
} finally {
  await client.close(); await browser.close()
}
