import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test'
import { nativeBrowser } from './lib/native-browser'
import { createCanvasIntentHoldout } from './lib/canvas-intent-holdout'
import { writeAgentRunReceipt, type AgentRunStatus, type ScenarioReceipt } from './lib/agent-evaluation'
import { verifyArtifactDownload, verifyArtifactPicker } from './lib/canvas-intent-download'
import { judgeCanvasAnswers } from './lib/canvas-intent-judge'
import { submittedCanvasEvidence } from './lib/canvas-intent-evidence'
import { isSupportedAnswer, type AnswerCase } from './lib/canvas-intent-assessment'
import { connectCodex } from '../tests/helpers/canvas-port'
import { storedWorkspace } from '../tests/helpers/stored-workspace'
import { conversationItem } from '../packages/runtime/src/codex'

// Opt-in real-model acceptance against a built checkout. All artwork, browser
// storage and workspaces are disposable; installation is a separate boundary.
const harnessRoot = resolve(import.meta.dir, '..')
const root = resolve(process.env.GALTA_VERIFY_ROOT ?? harnessRoot), release = join(root, 'apps/extension/release')
const directory = await mkdtemp(join(tmpdir(), 'galta-intent-')), evidence = join(directory, 'evidence')
await mkdir(evidence)
const profile = join(directory, 'profile'), workspaceDirectory = join(directory, 'workspaces')
const model = process.env.GALTA_VERIFY_MODEL ?? 'gpt-6-astra'
const holdout = createCanvasIntentHoldout(process.env.GALTA_VERIFY_SEED)
const viewport = { width: 1200, height: 900 }
const executablePath = process.env.GALTA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const codexExecutable = process.env.GALTA_CODEX_BIN ?? Bun.which('codex')
if (!codexExecutable) throw new Error('Codex executable is required')
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const json = (file: string, value: unknown) => writeFile(join(evidence, file), JSON.stringify(value, null, 2) + '\n')
const ids = ['empty-canvas-observation', 'unselected-drawing', 'ordinary-file-delivery', 'unsupported-source-request', 'selected-but-independent-file', 'selected-image-with-holdout-output', 'explicit-other-image', 'selection-changed-after-submission', 'multiple-selection-comparison']
const fixture = (id: string) => sha(JSON.stringify({ id, holdout, viewport }))
const scenarios: ScenarioReceipt[] = [], answers: AnswerCase[] = [], transportEvents: unknown[] = []
const imageFacts = new Map<string, { text: string; backgroundColor: string }>()
let native: Awaited<ReturnType<typeof nativeBrowser>> | undefined, server: ReturnType<typeof Bun.serve> | undefined
let browser: BrowserContext | undefined, page: Page, lastTurn: any
let modelAvailable = false, runStatus: AgentRunStatus = 'failed', turns = 0
let trial: { suite: string; harness: string; conditions: string } | undefined
const documentOf = (bundle: any) => bundle.snapshots[bundle.project.headCommitId].document
const readyArtifacts = (turn: any) => (turn?.items ?? []).flatMap((item: any) => item.type === 'agentMessage' ? item.artifacts ?? [] : []).filter((artifact: any) => artifact.status === 'ready')
const observedToolCalls = (turn: any) => (turn?.items ?? []).filter((item: any) => item.type === 'mcpToolCall').map((raw: any) => {
  const item = conversationItem(raw, 'unknown')!
  return {
    tool: item.tool ?? 'unknown', status: item.status === 'completed' && !item.error ? 'completed' : item.status === 'cancelled' ? 'cancelled' : 'failed',
    ...(item.error ? { error: item.error } : {})
  }
})

async function fingerprints(directory: string, paths: string[]) {
  const files: Record<string, string> = {}
  const visit = async (path: string) => {
    if ((await Bun.file(join(directory, path)).stat()).isDirectory()) {
      for (const name of (await readdir(join(directory, path))).sort()) await visit(join(path, name))
    } else files[path] = sha(await readFile(join(directory, path)))
  }
  for (const path of paths) await visit(path)
  return files
}

async function reconnectIfNeeded() {
  const action = page.locator('.conversation-dock').getByRole('button', { name: /^(Connect an agent|Reconnect agent)$/ })
  if (await action.isVisible()) await connectCodex(page)
}

