import { chromium, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, chmod, readFile, copyFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { connectCodex } from '../tests/helpers/canvas-port'
import { codexTestHome } from './lib/codex-test-home'
import { writeAgentRunReceipt } from './lib/agent-evaluation'
import { registerCompanionFixture } from './lib/companion-fixture'

// Opt-in real model + real extension + real native messaging, in an isolated
// profile. The only operated page is a local test form; no user canvas is used.
const root = resolve(import.meta.dir, '..'), directory = await mkdtemp(join(tmpdir(), 'galta-source-live-'))
process.chdir(root)
const evidence = join(directory, 'evidence')
await mkdir(evidence)
const profile = join(directory, 'profile'), bridges = join(directory, 'bridges'), workspaces = join(directory, 'workspaces')
await mkdir(bridges, { mode: 0o700 })
const isolated = await codexTestHome()
const executablePath = process.env.GALTA_EXTENSION_CHROME_PATH ?? chromium.executablePath()
const extension = join(root, 'apps/extension/release')
const launch = () => chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: { width: 1200, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
let browser = await launch()
const deadline = setTimeout(() => { void browser.close() }, 300_000)
const canvasCode = 'CANVAS-' + crypto.randomUUID().slice(0, 6).toUpperCase()
const code = 'CAT-' + crypto.randomUUID().slice(0, 6).toUpperCase()
let modelId = 'unknown', lastRunSession: any = null, modelAvailable = false
let runStatus: 'completed' | 'failed' | 'timed_out' | 'cancelled' = 'failed'
let scenarioReceipts: any[] = [
  { id: 'source-page-reference-task', success: false, toolCalls: [] },
  { id: 'canvas-media-task', success: false, toolCalls: [] }
]
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
    await writeFile(wrapper, `#!/bin/sh\nexport CODEX_HOME=${quote(isolated.home)}\nexport CODEX_INTERNAL_ORIGINATOR_OVERRIDE=galta\nexport GALTA_BRIDGE_DIRECTORY=${quote(bridges)}\nexport GALTA_WORKSPACE_DIRECTORY=${quote(workspaces)}\nexport GALTA_MCP_BIN=${quote(mcpBinary)}\nexport GALTA_CODEX_BIN=${quote(process.env.GALTA_CODEX_BIN ?? join(homedir(), '.local/bin/codex'))}\nexec ${quote(installed)} "$@" 2>${quote(join(directory, kind + '.log'))}\n`)
    await chmod(wrapper, 0o700)
    await writeFile(join(hostDirectory, `com.galta.${kind}.json`), JSON.stringify({ name: `com.galta.${kind}`, description: 'Isolated source browser verification', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }))
  }
  await registerCompanionFixture(directory, hostDirectory, extensionId)
  async function openSource() {
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.evaluate(code => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 200
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#f2f4ed'; ctx.fillRect(0, 0, 600, 200)
    ctx.fillStyle = '#182f32'; ctx.font = 'bold 64px sans-serif'; ctx.fillText(code, 40, 120)
    ;(document.getElementById('reference') as HTMLImageElement).src = canvas.toDataURL('image/png')
    }, code)
    return page
  }
  let source = await openSource()
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0]!.id!, source.url())
  let panel = await browser.newPage()
  await panel.goto(`chrome-extension://${extensionId}/canvas/index.html#returnTab=${tabId}`)
  await expect(panel.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  try { await connectCodex(panel) }
  catch (error) { console.error({ directory, page: await panel.locator('body').innerText(), nativeError: await readFile(join(directory, 'codex.log'), 'utf8').catch(() => '') }); throw error }
  const model = process.env.GALTA_VERIFY_MODEL ?? 'gpt-6-astra'; modelId = model
  const connection = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'codex-connect' }))
  const selected = connection.models?.find((item: any) => item.id === model)
  if (!selected) throw new Error(`Model ${model} is unavailable`)
  modelAvailable = true
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
    await panel.getByRole('button', { name: 'Send message', exact: true }).click()
    await source.bringToFront()
    await expect.poll(async () => {
      const session = await latest().catch(() => null)
      if (session) lastRunSession = session
      return session?.turns.length === count && !!session.turns.at(-1)?.completedAt
    }, { timeout: 220_000, intervals: [1000] }).toBe(true)
    const session = await latest(); lastRunSession = session
    const turn = session.turns.at(-1)
    console.log(JSON.stringify({ count, threadId: session.threadId, status: turn.status, items: turn.items.map((i: any) => ({ type: i.type, tool: i.tool, text: i.text })) }))
    expect(turn.status).toBe('completed')
    return session
  }
  // Restart the app-server, then continue the same thread through MCP. Neither
  // its conversation history nor its identity may be replaced.
  const cwd = join(workspaces, createHash('sha256').update('default-project').digest('hex').slice(0, 32))
  await mkdir(join(cwd, 'outputs'), { recursive: true })
  const canvasImage = join(cwd, 'outputs', 'raster-only.png')
  const raster = await panel.evaluate(code => {
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 240
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#f4edda'; ctx.fillRect(0, 0, 800, 240)
    ctx.fillStyle = '#123b40'; ctx.font = 'bold 58px sans-serif'; ctx.fillText(code, 30, 140)
    return canvas.toDataURL('image/png').split(',')[1]!
  }, canvasCode)
  await writeFile(canvasImage, Buffer.from(raster, 'base64'))
  const first = await run('只回复“准备好了”。不要调用工具或修改画布。', 1)
  const originalThreadId = first.threadId
  const before = await panel.evaluate(async threadId => {
    const response = await chrome.runtime.sendMessage({ type: 'codex-rpc', ownerId: 'verification', requestId: 'before', method: 'thread/read', params: { threadId, includeTurns: true } })
    if (!response.ok) throw new Error(response.error)
    return response.result.thread
  }, originalThreadId)
  // The native port belongs to the background worker, not the panel. Closing
  // this isolated browser guarantees a fresh app-server and tool catalog.
  await browser.close()
  browser = await launch()
  const resumedWorker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker')
  source = await openSource()
  const resumedTabId = await resumedWorker.evaluate(async url => (await chrome.tabs.query({ url }))[0]!.id!, source.url())
  panel = await browser.newPage()
  await panel.goto(`chrome-extension://${extensionId}/canvas/index.html#returnTab=${resumedTabId}`)
  // The profile remembers the built-in chat, so the reopened canvas reconnects
  // to a fresh app-server by itself.
  await expect(panel.getByRole('button', { name: 'Send message', exact: true })).toBeVisible({ timeout: 30_000 })
  const second = await run(`通过 galta MCP 完成以下测试：用 browser_inspect 和 browser_capture 看清左侧网页参考图里的代码，用 browser_act 填入 Observed code 并点击 Apply，读回核实。允许提交这个专用测试表单。然后用 canvas_inspect 读取画布，用 canvas_edit 添加文字 MCP unified，用 canvas_place 将已准备好的图片 ${canvasImage} 放上画布（宽800高240）。调用 canvas_capture 单独看清新放的图片里另一个代码，再用 canvas_extract 导出这张图片，并用 canvas_inspect 核实结果。最后回复网页代码、画布图片代码和导出路径。只用 galta MCP，不用命令行；这张图片中另一个代码必须通过 canvas_capture 看图识别。`, 2)
  expect(second.threadId).toBe(first.threadId)
  await expect(source.locator('#result')).toHaveText(code)
  const items = second.turns[1].items
  expect(items.some((i: any) => i.type === 'dynamicToolCall')).toBe(false)
  for (const tool of ['browser_inspect', 'browser_capture', 'browser_act', 'canvas_inspect', 'canvas_edit', 'canvas_place', 'canvas_capture', 'canvas_extract']) expect(items.some((i: any) => i.type === 'mcpToolCall' && i.server === 'galta' && i.tool === tool)).toBe(true)
  expect(items.filter((i: any) => i.type === 'agentMessage').map((i: any) => i.text).join('\n')).toContain(code)
  expect(items.filter((i: any) => i.type === 'agentMessage').map((i: any) => i.text).join('\n')).toContain(canvasCode)
  const remote = await panel.evaluate(async threadId => {
    const response = await chrome.runtime.sendMessage({ type: 'codex-rpc', ownerId: 'verification', requestId: 'read', method: 'thread/read', params: { threadId, includeTurns: true } })
    if (!response.ok) throw new Error(response.error)
    return response.result.thread
  }, originalThreadId)
  expect(remote.turns[0]).toEqual(before.turns[0])
  const calls = remote.turns[1].items.filter((item: any) => item.type === 'mcpToolCall' && item.server === 'galta')
  const callReceipts = calls.map((item: any) => ({ tool: item.tool, status: item.status === 'completed' && !item.error ? 'completed' : 'failed', ...(item.error ? { error: String(item.error.message ?? item.error) } : {}) }))
  const sourceCallReceipts = callReceipts.filter((item: any) => item.tool.startsWith('browser_'))
  const canvasCallReceipts = callReceipts.filter((item: any) => item.tool.startsWith('canvas_'))
  scenarioReceipts[0] = { id: 'source-page-reference-task', success: (await source.locator('#result').innerText()) === code && sourceCallReceipts.length > 0 && sourceCallReceipts.every((item: any) => item.status === 'completed'), toolCalls: sourceCallReceipts }
  const exported = calls.find((call: any) => call.tool === 'canvas_extract')
  const exportedPath = JSON.parse(exported.result.content.find((item: any) => item.type === 'text').text).path
  const exportedBytesMatch = (await readFile(exportedPath)).equals(await readFile(canvasImage))
  expect(exportedBytesMatch).toBe(true)
  scenarioReceipts[1] = { id: 'canvas-media-task', success: canvasCallReceipts.length > 0 && canvasCallReceipts.every((item: any) => item.status === 'completed'), toolCalls: canvasCallReceipts }
  const scenarios = [
    { id: 'source-page-reference-task', success: (await source.locator('#result').innerText()) === code && sourceCallReceipts.length > 0 && sourceCallReceipts.every((item: any) => item.status === 'completed'), toolCalls: sourceCallReceipts },
    { id: 'canvas-media-task', success: exportedBytesMatch && canvasCallReceipts.length > 0 && canvasCallReceipts.every((item: any) => item.status === 'completed'), toolCalls: canvasCallReceipts }
  ]
  scenarioReceipts = scenarios
  expect(calls.every((call: any) => call.status === 'completed' && !call.error)).toBe(true)
  await expect(panel.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  await source.screenshot({ path: join(evidence, 'verified-source.png') })
  runStatus = 'completed'
  const receipt = { schema: 'galta-agent-run-v1' as const, runStatus, passed: true, runId: crypto.randomUUID(), verifiedAt: new Date().toISOString(), first: { threadId: first.threadId, turnId: first.lastTurnId }, second: { threadId: second.threadId, turnId: second.lastTurnId }, model, realModel: true, isolated: true, noUserCanvasMutation: true, noUserWorkspaceAccess: true, threadId: second.threadId, continuedThread: true, realNativeMessaging: true, productionExtension: true, originalHistoryPreserved: true, dynamicCalls: 0, canvasRasterCode: canvasCode, rasterOnlyCode: code, formResult: await source.locator('#result').innerText(), exportedBytesMatch: true, tools: calls.map((i: any) => ({ server: i.server, tool: i.tool, status: i.status })), scenarios, evidenceDirectory: evidence, isolation: { chromeProfile: profile, codexHome: isolated.home, workspaceDirectory: workspaces }, backgroundSha256: createHash('sha256').update(await readFile(join(extension, 'background.js'))).digest('hex'), boundaries: { isolatedChromeProfile: true, isolatedCodexHome: true, isolatedWorkspace: true, noUserCanvasMutation: true, noUserWorkspaceAccess: true, realModel: true, realNativeHost: true, productionExtension: true, persistentCodexThread: true, originalHistoryPreserved: true, mcpOnly: true, exportedBytesMatch: true, sourceTaskCompleted: scenarios[0]!.success, canvasTaskCompleted: scenarios[1]!.success } }
  const attested = await writeAgentRunReceipt(evidence, receipt)
  console.log(JSON.stringify(attested))
} catch (error) {
  const items = lastRunSession?.turns?.at(-1)?.items ?? []
  const calls = items.filter((item: any) => item.type === 'mcpToolCall' && item.server === 'galta')
  const callReceipts = calls.map((item: any) => ({ tool: item.tool, status: item.status === 'completed' && !item.error ? 'completed' : item.status === 'cancelled' ? 'cancelled' : 'failed', ...(item.error ? { error: String(item.error.message ?? item.error) } : {}) }))
  const sourceCallReceipts = callReceipts.filter((item: any) => item.tool.startsWith('browser_'))
  const canvasCallReceipts = callReceipts.filter((item: any) => item.tool.startsWith('canvas_'))
  const observed = new Map([
    ['source-page-reference-task', sourceCallReceipts],
    ['canvas-media-task', canvasCallReceipts]
  ])
  const scenarios = scenarioReceipts.map(scenario => scenario.success
    ? scenario
    : { ...scenario, toolCalls: observed.get(scenario.id) ?? scenario.toolCalls, note: 'Live task did not complete.' })
  runStatus = /timeout/i.test(String(error)) ? 'timed_out' : 'failed'
  const receipt = { schema: 'galta-agent-run-v1' as const, runStatus, passed: false, runId: crypto.randomUUID(), verifiedAt: new Date().toISOString(), model: modelId, realModel: modelAvailable, isolated: true, noUserCanvasMutation: true, noUserWorkspaceAccess: true, scenarios, evidenceDirectory: evidence, isolation: { chromeProfile: profile, codexHome: isolated.home, workspaceDirectory: workspaces }, error: String(error), boundaries: { isolatedChromeProfile: true, isolatedCodexHome: true, isolatedWorkspace: true, noUserCanvasMutation: true, noUserWorkspaceAccess: true, realModel: modelAvailable, sourceTaskCompleted: scenarios[0].success, canvasTaskCompleted: scenarios[1].success } }
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ verifiedAt: receipt.verifiedAt, error: String(error), lastRunSession, receipt }, null, 2) + '\n')
  await writeAgentRunReceipt(evidence, receipt)
  throw error
} finally {
  clearTimeout(deadline); console.log(`Evidence: ${evidence}`)
  server.stop(); await browser.close(); await isolated.close()
}
