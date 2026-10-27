import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { codexTestEnvironment, codexTestHome } from './lib/codex-test-home'
import { NativeClient } from './distribution/native-client'
import { CodexAgentRuntime } from '../packages/runtime/src/codex'
import { asProjectId } from '../packages/domain/src/index'
import { canvasMessageContextSchema } from '../packages/canvas/src/message'

// Freeze rendered inputs before inference. Case-specific input is the image
// and question; filenames are neutral and the scoring key never enters
// its context or workspace. `audit` checks the CLI's actual outgoing request.
const root = resolve(process.env.GALTA_VERIFY_ROOT ?? resolve(import.meta.dir, '..'))
const [mode, suppliedDirectory, ...conditionArgs] = Bun.argv.slice(2)
assert(suppliedDirectory && ['prepare', 'capture', 'freeze', 'run', 'audit'].includes(mode ?? ''), 'Usage: verify-canvas-perception.ts prepare|capture|freeze|run|audit <directory> [condition ...]')
const directory = resolve(suppliedDirectory)
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const json = (path: string, value: unknown) => writeFile(join(directory, path), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const executable = process.env.GALTA_CODEX_BIN ?? Bun.which('codex')
assert(executable, 'Codex executable required')
const answerSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }
const disabled = ['apps', 'shell_tool', 'multi_agent', 'multi_agent_v2', 'image_generation', 'view_image', 'goals', 'default_mode_request_user_input', 'browser_use', 'computer_use', 'code_mode', 'code_mode_only', 'hooks', 'workspace_dependencies', 'skill_search', 'plugins', 'sleep_tool']
const unexpectedEvents = (events: string) => events.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => event.type === 'error' || event.item && !['agent_message', 'reasoning'].includes(event.item.type))
function inferenceArgs(cwd: string, schema: string, model: string, reasoning: string, imageNames = ['observation.jpg']): string[] {
  return [executable!, 'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--json', '-C', cwd, '-m', model,
    '-c', 'notify=[]', '-c', 'web_search="disabled"', '-c', 'skills.include_instructions=false', '-c', 'project_doc_max_bytes=0', '-c', `model_reasoning_effort="${reasoning}"`,
    ...disabled.flatMap(name => ['-c', `features.${name}=false`]), '--image', ...imageNames.map(name => join(cwd, name)), '--output-schema', schema, '--output-last-message', join(cwd, 'answer.json'), '-']
}
type Case = { id: string; family: string; zoom: number; question: string; expected: string; operations: any[] }
type ImageRecord = { image: string; sha256: string; width: number; height: number; context: unknown; additional?: ImageRecord[]; document?: unknown }
const sourceFiles = ['apps/extension/src/canvas/toolScene.ts', 'apps/extension/src/canvas/observation.ts', 'apps/extension/src/canvas/canvasTool.ts', 'apps/extension/src/canvas/canvasMessage.ts']
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(join(root, file)))])))
const environmentSource = join(import.meta.dir, 'lib/codex-test-home.ts')