async function writeReceipt(error?: unknown) {
  for (const id of ids) if (!scenarios.some(item => item.id === id)) scenarios.push({ id, fixture: fixture(id), success: false, toolCalls: [], note: 'Scenario did not execute.' })
  const receipt = await writeAgentRunReceipt(evidence, {
    schema: 'galta-agent-run-v1', runStatus, runId: randomUUID(), verifiedAt: new Date().toISOString(), model,
    realModel: modelAvailable, isolated: true, noUserCanvasMutation: true, noUserWorkspaceAccess: true,
    holdout, scenarios, ...(trial ? { trial } : {}), ...(error ? { error: String(error) } : {}), evidenceDirectory: evidence,
    isolation: { chromeProfile: profile, codexHome: native?.codexHome ?? join(directory, 'not-started'), workspaceDirectory },
    boundaries: { isolatedChromeProfile: Boolean(browser), isolatedCodexHome: Boolean(native), isolatedWorkspace: true,
      browserDownload: scenarios.some(item => item.saved !== undefined), pickerContract: scenarios.some(item => item.picker !== undefined), nativePicker: false, installedExtension: false,
      semanticAssessment: answers.length > 0 && answers.every(answer => scenarios.find(item => item.id === answer.id)?.semantic !== undefined),
      savedBytesVerified: scenarios.some(item => item.id === 'selected-image-with-holdout-output' && item.success),
      persistedReceiptReplayed: scenarios.some(item => item.persistedReceiptReplayed === true) }
  })
  console.log(JSON.stringify({ evidence, runStatus, passed: scenarios.filter(item => item.success).length, total: ids.length, receipt: receipt.evidence }))
}

type Check = (turn: any) => Promise<Record<string, unknown> | void>
async function run(id: string, instruction: string, check: Check, facts?: string[], afterSubmit?: () => Promise<void>) {
  const before = documentOf(await storedWorkspace(page)), startedAt = Date.now()
  const scenario: ScenarioReceipt = { id, fixture: fixture(id), success: false, toolCalls: [] }
  scenarios.push(scenario)
  lastTurn = undefined
  let remoteTurn: any
  let unchanged = false
  try {
    turns++
    await page.getByRole('textbox', { name: 'Ask Galta' }).fill(instruction)
    await page.getByRole('button', { name: 'Run command', exact: true }).click()
    await expect.poll(async () => {
      const bundle: any = await storedWorkspace(page), all = bundle.agentSessions?.flatMap((session: any) => session.turns) ?? []
      if (all.length === turns) lastTurn = all.at(-1)
      return Boolean(lastTurn)
    }, { timeout: 15_000 }).toBe(true)
    await afterSubmit?.()
    const activeTurnId = lastTurn.id
    await expect.poll(async () => {
      const bundle: any = await storedWorkspace(page)
      lastTurn = bundle.agentSessions?.flatMap((session: any) => session.turns).find((turn: any) => turn.id === activeTurnId)
      return Boolean(lastTurn?.completedAt)
    }, { timeout: 180_000, intervals: [1000] }).toBe(true)
    const remote = await page.evaluate(async threadId => {
      const response = await chrome.runtime.sendMessage({ type: 'codex-rpc', ownerId: 'intent-verification', requestId: crypto.randomUUID(), method: 'thread/read', params: { threadId, includeTurns: true } })
      if (!response.ok) throw new Error(response.error)
      return response.result.thread
    }, lastTurn.threadId)
    remoteTurn = remote.turns.find((turn: any) => turn.id === lastTurn.turnId)
    assert(remoteTurn, 'The completed turn is missing from the authoritative runtime history')
    assert.deepEqual(documentOf(await storedWorkspace(page)), before, 'A read-only request changed the canvas')
    unchanged = true
    assert.equal(lastTurn.status, 'completed', 'The agent turn did not complete')
    const details = await check(lastTurn)
    const reply = lastTurn.items.filter((item: any) => item.type === 'agentMessage' && item.phase === 'final_answer').map((item: any) => item.text).join('\n')
    Object.assign(scenario, details, { reply, unchanged, success: !facts })
    if (facts) {
      const submitted = submittedCanvasEvidence(remoteTurn, remote.turns.slice(0, remote.turns.indexOf(remoteTurn)))
      let previewPath: string | undefined
      if (submitted.preview) {
        previewPath = join(evidence, `${id}-submitted.jpg`)
        await writeFile(previewPath, submitted.preview)
      }
      const bounds = new Map(submitted.context.visible.items.map(item => [item.id, item.bounds]))
      answers.push({ id, request: instruction, facts, answer: reply, observation: submitted.context, ...(previewPath ? { previewPath } : {}), canvas: {
        selectedIds: [...lastTurn.context.selection],
        elements: before.elements.map((element: any) => ({
          id: element.id, type: element.type,
          ...(bounds.has(element.id) ? { bounds: bounds.get(element.id) } : {}),
          ...(['rectangle', 'diamond'].includes(element.type) ? { roundedCorners: element.roundness !== null && element.roundness !== undefined } : {}),
          ...(typeof element.text === 'string' ? { text: element.text } : {}),
          ...(imageFacts.has(element.id) ? { image: imageFacts.get(element.id)! } : {})
        }))
      } })
    }
  } catch (error) {
    scenario.note = String(error)
    // A finished factual failure can be scored without erasing other evidence.
    // Interrupted turns or changed documents invalidate subsequent fixtures.
    if (!lastTurn?.completedAt || !unchanged) throw error
  } finally {
    scenario.toolCalls = observedToolCalls(remoteTurn ?? lastTurn)
    scenario.durationMs = Date.now() - startedAt
    await json(`${id}.json`, { request: instruction, before, after: documentOf(await storedWorkspace(page)), turn: lastTurn, remoteTurn, scenario })
    console.log(JSON.stringify({ id, success: scenario.success, semanticPending: Boolean(facts && answers.some(item => item.id === id)), note: scenario.note }))
    const collapse = page.getByRole('button', { name: 'Collapse conversation', exact: true })
    if (await collapse.isVisible()) await collapse.click()
    await expect(page.locator('.conversation-presence')).not.toBeVisible()
  }
}

