import { chromium, expect, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connectCodex } from '../tests/helpers/canvas-port'
import { codexTestHome, copyCodexTestAssets } from './lib/codex-test-home'
import { registerCompanionFixture } from './lib/companion-fixture'
import { SCENARIOS } from './lib/craft-scenarios'

// Opt-in real-model task probe, isolated like verify-unified-mcp.ts: a
// disposable Chrome profile, Codex home and workspace; no user canvas. A
// scenario (`scripts/lib/craft-scenarios.ts`) seeds the canvas and the bound
// page through MCP, sends its prompts in one conversation and judges the
// outcome. The receipt records every model request's token use, every tool
// call, whether the agent received pictures from its own captures, and the
// canvas after each prompt, so two builds can be compared side by side.
//
//   GALTA_CRAFT_SCENARIO=craft|chat|perceive|diagram|page|webpage|edit|translate|switch
//   GALTA_CRAFT_REFERENCES=<dir with ui, girl, flower, ghost, suitcat .jpg>
//   GALTA_VERIFY_ROOT=<checkout whose release and native hosts are tested>
//   GALTA_CODEX_BIN=<codex>  GALTA_VERIFY_MODEL=gpt-6-astra  GALTA_VERIFY_EFFORT=High
//   GALTA_CRAFT_INHERIT=1 runs Codex with clones of the user's own AGENTS.md,
//   skills, rules and configuration (projects and notify removed), as the
//   embedded runtime meets them on the user's Mac; GALTA_CRAFT_PLUGINS=1 adds
//   their plugins, marketplaces and MCP servers.
const root = resolve(process.env.GALTA_VERIFY_ROOT ?? resolve(import.meta.dir, '..'))
const references = resolve(process.env.GALTA_CRAFT_REFERENCES ?? '')
const scenario = SCENARIOS[process.env.GALTA_CRAFT_SCENARIO ?? 'craft']
if (!scenario) throw new Error(`Unknown scenario ${process.env.GALTA_CRAFT_SCENARIO}`)
const defaults = { model: process.env.GALTA_VERIFY_MODEL ?? 'gpt-6-astra', effort: process.env.GALTA_VERIFY_EFFORT ?? 'High' }
const directory = await mkdtemp(join(tmpdir(), 'galta-craft-')), evidence = join(directory, 'evidence')
await mkdir(evidence)
const salt = crypto.randomUUID()
const token = (key: string) => `${key[0]!.toUpperCase()}${key.slice(1)} ${createHash('sha256').update(`${salt}/${key}`).digest('hex').slice(0, 6).toUpperCase()}`
const profile = join(directory, 'profile'), bridges = join(directory, 'bridges'), workspaces = join(directory, 'workspaces')
await mkdir(bridges, { mode: 0o700 })
const isolated = await codexTestHome()
if (process.env.GALTA_CRAFT_INHERIT === '1') {
  const user = join(homedir(), '.codex')
  // Keep what a desktop Codex install brings, except other projects' trust
  // entries and the desktop's end-of-turn command. Unless GALTA_CRAFT_PLUGINS=1,
  // the user's plugins, marketplaces and other MCP servers stay out as well:
  // started from a browser, a plugin's freshly built binary is quarantined and
  // macOS asks the user to move it to the Trash.
  const plugins = process.env.GALTA_CRAFT_PLUGINS === '1'
  const dropped = plugins ? /^\[projects\./ : /^\[(projects|plugins|marketplaces|mcp_servers)[.\]]/
  const blocks = (await readFile(join(user, 'config.toml'), 'utf8')).split(/\n(?=\[)/).filter(block => !dropped.test(block))
  const off = (block: string, key: string) => new RegExp(`^${key}\\s*=.*$`, 'm').test(block) ? block.replace(new RegExp(`^${key}\\s*=.*$`, 'm'), `${key} = false`) : `${block.trimEnd()}\n${key} = false\n`
  const features = blocks.findIndex(block => /^\[features\]\s*$/m.test(block.split('\n')[0]!))
  if (!plugins) {
    if (features >= 0) blocks[features] = off(off(blocks[features]!, 'plugins'), 'plugin_hooks')
    else blocks.push('[features]\nplugins = false\nplugin_hooks = false\n')
  }
  const config = blocks.join('\n').replace(/^notify\s*=.*$/m, '')
  await writeFile(join(isolated.home, 'config.toml'), config + (/cli_auth_credentials_store/.test(config) ? '' : '\ncli_auth_credentials_store = "file"\n'), { mode: 0o600 })
  // Independent clones, never links: a probe's Codex rewrites plugin caches and
  // system skills, and a browser-launched process quarantines what it writes.
  // Linked, both reached the user's live ~/.codex on 2026-10-27.
  await copyCodexTestAssets(user, isolated.home)
  if (!plugins) await rm(join(isolated.home, 'plugins'), { recursive: true, force: true })
}
const executablePath = process.env.GALTA_EXTENSION_CHROME_PATH ?? chromium.executablePath()
const extension = join(root, 'apps/extension/release')
const browser = await chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: { width: 1400, height: 1000 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
const deadline = setTimeout(() => { void browser.close() }, 40 * 60_000)
const pageHtml = scenario.page?.(token) ?? '<!doctype html><title>Reference board</title><h1>References</h1>'
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(pageHtml, { headers: { 'Content-Type': 'text/html' } }) })
const record: Record<string, any> = { scenario: scenario.id, root, defaults, inherit: process.env.GALTA_CRAFT_INHERIT === '1', directory, turns: [] }
const text = (result: any) => result.content.find((item: any) => item.type === 'text')?.text
// galta-mcp finds the user's generation keys under HOME's Application Support.
// Its own HOME keeps paid providers out of every probe; Codex keeps the real
// HOME so inherited skills and plugins stay as the user's Mac has them.
const mcpHome = join(directory, 'mcp-home')
await mkdir(mcpHome, { recursive: true })
async function mcp() {
  const client = new Client({ name: 'craft-probe', version: '1' })
  const env = Object.fromEntries(Object.entries({ ...process.env, HOME: mcpHome, GALTA_BRIDGE_DIRECTORY: bridges, GALTA_WORKSPACE_DIRECTORY: workspaces }).filter((entry): entry is [string, string] => entry[1] !== undefined))
  await client.connect(new StdioClientTransport({ command: join(root, 'native/mcp/galta-mcp'), env, stderr: 'inherit' }))
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result: any = await client.callTool({ name, arguments: args })
    if (result.isError) throw new Error(`${name}: ${text(result)}`)
    return result
  }
  // The open canvas registers with its bridge shortly after the page loads.
  let canvases: any[] = []
  await expect.poll(async () => { canvases = JSON.parse(text(await call('canvas_list'))); return canvases.length }, { timeout: 30_000 }).toBe(1)
  const bound = JSON.parse(text(await call('canvas_connect', { canvasId: canvases[0].id })))
  return { call, workspace: bound.workspace as string, async close() { await call('canvas_disconnect').catch(() => undefined); await client.close() } }
}
async function readCanvas(call: (name: string, args?: Record<string, unknown>) => Promise<any>) {
  let page = JSON.parse(text(await call('canvas_inspect', { detail: 'elements', limit: 64 })))
  const elements = [...page.elements], revision = page.revision
  while (page.next) { page = JSON.parse(text(await call('canvas_inspect', page.next))); elements.push(...page.elements) }
  return { elements, revision }
}
try {
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker')
  const extensionId = new URL(worker.url()).host
  const hostDirectory = join(profile, 'NativeMessagingHosts'); await mkdir(hostDirectory, { recursive: true })
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const mcpBinary = join(directory, 'galta-mcp'), mcpProgram = join(directory, 'galta-mcp-program')
  await copyFile(join(root, 'native/mcp/galta-mcp'), mcpProgram); await chmod(mcpProgram, 0o700)
  await writeFile(mcpBinary, `#!/bin/sh\nexport HOME=${quote(mcpHome)}\nexec ${quote(mcpProgram)} "$@"\n`); await chmod(mcpBinary, 0o700)
  for (const [kind, binary] of [['canvas', 'native/bridge/galta-canvas-bridge'], ['codex', 'native/adapters/codex/galta-codex-bridge']] as const) {
    const wrapper = join(directory, `${kind}.sh`), installed = join(directory, `galta-${kind}-bridge`)
    await copyFile(join(root, binary), installed); await chmod(installed, 0o700)
    await writeFile(wrapper, `#!/bin/sh\nexport CODEX_HOME=${quote(isolated.home)}\nexport CODEX_INTERNAL_ORIGINATOR_OVERRIDE=galta\nexport GALTA_BRIDGE_DIRECTORY=${quote(bridges)}\nexport GALTA_WORKSPACE_DIRECTORY=${quote(workspaces)}\nexport GALTA_MCP_BIN=${quote(mcpBinary)}\nexport GALTA_CODEX_BIN=${quote(process.env.GALTA_CODEX_BIN ?? join(homedir(), '.local/bin/codex'))}\nexec ${quote(installed)} "$@" 2>${quote(join(directory, kind + '.log'))}\n`)
    await chmod(wrapper, 0o700)
    await writeFile(join(hostDirectory, `com.galta.${kind}.json`), JSON.stringify({ name: `com.galta.${kind}`, description: 'Isolated craft probe', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }))
  }
  await registerCompanionFixture(directory, hostDirectory, extensionId)
  const source = await browser.newPage(); await source.goto(`http://127.0.0.1:${server.port}/`)
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0]!.id!, source.url())
  const panel: Page = await browser.newPage()
  await panel.goto(`chrome-extension://${extensionId}/canvas/index.html#returnTab=${tabId}`)
  await expect(panel.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()

  if (scenario.seed) {
    const seed = await mcp()
    try { await scenario.seed({ call: seed.call, text, workspace: seed.workspace, references, token }); record.seededRevision = (await readCanvas(seed.call)).revision }
    finally { await seed.close() }
    await expect(panel.getByRole('region', { name: /^Galta canvas, [1-9]\d* objects?$/ })).toBeVisible()
    await panel.locator('.excalidraw').click({ position: { x: 5, y: 5 } }).catch(() => undefined)
    await panel.keyboard.press('Shift+1')
  }

  try { await connectCodex(panel) }
  catch (error) { console.error({ directory, nativeError: await readFile(join(directory, 'codex.log'), 'utf8').catch(() => '') }); throw error }
  const connection = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'codex-connect' }))
  let current = { model: '', effort: '' }
  async function choose(model: string, effort: string) {
    if (current.model !== model) {
      const selected = connection.models?.find((item: any) => item.id === model)
      if (!selected) throw new Error(`Model ${model} is unavailable`)
      await panel.getByRole('button', { name: /^Model / }).click()
      await panel.getByRole('radiogroup', { name: 'Model', exact: true }).getByText(selected.displayName ?? selected.id, { exact: true }).click()
    }
    // A model change can reset effort to the model's default, so set it each time.
    await panel.getByRole('button', { name: /^Effort / }).click()
    await panel.getByRole('menuitemradio', { name: effort, exact: true }).click()
    await panel.keyboard.press('Escape')
    current = { model, effort }
  }
  const latest = () => panel.evaluate(() => new Promise<any>((resolve, reject) => {
    const request = indexedDB.open('galta-v1')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result, read = db.transaction('workspaces').objectStore('workspaces').get('default-project')
      read.onsuccess = () => { const w = read.result; db.close(); resolve(w?.agentSessions?.find((s: any) => s.id === w.runtimeDefaults?.sessionId)) }
      read.onerror = () => { db.close(); reject(read.error) }
    }
  }))
  let count = 0
  async function send(instruction: string) {
    await panel.getByRole('textbox', { name: 'Ask Galta' }).fill(instruction)
    await panel.getByRole('button', { name: 'Send message', exact: true }).click()
    count++
    await expect.poll(async () => { const session = await latest().catch(() => null); return session?.turns.length === count && !!session.turns.at(-1)?.completedAt }, { timeout: 15 * 60_000, intervals: [2000] }).toBe(true)
    const turn = (await latest()).turns.at(-1)
    record.turns.push({ instruction, status: turn.status, error: turn.error ?? null, items: turn.items.map((item: any) => ({ type: item.type, tool: item.tool, phase: item.phase, text: String(item.text ?? '').slice(0, 600), status: item.status })) })
    console.log(JSON.stringify(record.turns.at(-1)).slice(0, 1500))
    return turn
  }
  for (const prompt of scenario.prompts) {
    await choose(prompt.model ?? defaults.model, prompt.effort ?? defaults.effort)
    let turn = await send(prompt.text)
    // Provider capacity failures are retried as the user did: "继续", twice at most.
    for (let retry = 0; retry < 2 && turn.status !== 'completed'; retry++) turn = await send('继续')
    const look = await mcp()
    try {
      const view = await look.call('canvas_capture', { scope: 'canvas', detail: 'high' }).catch(() => undefined)
      const image = view?.content.find((part: any) => part.type === 'image')
      if (image) await writeFile(join(evidence, `after-${record.turns.length}.jpg`), Buffer.from(image.data, 'base64'))
      const canvas = await readCanvas(look.call)
      await writeFile(join(evidence, `after-${record.turns.length}.json`), JSON.stringify(canvas, null, 2))
      record.final = canvas
    } finally { await look.close() }
  }
  const items = record.turns.flatMap((turn: any) => turn.items)
  const outcome = await scenario.check({
    elements: record.final.elements, revision: record.final.revision, seededRevision: record.seededRevision,
    answers: items.filter((item: any) => item.type === 'agentMessage' && item.phase !== 'commentary').map((item: any) => item.text),
    tools: items.filter((item: any) => item.tool).map((item: any) => item.tool), pageText: pageHtml, token
  })
  record.pass = outcome.pass; record.notes = outcome.notes
  console.log(JSON.stringify({ scenario: scenario.id, pass: outcome.pass, notes: outcome.notes }))
  delete record.final

  // What the model actually received and spent, from Codex's own rollout.
  const rollouts: string[] = []
  const walk = async (path: string): Promise<void> => { for (const entry of await readdir(path, { withFileTypes: true })) entry.isDirectory() ? await walk(join(path, entry.name)) : entry.name.endsWith('.jsonl') && rollouts.push(join(path, entry.name)) }
  await walk(join(isolated.home, 'sessions'))
  record.rollouts = []
  for (const [index, path] of rollouts.entries()) {
    await copyFile(path, join(evidence, `rollout-${index + 1}.jsonl`))
    const rows = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    const meta = rows.find(row => row.type === 'session_meta')?.payload
    const requests = rows.filter(row => row.type === 'token_usage_record').map(row => row.payload.usage)
    const calls = rows.filter(row => row.type === 'response_item' && ['custom_tool_call', 'function_call'].includes(row.payload.type)).map(row => ({ name: row.payload.name, input: String(row.payload.input ?? row.payload.arguments ?? '').slice(0, 400) }))
    const outputs = rows.filter(row => row.type === 'response_item' && ['custom_tool_call_output', 'function_call_output'].includes(row.payload.type))
    const imagesSeen = outputs.reduce((sum, row) => sum + (Array.isArray(row.payload.output) ? row.payload.output.filter((part: any) => part.type === 'input_image').length : 0), 0)
    const developer = rows.filter(row => row.type === 'response_item' && row.payload.type === 'message' && row.payload.role === 'developer').map(row => row.payload.content.map((part: any) => part.text ?? '').join(''))
    record.rollouts.push({
      path, originator: meta?.originator, instructionsChars: meta?.base_instructions?.text?.length ?? null,
      developerMessages: developer.map(message => ({ tag: /^<([a-z_]+)/.exec(message)?.[1] ?? message.slice(0, 24), chars: message.length })),
      requests, totals: requests.reduce((sum: any, usage: any) => ({ input: sum.input + usage.input_tokens, cached: sum.cached + usage.cached_input_tokens, output: sum.output + usage.output_tokens, reasoning: sum.reasoning + usage.reasoning_output_tokens }), { input: 0, cached: 0, output: 0, reasoning: 0 }),
      calls, imagesSeenFromTools: imagesSeen
    })
  }
  await panel.screenshot({ path: join(evidence, 'panel.png') })
  record.status = 'completed'
} catch (error) {
  record.status = 'failed'; record.error = String(error)
  throw error
} finally {
  delete record.final
  await writeFile(join(evidence, 'craft.json'), JSON.stringify(record, null, 2) + '\n')
  clearTimeout(deadline); console.log(`Evidence: ${evidence}`)
  server.stop(); await browser.close(); await isolated.close()
  // Keep only the evidence: a profile, workspace and Codex home run to
  // hundreds of megabytes each, and repeated probes filled the disk once.
  for (const path of [profile, bridges, workspaces, mcpHome, isolated.directory]) await rm(path, { recursive: true, force: true })
  for (const name of await readdir(directory)) if (name !== 'evidence') await rm(join(directory, name), { recursive: true, force: true })
}