function cases(seed: string, variants: number): Case[] {
  const token = (key: string) => hash(`${seed}/${key}`)
  const result: Case[] = []
  for (const family of ['open-stroke', 'arrow', 'text', 'relation', 'color', 'count']) for (let variant = 0; variant < variants; variant++) {
    const id = token(`${family}/${variant}`).slice(0, 16)
    const zoom = [1, 5, .5, 5][variant % 4]!
    const n = (key: string) => parseInt(token(`${id}/${key}`).slice(0, 8), 16)
    const orientation = (variant + n('orientation')) % 4
    const x = 150 + n('x') % 200, y = 160 + n('y') % 120
    const opaque = (key: string) => token(`${id}/${key}`).slice(0, 16)
    const make = (key: string, type: string, dx: number, dy: number, props: Record<string, unknown>, rotation = 0) => ({
      type: 'create_element', id: opaque(key), elementType: type, x: (x + dx) / zoom, y: (y + dy) / zoom, rotation,
      props: { roughness: 0, strokeColor: '#111111', strokeWidth: 2 / zoom, ...props }
    })
    let operations: any[], question: string, expected: string
    if (family === 'open-stroke') {
      const width = 80 + n('width') % 100, height = 55 + n('height') % 65
      const points = Array.from({ length: 41 }, (_, i) => [width * i / 40 / zoom, height * Math.sin(Math.PI * i / 40) / zoom])
      operations = [make('target', 'freedraw', 0, 0, { points, strokeWidth: 3 / zoom, simulatePressure: true, pressures: [] }, orientation * Math.PI / 2)]
      question = 'The curved stroke has two open ends and a rounded bend. From the bend toward the open ends, which screen direction does it open? Answer up, right, down, left, or unknown.'
      expected = ['up', 'right', 'down', 'left'][orientation]!
    } else if (family === 'arrow') {
      operations = [make('target', 'arrow', 0, 0, { points: [[0, 0], [150 / zoom, 0]], startArrowhead: null, endArrowhead: 'triangle' }, orientation * Math.PI / 2)]
      question = 'Which screen direction does the arrowhead point? Answer right, down, left, up, or unknown.'
      expected = ['right', 'down', 'left', 'up'][orientation]!
    } else if (family === 'text') {
      expected = token(`${id}/label`).slice(0, 8).toUpperCase()
      operations = [{ type: 'create_text', id: opaque('target'), x: x / zoom, y: y / zoom, text: expected, props: { fontFamily: 2, fontSize: 12 / zoom, strokeColor: '#111111' } },
        make('context', 'rectangle', 230, 80, { width: 90 / zoom, height: 60 / zoom, backgroundColor: '#22aa66', fillStyle: 'solid' })]
      question = 'Read the eight-character label exactly as shown. Return the characters, or unknown if they cannot be read.'
    } else if (family === 'relation') {
      const [dx, dy] = [[180, 0], [0, 140], [-180, 0], [0, -140]][orientation]!
      operations = [make('anchor', 'rectangle', 180, 160, { width: 50 / zoom, height: 50 / zoom, backgroundColor: '#e02020', fillStyle: 'solid' }),
        make('target', 'ellipse', 180 + dx!, 160 + dy!, { width: 50 / zoom, height: 50 / zoom, backgroundColor: '#2060e0', fillStyle: 'solid' })]
      question = 'Where is the blue circle relative to the red square? Answer right, below, left, above, or unknown.'
      expected = ['right', 'below', 'left', 'above'][orientation]!
    } else if (family === 'color') {
      const colors = [['red', '#e02020'], ['green', '#169c46'], ['blue', '#2060e0'], ['yellow', '#e0c020']]
      expected = colors[orientation]![0]!
      operations = [make('target', 'ellipse', 0, 0, { width: 28 / zoom, height: 28 / zoom, backgroundColor: colors[orientation]![1], fillStyle: 'solid' }),
        make('context', 'rectangle', 250, 120, { width: 110 / zoom, height: 80 / zoom })]
      question = 'What is the fill color of the small circle? Answer red, green, blue, yellow, or unknown.'
    } else {
      const count = 3 + n('count') % 6
      expected = String(count)
      operations = Array.from({ length: count }, (_, i) => make(`target-${i}`, 'ellipse', i * 35, i % 2 * 25, { width: 12 / zoom, height: 12 / zoom, backgroundColor: '#111111', fillStyle: 'solid' }))
      question = 'How many separate filled circles are visible? Return the integer, or unknown.'
    }
    operations.sort((a, b) => opaque(a.id).localeCompare(opaque(b.id)))
    result.push({ id, family, zoom, question, expected, operations })
  }
  return result
}