async function deliver(turn: any, bytes: Buffer, options: { replay?: boolean; workingCopy?: boolean; name?: string } = {}) {
  const bundle: any = await storedWorkspace(page), cwd = bundle.codexProject.cwd, artifacts = readyArtifacts(turn)
  assert(artifacts.length > 0, 'No ready download was delivered')
  assert(artifacts.every((item: any) => item.receipt?.sha256 === sha(bytes)), 'The answer includes a substitute download')
  const receipt = artifacts[0].receipt
  if (options.name) assert.equal(receipt.name, options.name, 'The download must retain the requested destination filename')
  assert.equal(receipt.projectId, bundle.project.id, 'Delivery belongs to another workspace')
  if (options.workingCopy) assert((await readFile(join(cwd, receipt.name))).equals(bytes), 'The requested copy is missing from the current working directory')
  assert((await readFile(join(dirname(cwd), '.deliveries', basename(cwd), receipt.receiptId, 'file'))).equals(bytes), 'Frozen delivery differs from the requested source')
  const download = async (suffix: string) => {
    await reconnectIfNeeded()
    const open = page.getByRole('button', { name: 'Open conversation', exact: true })
    if (await open.isVisible()) await open.click()
    const control = page.locator(`[data-turn-id="${turn.id}"] button[data-artifact-uri="${receipt.uri}"]`).first()
    await expect(control).toBeVisible()
    await expect(control).toBeEnabled()
    return verifyArtifactDownload(page, control, bytes, join(evidence, `${scenarios.at(-1)!.id}-${suffix}`))
  }
  const saved = await download('download')
  let picker: Awaited<ReturnType<typeof verifyArtifactPicker>> | undefined
  if (options.replay) {
    picker = await verifyArtifactPicker(page, page.locator(`[data-turn-id="${turn.id}"] button[data-artifact-uri="${receipt.uri}"]`).first(), bytes)
    await page.reload()
    await expect(page.getByRole('region', { name: `Galta canvas, ${documentOf(bundle).elements.length} objects`, exact: true })).toBeVisible()
    await download('replayed-download')
  }
  return { delivery: receipt, saved, ...(picker ? { picker } : {}), exactDeliveryBytes: true, persistedReceiptReplayed: options.replay === true }
}

