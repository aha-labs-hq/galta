import { chromium, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, chmod, readFile, copyFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { connectCodex } from '../tests/helpers/canvas-port'
import { codexTestHome } from './lib/codex-test-home'

// Opt-in real model + real extension + real native messaging, in an isolated
// profile. The only operated page is a local test form; no user canvas is used.
const root = resolve(import.meta.dir, '..'), directory = await mkdtemp(join(tmpdir(), 'galta-source-live-'))
const profile = join(directory, 'profile'), bridges = join(directory, 'bridges'), workspaces = join(directory, 'workspaces')
await mkdir(bridges, { mode: 0o700 })
const isolated = await codexTestHome()
const executablePath = process.env.GALTA_EXTENSION_CHROME_PATH ?? chromium.executablePath()
const extension = join(root, 'apps/extension/release')
const browser = await chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: { width: 1200, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
const deadline = setTimeout(() => { void browser.close() }, 300_000)
const code = 'CAT-' + crypto.randomUUID().slice(0, 6).toUpperCase()
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<!doctype html><title>Galta source-page verification</title><h1>Reference image</h1><img id="reference" alt="Reference code" width="600" height="200"><form><label>Observed code <input id="code"></label><button type="submit">Apply</button></form><p id="result"></p><script>document.querySelector("form").onsubmit=e=>{e.preventDefault();document.getElementById("result").textContent=document.getElementById("code").value}</script>', { headers: { 'Content-Type': 'text/html' } }) })
try {
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker')
  const extensionId = new URL(worker.url()).host
  const hostDirectory = join(profile, 'NativeMessagingHosts'); await mkdir(hostDirectory, { recursive: true })
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const mcpBinary = join(directory, 'galta-mcp')
  await copyFile(join(root, 'native/mcp/galta-mcp'), mcpBinary)
  await chmod(mcpBinary, 0o700)
  for (const [kind, binary] of [['canvas', 'native/bridge/galta-canvas-bridge'], ['codex', 'native/adapters/codex/galta-codex-bridge']]) {
    const wrapper = join(directory, `${kind}.sh`)
    const installed = join(directory, `galta-${kind}-bridge`)
    await copyFile(join(root, binary!), installed); await chmod(installed, 0o700)
    await writeFile(wrapper, `#!/bin/sh\nexport CODEX_HOME=${quote(isolated.home)}\nexport GALTA_BRIDGE_DIRECTORY=${quote(bridges)}\nexport GALTA_WORKSPACE_DIRECTORY=${quote(workspaces)}\nexport GALTA_MCP_BIN=${quote(mcpBinary)}\nexport GALTA_CODEX_BIN=${quote(process.env.GALTA_CODEX_BIN ?? join(homedir(), '.local/bin/codex'))}\nexec ${quote(installed)} "$@" 2>${quote(join(directory, kind + '.log'))}\n`)
    await chmod(wrapper, 0o700)
    await writeFile(join(hostDirectory, `com.galta.${kind}.json`), JSON.stringify({ name: `com.galta.${kind}`, description: 'Isolated source browser verification', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }))
  }
  const source = await browser.newPage(); await source.goto(`http://127.0.0.1:${server.port}/`)
  await source.evaluate(code => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 200
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#f2f4ed'; ctx.fillRect(0, 0, 600, 200)
    ctx.fillStyle = '#182f32'; ctx.font = 'bold 64px sans-serif'; ctx.fillText(code, 40, 120)
    ;(document.getElementById('reference') as HTMLImageElement).src = canvas.toDataURL('image/png')
  }, code)
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0]!.id!, source.url())
  const panel = await browser.newPage()
  await panel.goto(`chrome-extension://${extensionId}/canvas/index.html#returnTab=${tabId}`)
  await expect(panel.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  try { await connectCodex(panel) }
  catch (error) { console.error({ directory, page: await panel.locator('body').innerText(), nativeError: await readFile(join(directory, 'codex.log'), 'utf8').catch(() => '') }); throw error }
  const model = process.env.GALTA_VERIFY_MODEL ?? 'gpt-6-astra'
  const connection = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'codex-connect' }))
  const selected = connection.models?.find((item: any) => item.id === model)
  if (!selected) throw new Error(`Model ${model} is unavailable`)
  await panel.getByRole('button', { name: /^Model / }).click()
  await panel.getByRole('radiogroup', { name: 'Model', exact: true }).getByText(selected.displayName ?? selected.id, { exact: true }).click()
  await panel.getByRole('button', { name: /^Effort / }).click()
  await panel.getByRole('menuitemradio', { name: 'Low', exact: true }).click()
  await panel.keyboard.press('Escape')
  async function latest() {
    return panel.evaluate(() => new Promise<any>((resolve, reject) => {
      const request = indexedDB.open('galta-v1')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result, read = db.transaction('workspaces').objectStore('workspaces').get('default-project')
        read.onsuccess = () => { const w = read.result; db.close(); resolve(w?.agentSessions?.find((s: any) => s.id === w.runtimeDefaults?.sessionId)) }
        read.onerror = () => { db.close(); reject(read.error) }
      }
    }))
  }
  async function run(instruction: string, count: number) {
    await panel.getByRole('textbox', { name: 'Ask Galta' }).fill(instruction)
    await panel.getByRole('button', { name: 'Run command', exact: true }).click()
    await source.bringToFront()
    await expect.poll(async () => { const session = await latest(); return session?.turns.length === count && !!session.turns.at(-1).completedAt }, { timeout: 220_000, intervals: [1000] }).toBe(true)
    const session = await latest(), turn = session.turns.at(-1)
    console.log(JSON.stringify({ count, threadId: session.threadId, status: turn.status, items: turn.items.map((i: any) => ({ type: i.type, tool: i.tool, text: i.text })) }))
    expect(turn.status).toBe('completed')
    return session
  }
  const first = await run('只回复“准备好了”。不要调用工具或修改画布。', 1)
  const second = await run('看左边当前网页。用 Galta 的 browser_inspect 和 browser_capture 读取并看清参考图片里的代码，然后用 browser_act 将代码填入 Observed code 输入框，点击 Apply，用 browser_inspect 核实结果并回复代码。这是专用测试表单，允许提交。只用 Galta 网页工具，不修改画布，不用命令行。', 2)
  expect(second.threadId).toBe(first.threadId)
  await expect(source.locator('#result')).toHaveText(code)
  const items = second.turns[1].items
  for (const tool of ['browser_inspect', 'browser_capture', 'browser_act']) expect(items.some((i: any) => i.tool === tool)).toBe(true)
  expect(items.filter((i: any) => i.type === 'agentMessage').map((i: any) => i.text).join('\n')).toContain(code)
  const evidence = join(root, 'docs/evidence/source-browser-2026-09-19'); await mkdir(evidence, { recursive: true })
  await source.screenshot({ path: join(evidence, 'verified-source.png') })
  const receipt = { passed: true, model, threadId: second.threadId, continuedThread: true, realNativeMessaging: true, productionExtension: true, rasterOnlyCode: code, formResult: await source.locator('#result').innerText(), tools: items.filter((i: any) => i.tool).map((i: any) => i.tool), evidenceDirectory: directory, backgroundSha256: createHash('sha256').update(await readFile(join(extension, 'background.js'))).digest('hex') }
  await writeFile(join(evidence, 'live.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt))
} finally {
  clearTimeout(deadline); server.stop(); await browser.close(); await isolated.close()
}