async function render(items: Case[], condition: string) {
  const detailView = process.env.GALTA_VERIFY_DETAIL_VIEW === '1'
  const documentView = process.env.GALTA_VERIFY_DOCUMENT === '1'
  const server = Bun.spawn(['bun', 'run', '--cwd', 'apps/extension', 'dev', '--host', '127.0.0.1', '--port', '5198', '--strictPort'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const stdout = new Response(server.stdout).text(), stderr = new Response(server.stderr).text()
  const browser = await chromium.launch({ executablePath: process.env.GALTA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
  const images: Record<string, ImageRecord> = {}
  try {
    const deadline = Date.now() + 20_000
    while (true) {
      assert(server.exitCode === null, 'Fixture server exited')
      try { if ((await fetch('http://127.0.0.1:5198/dev/scene-test.html')).ok) break } catch {}
      assert(Date.now() < deadline, 'Fixture server unavailable')
      await Bun.sleep(100)
    }
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    await page.goto('http://127.0.0.1:5198/dev/scene-test.html')
    await page.waitForFunction(() => Boolean((window as any).engineTest))
    for (const item of items) {
      const rendered = await page.evaluate(async ({ item, detailView, documentView }) => {
        const { CanvasTool } = await import('/canvas/canvasTool.ts' as string)
        const { TaskScene } = await import('/canvas/toolScene.ts' as string)
        const { prepareCanvasMessage } = await import('/canvas/canvasMessage.ts' as string)
        const { scene, engineTest: t } = window as any
        if (scene.elements.length) t.apply(scene.elements.map((el: any) => ({ type: 'delete', elementId: el.id })))
        t.apply(item.operations)
        const viewport = { x: 0, y: 0, width: 1200 / item.zoom, height: 900 / item.zoom, zoom: item.zoom }
        const submitted = { ...t.captureSubmittedContext(scene), selection: [], viewport }
        const task = new TaskScene(scene.snapshot(), [], { ...viewport, center: { x: viewport.width / 2, y: viewport.height / 2 } })
        try {
          const tool = new CanvasTool(task, {}, () => { throw Error('Read only') }, submitted)
          const scope = { executionId: 'perception', cwd: '/tmp/galta-perception', signal: new AbortController().signal }
          const message = await prepareCanvasMessage(tool, submitted, item.id, scope)
          const bitmap = await createImageBitmap(await (await fetch(message.image!.dataUrl)).blob())
          const dimensions = { width: bitmap.width, height: bitmap.height }; bitmap.close()
          let detail
          if (detailView) {
            const result = await tool.execute('canvas_capture', { scope: 'canvas', detail: 'low' }, scope)
            const image = result.content.find((part: any) => part.type === 'image')!
            if (image.type !== 'image') throw Error('No detail image')
            const bitmap = await createImageBitmap(await (await fetch(`data:${image.mimeType};base64,${image.data}`)).blob())
            detail = { data: image.data, width: bitmap.width, height: bitmap.height, context: result.structuredContent }; bitmap.close()
          }
          const document = documentView ? (await tool.execute('canvas_inspect', { scope: 'viewport', detail: 'elements' }, scope)).structuredContent : undefined
          return { message, ...dimensions, detail, document }
        } finally { task.close() }
      }, { item, detailView, documentView })
      const image = `${condition}/${item.id}.jpg`, bytes = Buffer.from(rendered.message.image!.dataUrl.split(',')[1]!, 'base64')
      await writeFile(join(directory, image), bytes, { flag: 'wx' })
      images[item.id] = { image, sha256: hash(bytes), width: rendered.width, height: rendered.height, context: rendered.message.context }
      if (rendered.document) images[item.id]!.document = rendered.document
      if (rendered.detail) {
        const image = `${condition}/${item.id}-detail.jpg`, bytes = Buffer.from(rendered.detail.data, 'base64')
        await writeFile(join(directory, image), bytes, { flag: 'wx' })
        images[item.id]!.additional = [{ image, sha256: hash(bytes), width: rendered.detail.width, height: rendered.detail.height, context: rendered.detail.context }]
      }
    }
    await json(`${condition}/source.json`, { hashes: await sourceHashes(), files: Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, await readFile(join(root, file), 'utf8')])) ) })
  } finally {
    await browser.close(); server.kill(); await server.exited
    await json(`${condition}/server.json`, { stdout: await stdout, stderr: await stderr })
  }
  return images
}