try {
  await json('holdout.json', holdout)
  const harnessFiles = await fingerprints(harnessRoot, ['scripts/verify-canvas-intent.ts', 'scripts/lib/agent-evaluation.ts', 'scripts/lib/canvas-intent-holdout.ts', 'scripts/lib/canvas-intent-assessment.ts', 'scripts/lib/canvas-intent-evidence.ts', 'scripts/lib/canvas-intent-judge.ts', 'scripts/lib/canvas-intent-download.ts', 'scripts/lib/native-browser.ts', 'scripts/lib/codex-test-home.ts', 'packages/runtime/src/codex.ts', 'tests/helpers/stored-workspace.ts', 'tests/helpers/storage-entry.ts', 'tests/helpers/canvas-port.ts'])
  const productPaths = ['apps/extension/release', 'native/bridge/galta-canvas-bridge', 'native/adapters/codex/galta-codex-bridge', 'native/mcp/galta-mcp', 'apps/extension/src/background/canvasBridge.ts', 'apps/extension/src/background/codexAdapter.ts']
  const builds = await fingerprints(root, productPaths)
  const conditions = { viewport, headless: true, reasoning: 'low', download: 'browser', sharedThread: true,
    browser: execFileSync(executablePath, ['--version'], { encoding: 'utf8' }).trim(),
    codex: execFileSync(codexExecutable, ['--version'], { encoding: 'utf8' }).trim() }
  trial = { suite: 'canvas-intent-v4', harness: sha(JSON.stringify(harnessFiles)), conditions: sha(JSON.stringify(conditions)) }
  await json('build.json', { root, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), builds, harnessFiles, conditions })
  native = await nativeBrowser(root, { GALTA_WORKSPACE_DIRECTORY: workspaceDirectory, GALTA_CODEX_BIN: codexExecutable }, (message: any) => {
    if (message.type.startsWith('port-') && message.type !== 'port-post' || message.type === 'codex-connect') transportEvents.push({ type: message.type, name: message.name })
  })
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = resolve(release, '.' + decodeURIComponent(new URL(request.url).pathname))
    if (!path.startsWith(release + sep)) return new Response('Not found', { status: 404 })
    const file = Bun.file(path)
    return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 })
  } })
  browser = await chromium.launchPersistentContext(profile, { executablePath, viewport, headless: true, acceptDownloads: true })
  // This suite verifies the real browser download boundary. The OS picker is
  // covered separately; a missing download event always fails this suite.
  await browser.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }))
  page = browser.pages()[0] ?? await browser.newPage()
  await native.attach(page)
  await page.goto(`http://127.0.0.1:${server.port}/canvas/index.html`)
  await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  await connectCodex(page)
  const connection = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'codex-connect' }))
  if (!connection.ok || connection.requiresAuth) throw new Error(connection.error ?? 'The isolated session requires authentication')
  const selected = connection.models?.find((item: any) => item.id === model)
  if (!selected) throw new Error(`Model ${model} is unavailable`)
  modelAvailable = true
  await page.getByRole('button', { name: /^Model / }).click()
  await page.getByRole('radiogroup', { name: 'Model', exact: true }).getByText(selected.displayName ?? selected.id, { exact: true }).click()
  await page.getByRole('button', { name: /^Effort / }).click()
  await page.getByRole('menuitemradio', { name: 'Low', exact: true }).click()
  await page.keyboard.press('Escape')

  await run(ids[0]!, holdout.prompts.empty, async turn => { assert.equal(turn.context.selection.length, 0) }, ['The canvas has no objects.'])
  await page.getByRole('button', { name: 'Draw — P', exact: true }).click()
  await page.mouse.move(200, 180); await page.mouse.down(); await page.mouse.move(260, 300, { steps: 10 }); await page.mouse.move(320, 180, { steps: 10 }); await page.mouse.up()
  await page.mouse.move(450, 240); await page.mouse.down(); await page.mouse.move(600, 240, { steps: 16 }); await page.mouse.up()
  await expect.poll(async () => documentOf(await storedWorkspace(page)).elements.length).toBe(2)
  await run(ids[1]!, holdout.prompts.describe, async turn => { assert.equal(turn.context.selection.length, 0); assert.equal(turn.context.canvas.preview, 'attached') }, ['The submitted viewport contains two native freehand strokes. Use the submitted pixels for their appearance; native corner properties do not describe brush curvature.', 'Nothing is selected.'])
  const bundle: any = await storedWorkspace(page), cwd = bundle.codexProject.cwd
  assert(cwd.startsWith(workspaceDirectory + sep), 'The live workspace escaped its disposable directory')
  await mkdir(join(cwd, 'inbox'), { recursive: true })
  const note = Buffer.from(holdout.noteContent)
  await writeFile(join(cwd, 'inbox', holdout.noteName), note)
  await run(ids[2]!, holdout.prompts.ordinary, async turn => {
    assert((await readFile(join(cwd, holdout.copyName))).equals(note))
    return deliver(turn, note, { name: holdout.copyName })
  })

  await page.getByRole('button', { name: 'Shapes and more tools', exact: true }).click()
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click()
  await page.mouse.move(760, 120); await page.mouse.down(); await page.mouse.move(900, 220, { steps: 10 }); await page.mouse.up()
  await expect.poll(async () => documentOf(await storedWorkspace(page)).elements.length).toBe(3)
  await run(ids[3]!, holdout.prompts.unsupported, async turn => { assert.equal(turn.context.selection.length, 1); assert.equal(readyArtifacts(turn).length, 0, 'A native shape has no source file to deliver') }, ['The selected object is a native canvas rectangle with no original source file.', 'The answer must explain this without claiming a file was delivered.'])
  await run(ids[4]!, holdout.prompts.independent, async turn => {
    assert.equal(turn.context.selection.length, 1)
    assert((await readFile(join(cwd, holdout.independentName))).equals(note))
    return deliver(turn, note, { name: holdout.independentName })
  })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Select — V', exact: true }).click()

  const raster = async (color: string, text: string) => Buffer.from(await page.evaluate(({ color, text }) => {
    const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 180
    const context = canvas.getContext('2d')!; context.fillStyle = color; context.fillRect(0, 0, 300, 180)
    context.fillStyle = '#ffffff'; context.font = 'bold 22px sans-serif'; context.fillText(text, 14, 105)
    return canvas.toDataURL('image/png').split(',')[1]!
  }, { color, text }), 'base64')
  const old = await raster(holdout.oldColor, holdout.oldLabel), chosen = await raster(holdout.selectedColor, holdout.selectedLabel)
  await writeFile(join(evidence, 'other.png'), old); await writeFile(join(evidence, 'selected.png'), chosen)
  const point = async (id: string, fraction = .5) => {
    const bundle: any = await storedWorkspace(page), doc = documentOf(bundle), element = doc.elements.find((item: any) => item.id === id)
    const view = bundle.canvasView ?? bundle.snapshots[bundle.project.headCommitId].view
    return { x: (element.x + element.width * fraction + view.scrollX) * view.zoom, y: (element.y + element.height * fraction + view.scrollY) * view.zoom }
  }
  const select = async (id: string, fraction = .5) => {
    const p = await point(id, fraction)
    assert(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.excalidraw')), p), 'The selection target is occluded by the application UI')
    await page.mouse.click(p.x, p.y)
  }
  const imageIds = new Map<string, string>()
  const images = holdout.selectedFirst ? [[holdout.selectedImageName, chosen], [holdout.oldImageName, old]] as const : [[holdout.oldImageName, old], [holdout.selectedImageName, chosen]] as const
  for (const [index, [name, buffer]] of images.entries()) {
    const before = documentOf(await storedWorkspace(page)).elements.map((item: any) => item.id)
    await page.locator('nav input[type=file]').setInputFiles({ name, mimeType: 'image/png', buffer })
    await expect.poll(async () => documentOf(await storedWorkspace(page)).elements.length).toBe(before.length + 1)
    const element = documentOf(await storedWorkspace(page)).elements.find((item: any) => !before.includes(item.id))
    imageIds.set(name, element.id)
    const from = await point(element.id)
    await page.mouse.move(from.x, from.y); await page.mouse.down()
    const target = { x: 320 + index * (holdout.overlap ? 80 : 380), y: 430 + index * (holdout.overlap ? 45 : 0) }
    await page.mouse.move(target.x, target.y, { steps: 10 }); await page.mouse.up()
    await expect.poll(async () => (await point(element.id)).x).toBeCloseTo(target.x, 1)
    await expect.poll(async () => (await point(element.id)).y).toBeCloseTo(target.y, 1)
  }
  const chosenId = imageIds.get(holdout.selectedImageName)!, otherId = imageIds.get(holdout.oldImageName)!
  imageFacts.set(chosenId, { text: holdout.selectedLabel, backgroundColor: holdout.selectedColor })
  imageFacts.set(otherId, { text: holdout.oldLabel, backgroundColor: holdout.oldColor })
  const fraction = (id: string) => holdout.overlap ? (id === imageIds.get(images[0][0]) ? .1 : .9) : .5
  await page.keyboard.press('Escape')
  await select(chosenId, fraction(chosenId))
  await mkdir(join(cwd, 'outputs'), { recursive: true })
  await writeFile(join(cwd, 'outputs', holdout.staleOutputName), old)
  await run(ids[5]!, holdout.prompts.deliverSelected, async turn => { assert.deepEqual(turn.context.selection, [chosenId]); return deliver(turn, chosen, { replay: true, workingCopy: true }) })
  await select(chosenId, fraction(chosenId))
  await run(ids[6]!, holdout.prompts.explicitOther, async turn => { assert.deepEqual(turn.context.selection, [chosenId]); return deliver(turn, old) })
  await select(chosenId, fraction(chosenId))
  await run(ids[7]!, holdout.prompts.deliverSelected, async turn => { assert.deepEqual(turn.context.selection, [chosenId]); return deliver(turn, chosen, { workingCopy: true }) }, undefined, async () => {
    await select(otherId, fraction(otherId))
    await page.screenshot({ path: join(evidence, 'selection-changed-after-submit.png') })
  })
  await page.keyboard.press('Escape')
  await select(chosenId, fraction(chosenId))
  await page.keyboard.down('Shift'); await select(otherId, fraction(otherId)); await page.keyboard.up('Shift')
  await run(ids[8]!, holdout.prompts.compareSelection, async turn => { assert.deepEqual([...turn.context.selection].sort(), [chosenId, otherId].sort()) }, [
    'Each selected image has white text on its recorded solid background color. Its image metadata records the exact source content.',
    'Both images can be inspected individually using the available canvas tools even if they overlap. Common color names are sufficient; exact hex codes are not required.'
  ])
  await page.screenshot({ path: join(evidence, 'canvas.png') })
  await json('transport.json', { events: transportEvents, errors: native.errors })
  const after = { builds: await fingerprints(root, productPaths), harness: await fingerprints(harnessRoot, Object.keys(harnessFiles)) }
  await json('build-after.json', after)
  assert.deepEqual(after.builds, builds, 'The product changed during this trial')
  assert.deepEqual(after.harness, harnessFiles, 'The harness changed during this trial')
  if (answers.length) {
    for (const verdict of await judgeCanvasAnswers(answers, evidence, model)) {
      const scenario = scenarios.find(item => item.id === verdict.id)!
      scenario.semantic = verdict
      scenario.success = isSupportedAnswer(verdict)
    }
  }
  for (const scenario of scenarios) scenario.recovered = scenario.success && scenario.toolCalls.some(call => call.status === 'failed' || call.status === 'cancelled')
  runStatus = 'completed'
  await writeReceipt()
  if (scenarios.some(item => !item.success)) process.exitCode = 1
} catch (error) {
  await browser?.pages()[0]?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
  await json('failure.json', { error: String(error), turn: lastTurn, nativeErrors: native?.errors, transportEvents })
  runStatus = /timeout/i.test(String(error)) ? 'timed_out' : 'failed'
  await writeReceipt(error)
  console.error(String(error))
  process.exitCode = 1
} finally {
  try { await browser?.close() }
  finally { server?.stop(true); await native?.close() }
}
