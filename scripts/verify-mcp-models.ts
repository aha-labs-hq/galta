import { chromium, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { nativeBrowser } from './lib/native-browser'

const root = resolve(import.meta.dir, '..'), release = join(root, 'apps/extension/release')
const evidence = await mkdtemp(join(tmpdir(), 'galta-models-')), directory = join(evidence, 'bridges'), cwd = join(evidence, 'agent')
await mkdir(directory, { mode: 0o700 }); await mkdir(cwd)
const environment = { GALTA_BRIDGE_DIRECTORY: directory, GALTA_WORKSPACE_DIRECTORY: join(evidence, 'workspaces') }
const transport = await nativeBrowser(root, environment)
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = resolve(release, '.' + decodeURIComponent(new URL(request.url).pathname))
  if (!path.startsWith(release + sep)) return new Response('Not found', { status: 404 })
  const file = Bun.file(path)
  return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 })
} })
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const receipts: any[] = [], children: ReturnType<typeof Bun.spawn>[] = []
console.log(`Evidence: ${evidence}`)
try {
  for (const agent of (process.env.GALTA_TEST_AGENT ? [process.env.GALTA_TEST_AGENT] : ['codex', 'claude'])) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } }), page = await context.newPage()
    await transport.attach(page)
    page.on('pageerror', error => transport.errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.port}/sidepanel/index.html`)
    await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
    await expect.poll(async () => (await readdir(directory)).length).toBeGreaterThan(0)
    const secret = crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()
    const image = await page.evaluate(secret => {
      const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 600
      const c = canvas.getContext('2d')!
      c.fillStyle = '#f6f2e8'; c.fillRect(0, 0, 1000, 600)
      c.fillStyle = '#172e44'; c.font = 'bold 64px sans-serif'; c.fillText(secret, 90, 110)
      c.fillStyle = '#1b5fd1'; c.beginPath(); c.arc(230, 320, 95, 0, Math.PI * 2); c.fill()
      c.fillStyle = '#e58129'; c.beginPath(); c.moveTo(590, 225); c.lineTo(485, 415); c.lineTo(695, 415); c.closePath(); c.fill()
      c.fillStyle = '#247f4b'; c.fillRect(775, 255, 155, 140)
      return canvas.toDataURL('image/png').split(',')[1]!
    }, secret)
    const bytes = Buffer.from(image, 'base64')
    await page.locator('nav input[type=file]').setInputFiles({ name: 'visual-evidence.png', mimeType: 'image/png', buffer: bytes })
    await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
    const prompt = '在 Galta 当前打开的画布上，把照片中的编号和三个图形的颜色、形状、左右顺序整理成照片下方一张清晰的中文说明卡。保留原图，完成后简短告诉我结果。'
    const mcp = join(root, 'native/mcp/galta-mcp')
    const config = { mcpServers: { galta: { command: mcp, args: [], env: { GALTA_BRIDGE_DIRECTORY: directory } } } }
    const configPath = join(cwd, 'mcp.json'); await writeFile(configPath, JSON.stringify(config))
    let command: string[]
    if (agent === 'codex') {
      // Keep the existing provider, but exclude unrelated tools and plugins.
      // This reads only the named provider table, never logs its credentials.
      const settings = Bun.TOML.parse(await readFile(join(process.env.HOME!, '.codex/config.toml'), 'utf8')) as any
      const provider = settings.model_provider, providerConfig = settings.model_providers?.[provider]
      const overrides = [`mcp_servers.galta.command=${JSON.stringify(mcp)}`, `mcp_servers.galta.env.GALTA_BRIDGE_DIRECTORY=${JSON.stringify(directory)}`, 'mcp_servers.galta.default_tools_approval_mode="approve"', 'approval_policy="never"', 'model_reasoning_effort="low"', `skills.config=[{path=${JSON.stringify(join(process.env.HOME!, '.agents/skills/canvas-cowork/SKILL.md'))},enabled=false}]`]
      if (provider && providerConfig) {
        overrides.push(`model_provider=${JSON.stringify(provider)}`)
        for (const [key, value] of Object.entries(providerConfig)) if (['string', 'boolean', 'number'].includes(typeof value)) overrides.push(`model_providers.${provider}.${key}=${JSON.stringify(value)}`)
      }
      command = ['codex', 'exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '-m', settings.model ?? 'gpt-5.6-sol', '-s', 'danger-full-access', ...overrides.flatMap(value => ['-c', value]), '--json', prompt]
    } else command = ['claude', '-p', prompt, '--strict-mcp-config', '--mcp-config', configPath, '--allowedTools', 'mcp__galta__*', '--tools', '', '--output-format', 'stream-json', '--verbose', '--effort', 'low', '--max-budget-usd', '3']
    const started = Date.now(), child = Bun.spawn(command, { cwd, env: { ...process.env, ...environment }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    children.push(child)
    const deadline = setTimeout(() => child.kill(), 180_000)
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    clearTimeout(deadline)
    await writeFile(join(evidence, `${agent}.jsonl`), stdout); await writeFile(join(evidence, `${agent}.stderr`), stderr)
    const saved = await page.evaluate(() => new Promise<any>((resolve, reject) => {
      const r = indexedDB.open('galta-v1')
      r.onerror = () => reject(r.error)
      r.onsuccess = () => { const db = r.result, q = db.transaction('workspaces').objectStore('workspaces').get('default-project'); q.onsuccess = () => { db.close(); resolve(q.result) } }
    }))
    const elements = saved.snapshots[saved.project.headCommitId].document.elements
    const text = elements.filter((element: any) => element.type === 'text').map((element: any) => element.originalText ?? element.text).join('\n')
    const pass = code === 0 && text.includes(secret) && /蓝/.test(text) && /橙/.test(text) && /绿/.test(text) && /圆/.test(text) && /三角/.test(text) && /(方|矩)/.test(text) && elements.filter((element: any) => element.type === 'image').length === 1
    const receipt = { agent, code, elapsedMs: Date.now() - started, imageSha256: createHash('sha256').update(bytes).digest('hex'), secret, canvasText: text, passed: pass, imageToolUsed: stdout.includes('canvas_capture'), dynamicToolOverride: false }
    receipts.push(receipt)
    await page.screenshot({ path: join(evidence, `${agent}.png`) })
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ receipts, errors: transport.errors }, null, 2))
    console.log(JSON.stringify(receipt, null, 2))
    await context.close()
    if (!pass) throw new Error(`${agent} visual acceptance failed; inspect ${evidence}`)
  }
} finally {
  children.forEach(child => { if (child.exitCode === null) child.kill() })
  await browser.close(); await transport.close(); server.stop(true)
}