if (mode === 'audit') {
  await mkdir(directory)
  const scratch = await mkdtemp(join(tmpdir(), 'galta-codex-test-')), home = join(scratch, 'codex'), cwd = join(scratch, crypto.randomUUID())
  await mkdir(home); await mkdir(cwd)
  const source = resolve(conditionArgs[0] ?? '')
  assert(conditionArgs.length === 1, 'audit requires a JPEG fixture path')
  await copyFile(source, join(cwd, 'observation.jpg'))
  await copyFile(source, join(cwd, 'observation-2.jpg'))
  const schema = join(scratch, 'answer-schema.json')
  await writeFile(schema, JSON.stringify(answerSchema))
  const prompt = 'Describe the attached image. Return the answer in the JSON answer field.'
  const requests: any[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method !== 'POST') return Response.json({ data: [] })
    const body = await request.json(); requests.push(body)
    const item = { type: 'message', id: `msg_${crypto.randomUUID()}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"answer":"audit"}', annotations: [] }] }
    const response = { id: `resp_${crypto.randomUUID()}`, object: 'response', created_at: 1, model: body.model, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  } })
  await writeFile(join(home, 'config.toml'), `model='gpt-6-astra'\nmodel_provider='fixture'\n[model_providers.fixture]\nname='Local transport audit'\nbase_url='http://127.0.0.1:${server.port}/v1'\nwire_api='responses'\nrequires_openai_auth=false\nsupports_websockets=false\n`)
  const env = { ...process.env, ...codexTestEnvironment(home, scratch), GALTA_CODEX_BIN: executable, GALTA_MCP_BIN: join(root, 'native/mcp/galta-mcp') }
  const cli = Bun.spawn(inferenceArgs(cwd, schema, 'gpt-6-astra', 'high', ['observation.jpg', 'observation-2.jpg']), { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => cli.kill(), 30_000)
  const stdout = new Response(cli.stdout).text(), stderr = new Response(cli.stderr).text()
  let client: NativeClient | undefined
  try {
    cli.stdin.write(prompt); cli.stdin.end()
    const code = await cli.exited
    const events = await stdout
    await json('cli.json', { code, stdout: events, stderr: await stderr })
    assert.equal(code, 0); assert.equal(requests.length, 1)
    assert.deepEqual(unexpectedEvents(events), [], 'CLI audit emitted errors or tool activity')
    const request = requests[0], content = request.input.at(-1).content
    const text = request.input.flatMap((item: any) => item.content ?? []).filter((part: any) => part.type === 'input_text').map((part: any) => part.text).join('\n')
    assert(!text.includes(source), 'Fixture source path leaked')
    assert(!text.includes('<skills_instructions>'), 'Skills leaked into perception trial')
    const cliTools = [...(request.tools ?? []), ...request.input.flatMap((item: any) => item.tools ?? [])]
    assert.equal(request.reasoning.effort, 'high')
    assert.equal(content.filter((part: any) => part.type === 'input_image').length, 2)
    assert(content.some((part: any) => part.text === `<image name=[Image #1] path="${join(cwd, 'observation.jpg')}">`))
    assert.equal(content.at(-1).text, prompt)
    const expectedImage = `data:image/jpeg;base64,${(await readFile(source)).toString('base64')}`
    const cliImage = content.find((part: any) => part.type === 'input_image')
    assert.deepEqual(content.filter((part: any) => part.type === 'input_image').map((part: any) => part.image_url), [expectedImage, expectedImage], 'CLI changed the fixture bytes')
    const listeners = new Set<(message: any) => void>()
    client = new NativeClient(join(root, 'native/adapters/codex/galta-codex-bridge'), 'chrome-extension://oocbicpnofichiglihkbmpkjegiakhgg/', env, message => { for (const listener of listeners) listener(message) })
    await client.request('initialize', { clientInfo: { name: 'galta_perception_audit', version: '1' }, capabilities: { experimentalApi: true } })
    client.notify('initialized', {})
    const runtime = new CodexAgentRuntime({ request: (method, params) => client!.request(method, params), respond: async () => { throw Error('Unexpected server request') }, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } })
    const handle = await runtime.start({ projectId: asProjectId('fixture'), branchId: 'main', execution: { id: 'fixture/vision', cwd }, instruction: prompt, canvas: { context: canvasMessageContextSchema.parse({ commitId: 'fixture-commit', revision: 'fixture-revision', viewport: { x: 0, y: 0, width: 100, height: 100, zoom: 1 }, elementCount: 1, selection: { total: 0, items: [], truncated: false }, visible: { total: 0, items: [], truncated: false }, changes: { since: null, status: 'initial', total: 0, items: [], truncated: false }, preview: { status: 'attached', unrenderedCount: 0 } }), image: { dataUrl: expectedImage } }, runtime: { modelId: 'gpt-6-astra', effort: 'High', providerId: 'codex-app-server', sessionId: 'fixture', sessionLabel: 'Fixture' } }, { request: async () => { throw Error('Unexpected tool call') } })
    let terminal: any
    for await (const update of handle.updates) terminal = update
    assert.equal(terminal.state, 'completed'); assert.equal(requests.length, 2)
    const product = requests[1], productImage = product.input.at(-1).content.find((part: any) => part.type === 'input_image')
    assert.equal(product.reasoning.effort, 'high')
    assert.equal(productImage.image_url, expectedImage, 'Production changed the fixture bytes')
    await json('summary.json', { cliDetail: cliImage.detail ?? null, productDetail: productImage.detail ?? null, imageSha256: hash(await readFile(source)), reasoning: product.reasoning.effort, neutralFilename: true, cliTools, cliSkills: false,
      toolPolicy: 'The host still advertises built-in tools. Any actual tool call disqualifies an inference result.' })
    console.log(JSON.stringify({ directory, cliDetail: cliImage.detail ?? null, productDetail: productImage.detail ?? null, passed: true }))
  } finally {
    clearTimeout(timer); if (cli.exitCode === null) { cli.kill(); await cli.exited }
    await client?.close(); server.stop(true)
    await json('requests.json', requests)
  }
} else if (mode === 'prepare') {
  await mkdir(directory)
  await mkdir(join(directory, 'baseline'))
  const seed = process.env.GALTA_VERIFY_SEED ?? crypto.randomUUID()
  const variants = Number(process.env.GALTA_VERIFY_VARIANTS ?? 4)
  assert(Number.isInteger(variants) && variants > 0 && variants <= 32, 'GALTA_VERIFY_VARIANTS must be an integer between 1 and 32')
  const fixtures = cases(seed, variants)
  await json('fixtures.json', { seed, cases: fixtures })
  await json('baseline/images.json', await render(fixtures, 'baseline'))
  console.log(JSON.stringify({ directory, cases: fixtures.length, modelRequests: 0 }))
} else if (mode === 'capture') {
  const [condition] = conditionArgs
  assert(conditionArgs.length === 1 && /^[a-z][a-z0-9-]*$/.test(condition!), 'capture requires one condition name')
  const fixtures = await Bun.file(join(directory, 'fixtures.json')).json()
  await mkdir(join(directory, condition!))
  await json(`${condition}/images.json`, await render(fixtures.cases, condition!))
  console.log(JSON.stringify({ directory, cases: fixtures.cases.length, modelRequests: 0 }))
} else if (mode === 'freeze') {
  const fixtures = await Bun.file(join(directory, 'fixtures.json')).json()
  const version = Bun.spawn([executable, '--version'], { stdout: 'pipe' })
  const codexVersion = (await new Response(version.stdout).text()).trim(); assert.equal(await version.exited, 0)
  const conditions = conditionArgs
  assert(conditions.length >= 2 && new Set(conditions).size === conditions.length && conditions.every(condition => /^[a-z][a-z0-9-]*$/.test(condition)), 'freeze requires at least two distinct rendered conditions')
  const reasoning = process.env.GALTA_VERIFY_EFFORT ?? 'low'
  assert(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoning), 'Unsupported GALTA_VERIFY_EFFORT')
  const concurrency = Number(process.env.GALTA_VERIFY_CONCURRENCY ?? 2)
  assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4, 'GALTA_VERIFY_CONCURRENCY must be an integer from 1 to 4')
  const images = Object.fromEntries(await Promise.all(conditions.map(async condition => [condition, await Bun.file(join(directory, condition, 'images.json')).json()])))
  const trials = fixtures.cases.flatMap((item: Case) => conditions.map(condition => ({ id: hash(`${fixtures.seed}/${item.id}/${condition}`).slice(0, 16), caseId: item.id, condition })))
    .sort((a: any, b: any) => a.id.localeCompare(b.id))
  await json('plan.json', { schema: 'galta-perception-v2', preparedAt: new Date().toISOString(), model: process.env.GALTA_VERIFY_MODEL ?? 'gpt-6-astra', codexVersion,
    fixtures, images, conditions, trials, repeats: 1, concurrency, timeoutMs: 90_000, reasoning, source: hash(await readFile(import.meta.path)), environmentSource: hash(await readFile(environmentSource)),
    blinding: 'Images use neutral observation[-N].jpg filenames in opaque, isolated trial workspaces. Neither condition names, original fixture paths nor answer keys enter the request. Host base instructions and built-in tools may remain; any tool use fails the trial.',
    scoring: 'Exact answer to a factual question; unknown is a failure, no judge, no retries. No answer key is supplied. Image-only conditions supply no document; an explicit document condition supplies the actual native canvas_inspect result, not derived semantic labels.',
    limits: 'Controlled perceptual probes across six synthetic families, not a population estimate or complete user workflow. Inspect the rendered stimuli before inference.' })
  await writeFile(join(directory, 'plan.sha256'), hash(await readFile(join(directory, 'plan.json'))) + '\n', { flag: 'wx' })
  await writeFile(join(directory, 'runner.ts'), await readFile(import.meta.path), { flag: 'wx' })
  await writeFile(join(directory, 'codex-test-home.ts'), await readFile(environmentSource), { flag: 'wx' })
  console.log(JSON.stringify({ directory, trials: trials.length, modelRequests: 0 }))
} else {
  const planBytes = await readFile(join(directory, 'plan.json'))
  assert.equal(hash(planBytes), (await readFile(join(directory, 'plan.sha256'), 'utf8')).trim())
  const plan = JSON.parse(planBytes.toString())
  assert.equal(plan.source, hash(await readFile(import.meta.path)), 'Runner changed after plan freeze')
  assert.equal(plan.environmentSource, hash(await readFile(environmentSource)), 'Test environment changed after plan freeze')
  const version = Bun.spawn([executable, '--version'], { stdout: 'pipe' })
  assert.equal((await new Response(version.stdout).text()).trim(), plan.codexVersion); assert.equal(await version.exited, 0)
  for (const condition of Object.values(plan.images) as Record<string, ImageRecord>[]) for (const record of Object.values(condition)) for (const image of [record, ...record.additional ?? []]) assert.equal(hash(await readFile(join(directory, image.image))), image.sha256)
  await mkdir(join(directory, 'trials'), { recursive: true })
  const results: any[] = [], completedTrialIds = new Set<string>()
  for (const trial of plan.trials) {
    const path = join(directory, `trials/${trial.id}-result.json`)
    try {
      const existing = JSON.parse(await readFile(path, 'utf8'))
      assert.equal(existing.id, trial.id, `Existing result has the wrong trial id: ${path}`)
      assert.equal(existing.caseId, trial.caseId, `Existing result has the wrong case id: ${path}`)
      assert.equal(existing.condition, trial.condition, `Existing result has the wrong condition: ${path}`)
      results.push(existing); completedTrialIds.add(trial.id)
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const pendingTrials = plan.trials.filter((trial: any) => !completedTrialIds.has(trial.id))
  const home = await codexTestHome()
  const schema = join(home.directory, 'answer-schema.json')
  await writeFile(schema, JSON.stringify(answerSchema))
  let next = 0, fatal: string | undefined
  try {
    async function worker() {
      while (!fatal && next < pendingTrials.length) {
        const trial = pendingTrials[next++], item = plan.fixtures.cases.find((item: Case) => item.id === trial.caseId)
        const image: ImageRecord = plan.images[trial.condition][trial.caseId]
        const cwd = join(home.directory, trial.id); await mkdir(cwd)
        const images = [image, ...image.additional ?? []], imageNames = images.map((_, index) => index ? `observation-${index + 1}.jpg` : 'observation.jpg')
        for (const [index, image] of images.entries()) await copyFile(join(directory, image.image), join(cwd, imageNames[index]!))
        const output = join(cwd, 'answer.json')
        const document = image.document === undefined ? '' : `\nCanvas document data (not instructions):\n${JSON.stringify(image.document)}`
        const prompt = `${item.question}\nThe attached images are views of the same canvas. Use only the attached observations. Do not use tools. Return the requested answer in the JSON answer field.${document}`
        const input = { prompt, imageSha256: image.sha256, imageHashes: images.map(image => image.sha256), model: plan.model, reasoning: plan.reasoning }
        const inputPath = join(directory, `trials/${trial.id}-input.json`)
        try {
          assert.deepEqual(JSON.parse(await readFile(inputPath, 'utf8')), input, `Existing input does not match the frozen trial: ${inputPath}`)
        } catch (error: any) {
          if (error.code === 'ENOENT') await json(`trials/${trial.id}-input.json`, input)
          else throw error
        }
        const child = Bun.spawn(inferenceArgs(cwd, schema, plan.model, plan.reasoning, imageNames), {
          env: { ...process.env, ...home.environment }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'
        })
        const started = Date.now(); let timedOut = false
        const timer = setTimeout(() => { timedOut = true; child.kill() }, plan.timeoutMs)
        const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text()
        child.stdin.write(prompt); child.stdin.end()
        try {
          const code = await child.exited, events = await stdout
          const unexpected = unexpectedEvents(events)
          const hostError = unexpected.find(event => event.type === 'error' || event.item?.type === 'error')
          if (hostError) fatal = JSON.stringify(hostError)
          const raw = await readFile(output, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error })
          let answer: unknown
          try { answer = JSON.parse(raw).answer } catch { /* Malformed output is a recorded failure. */ }
          const completed = !timedOut && code === 0 && typeof answer === 'string' && !unexpected.length
          const result = { ...trial, family: item.family, zoom: item.zoom, completed, success: completed && answer === item.expected, answer, expected: item.expected, code, timedOut, durationMs: Date.now() - started, events, stderr: await stderr }
          results.push(result); await json(`trials/${trial.id}-result.json`, result)
          console.log(JSON.stringify({ ...trial, completed: results.length, total: plan.trials.length, success: result.success }))
        } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited } }
      }
    }
    await Promise.all(Array.from({ length: plan.concurrency }, () => worker()))
    const byCondition = Object.fromEntries(plan.conditions.map((condition: string) => {
      const subset = results.filter(item => item.condition === condition)
      return [condition, { total: subset.length, completed: subset.filter(item => item.completed).length, correct: subset.filter(item => item.success).length, failures: subset.filter(item => !item.success).map(({ id, family, zoom, answer, expected, timedOut }) => ({ id, family, zoom, answer, expected, timedOut })) }]
    }))
    const pairs = plan.fixtures.cases.map((item: Case) => ({ id: item.id, family: item.family, outcomes: Object.fromEntries(plan.conditions.map((condition: string) => [condition, results.find(result => result.caseId === item.id && result.condition === condition)?.success ?? null])) }))
    results.sort((a, b) => plan.trials.findIndex((trial: any) => trial.id === a.id) - plan.trials.findIndex((trial: any) => trial.id === b.id))
    await json('run.json', { planSha256: hash(planBytes), completedAt: new Date().toISOString(), status: fatal ? 'aborted' : 'completed', fatal, unstarted: pendingTrials.slice(next), results, byCondition, pairs, populationSuccessClaim: false })
    console.log(JSON.stringify(byCondition, null, 2))
    assert(!fatal, `Host error aborted the experiment: ${fatal}`)
  } finally { await home.close() }
}
