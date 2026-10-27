import { chromium, expect, type Browser, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { codexAdapter } from '../apps/extension/src/background/codexAdapter'
import { nativeBrowser } from './lib/native-browser'
import { connectCodex } from '../tests/helpers/canvas-port'
import { storedWorkspace } from '../tests/helpers/stored-workspace'
import { resolveManagedArtifactPath } from '../packages/canvas/src/artifactPaths'

const root = resolve(import.meta.dir, '..')
process.chdir(root)
const release = resolve(root, 'apps/extension/release')
const model = process.env.GALTA_VERIFY_MODEL ?? 'gpt-6-astra'
const verifyImage = process.env.GALTA_VERIFY_IMAGE === '1'
const trace: Record<string, unknown>[] = []
const errors: string[] = []
const native = await nativeBrowser(root, {}, message => {
  if (message.type === 'codex-rpc') trace.push({ method: message.method, ...(message.params?.threadId ? { threadId: message.params.threadId } : {}), ...(message.params?.turnId ? { turnId: message.params.turnId } : {}), ...(message.method === 'turn/start' ? { model: message.params.model, effort: message.params.effort } : {}) })
})
let browser: Browser | undefined, page: Page | undefined

// Screenshots and receipts stay with the run, outside the repository.
const evidence = await mkdtemp(join(tmpdir(), 'galta-codex-ui-'))

const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = resolve(release, '.' + decodeURIComponent(new URL(request.url).pathname))
  if (!path.startsWith(release + sep)) return new Response('Not found', { status: 404 })
  const file = Bun.file(path)
  return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 })
} })
const deadline = setTimeout(() => {
  errors.push('Production UI live acceptance timed out')
  void native.close()
  void browser?.close()
}, verifyImage ? 720_000 : 360_000)

async function workspace(): Promise<any> {
  return storedWorkspace(page!)
}
function session(bundle: any) { return bundle.agentSessions?.find((s: any) => s.id === bundle.runtimeDefaults?.sessionId) }
function artwork(bundle: any) { return bundle.snapshots[bundle.project.headCommitId].document }
async function waitForTurn(count: number, status = 'completed', timeout = 180_000) {
  await expect.poll(async () => {
    const turns = session(await workspace())?.turns ?? []
    return turns.length === count && Boolean(turns.at(-1)?.completedAt)
  }, { timeout, intervals: [250, 500, 1000] }).toBe(true)
  const saved = await workspace(), current = session(saved)
  // Name the turn's own errors, so a failure says why (for example, the model service throttling it).
  expect(current.turns.at(-1).status, JSON.stringify(current.turns.at(-1).items.filter((i: any) => i.type === 'error').map((i: any) => i.text))).toBe(status)
  if (status === 'completed') expect(current.turns.at(-1).items.some((i: any) => i.type === 'agentMessage' && i.text.trim())).toBe(true)
  expect(current.turns.at(-1).items.filter((i: any) => i.type === 'error')).toEqual([])
  return saved
}
async function reload(objectCount = 1) {
  await page!.reload()
  await expect(page!.getByRole('region', { name: `Galta canvas, ${objectCount} objects`, exact: true })).toBeVisible()
  await connectCodex(page!)
}

let first: any, second: any, stopped: any, resumed: any
try {
  browser = await chromium.launch({ executablePath: process.env.GALTA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  page.on('pageerror', error => errors.push(error.message))
  await native.attach(page)
  codexAdapter.subscribe(notification => {
    const params = notification.params as any
    if (notification.method === 'turn/started' || notification.method === 'turn/completed') trace.push({ method: notification.method, threadId: params.threadId, turnId: params.turn.id, status: params.turn.status })
    if (notification.method === 'item/completed') trace.push({ item: params.item.type, status: params.item.status, ...(params.item.type === 'mcpToolCall' ? { tool: params.item.tool, server: params.item.server } : {}) })
  })
  await page.goto(`http://127.0.0.1:${server.port}/sidepanel/index.html`)
  await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  await connectCodex(page)
  const connected = await codexAdapter.connect()
  if (!connected.ok) throw new Error(connected.error)
  if ('requiresAuth' in connected) throw new Error('Codex requires sign-in before live verification')
  const selected = connected.models?.find(item => item.id === model)
  if (!selected) throw new Error(`Requested model is unavailable: ${model}`)
  if (!selected.supportedReasoningEfforts?.some(item => item.reasoningEffort === 'low')) throw new Error('Requested low effort is unavailable')
  await page.getByRole('button', { name: /^Model / }).click()
  await page.getByRole('radiogroup', { name: 'Model', exact: true }).getByText(selected.displayName ?? selected.id, { exact: true }).click()
  await page.getByRole('button', { name: /^Effort / }).click()
  await page.getByRole('menuitemradio', { name: 'Low', exact: true }).click()
  await page.keyboard.press('Escape')

  const instruction = 'Use canvas_edit to create exactly one text object saying Quiet forms, vivid ideas. at x=400 y=300, color #000000, medium size (24). canvas_inspect to verify the text, coordinates and style, then give a one-sentence answer. No other operations.'
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill(instruction)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible()
  await page.screenshot({ path: join(evidence, 'codex-production-ui-working.png') })
  const saved = await waitForTurn(1), savedSession = session(saved)
  expect(artwork(saved).elements).toHaveLength(1)
  const text = artwork(saved).elements[0]
  expect(text).toMatchObject({ type: 'text', text: 'Quiet forms, vivid ideas.', x: 400, y: 300, strokeColor: '#000000', fontSize: 24 })
  expect(saved.runtimeDefaults).toMatchObject({ modelId: model, effort: 'Low', providerId: 'codex-app-server' })
  const commits = Object.values(saved.project.commits) as any[]
  expect(commits.filter(c => c.source === 'agent')).toHaveLength(1)
  expect(commits.find(c => c.source === 'agent').runtime).toMatchObject({ modelId: model, effort: 'Low', sessionId: savedSession.id, providerId: 'codex-app-server' })
  first = { threadId: savedSession.threadId, turnId: savedSession.lastTurnId }
  expect(saved.agentCheckpoints[saved.project.headCommitId]).toMatchObject({ ...first, sessionId: savedSession.id })
  expect(savedSession.turns[0].instruction).toBe(instruction)
  // Sending opens the conversation.
  await expect(page.getByRole('button', { name: 'Conversation open', exact: true })).toBeVisible()
  await expect(page.locator('.conversation-assistant').last()).toBeVisible()
  await page.screenshot({ path: join(evidence, 'codex-production-ui-created.png') })

  await reload()
  const reopened = await workspace()
  expect(artwork(reopened)).toEqual(artwork(saved))
  expect(session(reopened).threadId).toBe(first.threadId)
  expect(session(reopened).turns).toHaveLength(1)
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect(page.locator('.conversation-turn')).toHaveCount(1)
  await expect(page.locator('.conversation-user')).toContainText(instruction)
  await expect(page.locator('.conversation-assistant').last()).toBeVisible()
  const followup = 'Read the current canvas without changing it. Say the exact phrase you placed in our previous turn, then its x and y coordinates. Do not create, update, or delete anything.'
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill(followup)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const continued = await waitForTurn(2), continuedSession = session(continued)
  second = { threadId: continuedSession.threadId, turnId: continuedSession.lastTurnId }
  expect(second.threadId).toBe(first.threadId)
  expect(second.turnId).not.toBe(first.turnId)
  expect(artwork(continued)).toEqual(artwork(saved))
  expect(continued.project.commits).toEqual(saved.project.commits)
  expect(continuedSession.turns[1].items.filter((i: any) => i.type === 'agentMessage').map((i: any) => i.text).join('\n')).toContain('Quiet forms, vivid ideas.')
  const remote = await codexAdapter.request('thread/read', { threadId: first.threadId, includeTurns: true }) as any
  expect(remote.thread.turns.map((turn: any) => turn.id)).toEqual([first.turnId, second.turnId])
  // Conversation naming runs on its own ephemeral thread; count this thread only.
  expect(trace.filter(item => item.method === 'turn/start' && item.threadId === first.threadId).map(item => item.model)).toEqual([model, model])
  // The first instruction names both tools; the read-only follow-up may answer from context.
  for (const tool of ['canvas_edit', 'canvas_inspect']) expect(trace.some(item => item.item === 'mcpToolCall' && item.server === 'galta' && item.tool === tool && item.status === 'completed'), `Completed ${tool}`).toBe(true)
  expect(trace.some(item => item.item === 'dynamicToolCall')).toBe(false)
  await reload()
  expect(artwork(await workspace())).toEqual(artwork(saved))
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect(page.locator('.conversation-turn')).toHaveCount(2)
  await expect(page.locator('.conversation-user').last()).toContainText(followup)
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible()
  await expect(page.locator('.conversation-assistant.is-error')).toHaveCount(0)
  await page.screenshot({ path: join(evidence, 'codex-production-ui-reopened.png') })

  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Read the canvas without changing it, then explain the visual character of this phrase in detail. Do not create, update, or delete anything.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => trace.filter(item => item.method === 'turn/started' && item.threadId === first.threadId).length, { timeout: 30_000 }).toBe(3)
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click()
  const interrupted = await waitForTurn(3, 'stopped'), interruptedSession = session(interrupted)
  stopped = { threadId: interruptedSession.threadId, turnId: interruptedSession.turns[2].turnId }
  await expect.poll(() => trace.some(item => item.method === 'turn/completed' && item.turnId === stopped.turnId && item.status === 'interrupted'), { timeout: 30_000 }).toBe(true)
  expect(trace.filter(item => item.method === 'turn/interrupt' && item.turnId === stopped.turnId)).toHaveLength(1)
  expect(artwork(interrupted)).toEqual(artwork(saved))
  expect(interrupted.project.commits).toEqual(saved.project.commits)
  await expect(page.locator('.conversation-status').last()).toHaveText(/^Stopped/)
  await page.screenshot({ path: join(evidence, 'codex-production-ui-stopped.png') })
  await reload()
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect(page.locator('.conversation-turn')).toHaveCount(3)
  await expect(page.locator('.conversation-status').last()).toHaveText(/^Stopped/)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill(followup)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const recovered = await waitForTurn(4), recoveredSession = session(recovered)
  resumed = { threadId: recoveredSession.threadId, turnId: recoveredSession.lastTurnId }
  expect(resumed.threadId).toBe(first.threadId)
  expect(new Set([first.turnId, second.turnId, stopped.turnId, resumed.turnId]).size).toBe(4)
  expect(recoveredSession.turns[2].status).toBe('stopped')
  expect(artwork(recovered)).toEqual(artwork(saved))
  expect(recovered.project.commits).toEqual(saved.project.commits)
  const finalRemote = await codexAdapter.request('thread/read', { threadId: first.threadId, includeTurns: true }) as any
  expect(finalRemote.thread.turns.map((turn: any) => ({ id: turn.id, status: turn.status }))).toEqual([
    { id: first.turnId, status: 'completed' }, { id: second.turnId, status: 'completed' },
    { id: stopped.turnId, status: 'interrupted' }, { id: resumed.turnId, status: 'completed' }
  ])
  expect(trace.filter(item => item.method === 'turn/start' && item.threadId === first.threadId).map(item => item.model)).toEqual([model, model, model, model])
  await page.screenshot({ path: join(evidence, 'codex-production-ui-after-stop.png') })
  if (verifyImage) {
    await page.getByRole('button', { name: 'Collapse conversation', exact: true }).first().click()
    await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference-glass.png')
    await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
    await expect.poll(async () => artwork(await workspace()).elements.length).toBe(2)
    const before = await workspace(), original = artwork(before).elements.find((el: any) => el.type === 'image')
    const originalData = artwork(before).files[original.fileId].dataURL
    const imageInstruction = 'Edit the selected photograph: change the yellow lemons inside the clear glass to vivid cobalt-blue lemons. Keep the glass, fruit shapes, arrangement, lighting and pale background recognizable. First call canvas_extract with the submitted original element id. Generate actual pixels with generate_image using BytePlus and the extracted file as a reference, inspect the output, and canvas_place to replace only this submitted image. Preserve its position, dimensions, rotation and the separate text object exactly. Read the canvas to verify the result.'
    await page.getByRole('textbox', { name: 'Ask Galta' }).fill(imageInstruction)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible()
    // Change the live selection after submission using real canvas input.
    await page.mouse.click(1080, 500)
    const edited = await waitForTurn(5, 'completed', 360_000)
    const after = artwork(edited), replacement = after.elements.find((el: any) => el.id === original.id)
    expect(after.elements).toHaveLength(2)
    expect(after.elements.find((el: any) => el.type === 'text')).toEqual(artwork(before).elements.find((el: any) => el.type === 'text'))
    for (const key of ['x', 'y', 'width', 'height', 'angle', 'scale']) expect(replacement[key]).toEqual(original[key])
    expect(replacement.fileId).not.toBe(original.fileId)
    expect(replacement.customData.generatedPath).toBeTruthy()
    // The canvas records a portable workspace reference; resolve it in the execution's workspace.
    expect(edited.codexProject?.cwd).toBeTruthy()
    const generatedPath = resolveManagedArtifactPath(replacement.customData.generatedPath, edited.codexProject.cwd)
    expect(edited.snapshots[before.project.headCommitId].document.files[original.fileId].dataURL).toBe(originalData)
    expect(Object.values(edited.project.commits).filter((c: any) => c.source === 'agent')).toHaveLength(2)
    const imageTurn = { threadId: session(edited).threadId, turnId: session(edited).lastTurnId }
    expect(imageTurn.threadId).toBe(first.threadId)
    const imageRemote = await codexAdapter.request('thread/read', { threadId: imageTurn.threadId, includeTurns: true }) as any
    const items = imageRemote.thread.turns.find((turn: any) => turn.id === imageTurn.turnId).items
    const calls = items.filter((item: any) => item.type === 'mcpToolCall' && item.server === 'galta')
    for (const tool of ['canvas_extract', 'generate_image', 'canvas_place', 'canvas_inspect']) expect(calls.some((item: any) => item.tool === tool && item.status === 'completed' && !item.error), `Successful Galta action: ${tool}`).toBe(true)
    expect(items.some((item: any) => item.type === 'imageGeneration')).toBe(false)
    const generatedBytes = await readFile(generatedPath)
    expect(Buffer.from(after.files[replacement.fileId].dataURL.split(',')[1], 'base64')).toEqual(generatedBytes)
    // The placed file is one the generate_image call saved, byte for byte.
    const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
    // A job comes back structured, or as the same JSON in the text result; a
    // path may name the same file through a symlinked parent (/tmp, /private/tmp).
    const reported = (result: any) => result?.structuredContent ?? (() => { try { return JSON.parse(result?.content?.find((c: any) => c.type === 'text')?.text) } catch { return undefined } })()
    const jobs = calls.filter((item: any) => item.tool === 'generate_image' || item.tool === 'generation_get').map((item: any) => reported(item.result)).filter(Boolean)
    const placedFile = await realpath(generatedPath), same = async (path: string) => (await realpath(path).catch(() => path)) === placedFile
    let job: any
    for (const candidate of jobs) if (candidate.status === 'succeeded') for (const file of candidate.files ?? []) if (!job && await same(file.path)) job = candidate
    expect(job, `The placed image is a saved generate_image output: ${generatedPath} among ${JSON.stringify(jobs.map((j: any) => ({ status: j.status, files: j.files?.map((f: any) => f.path) })))}`).toBeTruthy()
    await Bun.write(join(evidence, 'generated-image.png'), generatedBytes)
    await page.screenshot({ path: join(evidence, 'generated-image-placed.png') })
    await reload(2)
    const restored = await workspace()
    expect(artwork(restored)).toEqual(after)
    expect(session(restored).threadId).toBe(first.threadId)
    expect(session(restored).turns).toHaveLength(5)
    await page.screenshot({ path: join(evidence, 'generated-image-restored.png') })
    await Bun.write(join(evidence, 'generated-image-live.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), model, effort: 'low', first, second, imageTurn, generation: { route: 'galta-generate-image', provider: job.provider, model: job.model, jobId: job.id, outputPath: generatedPath, outputReference: replacement.customData.generatedPath, outputSha256: sha256(generatedBytes), sourceSha256: sha256(Buffer.from(originalData.split(',')[1], 'base64')), outputBytes: generatedBytes.length, toolActions: calls.map((item: any) => ({ tool: item.tool, status: item.status })) }, target: { id: original.id, originalFileId: original.fileId, generatedFileId: replacement.fileId, x: original.x, y: original.y, width: original.width, height: original.height, angle: original.angle }, boundaries: { realNativeHost: true, persistentCodexThread: true, productionComposer: true, actualExcalidraw: true, galtaGeneration: true, originalImageRead: true, submittedTargetPreserved: true, unrelatedArtworkPreserved: true, geometryPreserved: true, realGeneratedBytes: true, originalHistoryPreserved: true, indexedDbPersistence: true, reloadGeneratedPixels: true }, transport: 'Test-only Chrome delivery adapter; exact production HTTP page; not an installed native side panel' }, null, 2) + '\n')
    console.log('PASS: production composer -> real Codex -> generate_image -> generated target pixels -> IndexedDB -> reload')
  }
  expect([...errors, ...native.errors]).toEqual([])
  await Bun.write(join(evidence, 'codex-production-ui-live.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), model, effort: 'low', first, second, stopped, resumed, boundaries: { realNativeHost: true, persistentCodexThread: true, productionComposer: true, productionBridge: true, actualExcalidraw: true, exactTextGeometryStyle: true, indexedDbPersistence: true, reloadConversation: true, readOnlyContinuation: true, runtimeProvenance: true, visibleStopControl: true, actualStop: true, stoppedConversationReload: true, sameThreadAfterStop: true }, transport: 'Test-only Chrome delivery adapter; isolated production HTTP page; not an installed native side panel', trace, errors }, null, 2) + '\n')
  console.log('PASS: production composer -> real Codex -> exact artwork and runtime history -> IndexedDB -> reload -> same-thread continuation -> Stop -> confirmed native interruption -> reload -> same-thread recovery')
} catch (error) {
  if (verifyImage) await Bun.write(join(evidence, 'generated-image-failure.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), model, error: String(error), trace, errors }, null, 2) + '\n')
  await Bun.write(join(evidence, 'codex-production-ui-failure.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), model, first, second, stopped, resumed, error: String(error), trace, errors }, null, 2) + '\n')
  if (page && !page.isClosed()) await page.screenshot({ path: join(evidence, 'codex-production-ui-failure.png') }).catch(() => undefined)
  throw error
} finally {
  clearTimeout(deadline)
  console.log(`Evidence: ${evidence}`)
  await native.close()
  await browser?.close()

  server.stop(true)
}
