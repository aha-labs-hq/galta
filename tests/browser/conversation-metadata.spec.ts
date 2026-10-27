import { test, expect, type Page } from '@playwright/test'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installCanvasPort, connectCodex } from '../helpers/canvas-port'
import { seedWorkspace, storedWorkspace } from '../helpers/stored-workspace'
import { galtaToolContract } from '../../packages/canvas/src/contract'

function metadataServer() {
  const pages = new Set<Page>(), threads = new Map<string, any>(), projects = new Map<string, any>()
  const calls: any[] = [], naming: { page: Page; thread: any; turn: any }[] = []
  let failures = false
  let rejected: { method: string; error: string } | undefined
  let forkAcknowledgement: Promise<void> | undefined
  let publication: { name: string; fail: boolean; wait: Promise<void> } | undefined
  let projectRead: { started(): void; wait: Promise<void> } | undefined
  const notify = async (page: Page, method: string, params: unknown) => { if (!page.isClosed()) await page.evaluate(({ method, params }) => (window as any).__metadataNotify(method, params), { method, params }) }
  return {
    calls, naming, threads, projects, failNaming(value: boolean) { failures = value },
    failNext(method: string, error = `Fixture rejected ${method}`) { rejected = { method, error } },
    delayFork() {
      let release!: () => void
      forkAcknowledgement = new Promise<void>(resolve => { release = resolve })
      return release
    },
    delayName(name: string, fail = false) {
      let release!: () => void
      publication = { name, fail, wait: new Promise<void>(resolve => { release = resolve }) }
      return release
    },
    delayProjectRead() {
      let started!: () => void, release!: () => void
      const pending = new Promise<void>(resolve => { started = resolve })
      projectRead = { started, wait: new Promise<void>(resolve => { release = resolve }) }
      return { pending, release }
    },
    async renameRemote(name: string) {
      const thread = [...threads.values()].find(thread => !thread.ephemeral)!
      thread.name = name
      for (const page of pages) await notify(page, 'thread/name/updated', { threadId: thread.id, threadName: name })
    },
    async renameRemoteSequence(names: string[]) {
      const thread = [...threads.values()].find(thread => !thread.ephemeral)!
      thread.name = names.at(-1)
      for (const page of pages) await page.evaluate(({ names, threadId }) => {
        for (const threadName of names) (window as any).__metadataNotify('thread/name/updated', { threadId, threadName })
      }, { names, threadId: thread.id })
    },
    async restoreRemote(threadId: string) {
      threads.get(threadId).archived = false
      for (const page of pages) await notify(page, 'thread/unarchived', { threadId })
    },
    async finishNaming(index = 0) {
      const { page, thread, turn } = naming[index]!
      turn.status = 'completed'; turn.items = [{ id: 'name', type: 'agentMessage', text: JSON.stringify({ conversationTitle: 'Poster composition', canvasTitle: 'Summer exhibition' }) }]
      await notify(page, 'turn/completed', { threadId: thread.id, turn })
    },
    async finishUser(page: Page, threadId?: string) {
      const thread = threadId ? threads.get(threadId)! : [...threads.values()].find(thread => !thread.ephemeral)!, turn = thread.turns.at(-1)
      turn.status = 'completed'; turn.items.push({ id: 'reply-' + turn.id, type: 'agentMessage', text: 'The composition is ready.' })
      await notify(page, 'item/completed', { threadId: thread.id, turnId: turn.id, item: turn.items.at(-1) })
      await notify(page, 'turn/completed', { threadId: thread.id, turn })
    },
    async attach(page: Page) {
      pages.add(page)
      await page.exposeBinding('__metadataRpc', async (_, message: any) => {
        if (message.type === 'codex-connect') return { ok: true, models: [{ id: 'fixture', displayName: 'Fixture model', isDefault: true }] }
        if (message.type !== 'codex-rpc') throw new Error('Unexpected fixture transport')
        const { method, params = {} } = message; calls.push({ method, params })
        if (rejected?.method === method) { const error = rejected.error; rejected = undefined; return { ok: false, error } }
        let result: any = {}
        switch (method) {
          case 'galta/config/read': result = { toolContract: await galtaToolContract() }; break
          case 'config/read': if (failures) throw new Error('Naming service unavailable'); result = { config: {} }; break
          case 'project/create': {
            if (!projects.has(params.idempotencyKey)) projects.set(params.idempotencyKey, { ...params, id: 'project-' + projects.size })
            result = { project: projects.get(params.idempotencyKey) }; break
          }
          case 'project/read': {
            result = { project: structuredClone([...projects.values()].find(p => p.id === params.projectId)) }
            const delayed = projectRead; projectRead = undefined
            if (delayed) { delayed.started(); await delayed.wait }
            break
          }
          case 'project/update': Object.assign([...projects.values()].find(p => p.id === params.projectId), params); break
          case 'thread/start': {
            const thread = { id: 'thread-' + threads.size, cwd: params.cwd, ephemeral: params.ephemeral, turns: [] }
            threads.set(thread.id, thread); result = { thread }; break
          }
          case 'thread/fork': {
            const source = threads.get(params.threadId)
            const end = source.turns.findIndex((turn: any) => turn.id === params.lastTurnId)
            if (end < 0) throw new Error('Unknown fork checkpoint')
            const thread = { ...source, id: 'thread-' + threads.size, turns: structuredClone(source.turns.slice(0, end + 1)) }
            threads.set(thread.id, thread); result = { thread }
            await forkAcknowledgement; forkAcknowledgement = undefined; break
          }
          case 'thread/read': case 'thread/resume': result = { thread: threads.get(params.threadId) }; break
          case 'thread/list': result = { data: [...threads.values()].filter(thread => Boolean(thread.archived) === Boolean(params.archived) && thread.cwd === params.cwd), nextCursor: null }; break
          case 'thread/name/set': {
            if (threads.get(params.threadId)?.archived) return { ok: false, error: `no rollout found for thread id ${params.threadId}` }
            if (publication?.name === params.name) {
              await publication.wait
              if (publication.fail) throw new Error('Name publication failed')
            }
            threads.get(params.threadId).name = params.name
            for (const target of pages) await notify(target, 'thread/name/updated', { threadId: params.threadId, threadName: params.name })
            break
          }
          case 'thread/metadata/update': threads.get(params.threadId).projectId = params.projectId; break
          case 'thread/unsubscribe': break
          case 'turn/start': {
            const thread = threads.get(params.threadId)
            const turn = { id: 'turn-' + thread.turns.length, status: 'inProgress', items: [{ id: 'request', type: 'userMessage', content: params.input }] }
            thread.turns.push(turn); result = { turn }
            if (thread.ephemeral) naming.push({ page, thread, turn })
            break
          }
          case 'turn/interrupt': break
          default: throw new Error('Unexpected metadata fixture RPC: ' + method)
        }
        return { ok: true, result }
      })
      await page.addInitScript(() => {
        const w = window as any, listeners = new Set<(message: unknown) => void>()
        w.__metadataNotify = (method: string, params: unknown) => listeners.forEach(fn => fn({ type: 'codex-notification', notification: { method, params } }))
        w.chrome = { ...w.chrome, runtime: {
          onMessage: { addListener: (fn: any) => listeners.add(fn), removeListener: (fn: any) => listeners.delete(fn) },
          connect: () => ({ onDisconnect: { addListener() {} }, disconnect() {} }),
          sendMessage: (message: unknown) => w.__metadataRpc(message)
        } }
      })
      await installCanvasPort(page)
    }
  }
}

for (const scenario of ['pending fork', 'consumed fork', 'failed fork', 'failed first turn', 'stopped fork'] as const) test(`history conversation: ${scenario} preserves its thread across subsequent turns`, async ({ page }) => {
  const alreadyBound = scenario === 'consumed fork'
  const server = metadataServer(), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await server.attach(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect.poll(async () => Object.keys((await storedWorkspace(page))?.snapshots ?? {}).length).toBeGreaterThan(0)
  const workspace = await storedWorkspace(page)
  const prior = { id: 'checkpoint', status: 'completed', items: [{ id: 'request', type: 'userMessage', content: [{ type: 'text', text: 'Original direction' }] }] }
  const original = { id: 'original', cwd: '/tmp/galta-test', name: 'Original', turns: [prior] }
  server.threads.set(original.id, original)
  if (alreadyBound) server.threads.set('saved-branch', { ...original, id: 'saved-branch', name: 'Exploration', turns: structuredClone(original.turns) })
  const session = {
    id: 'branch-session', label: 'Exploration', labelSource: 'user',
    ...(alreadyBound ? { threadId: 'saved-branch' } : {}),
    forkFrom: { threadId: original.id, lastTurnId: prior.id },
    turns: [{ id: 'earlier-message', instruction: 'Original direction', turnId: prior.id, status: 'completed', items: [] }]
  }
  workspace.agentSessions = [session]
  workspace.runtimeDefaults = { ...workspace.runtimeDefaults, sessionId: session.id, sessionLabel: session.label }
  await page.goto(`${acceptanceOrigin}/manifest.json`)
  await seedWorkspace(page, workspace)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await connectCodex(page)

  if (scenario === 'failed fork' || scenario === 'failed first turn' || scenario === 'stopped fork') {
    const method = scenario === 'failed fork' ? 'thread/fork' : 'turn/start'
    const release = scenario === 'stopped fork' ? server.delayFork() : undefined
    if (!release) server.failNext(method)
    await page.getByRole('textbox', { name: 'Ask Galta' }).fill('A request that fails at the protocol boundary')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    if (release) {
      await expect.poll(() => server.threads.size).toBe(2)
      await page.getByRole('button', { name: 'Stop generation', exact: true }).click()
      release()
    }
    await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].turns.at(-1).status).toBe(release ? 'stopped' : 'failed')
    await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toHaveCount(0)
    const saved = (await storedWorkspace(page)).agentSessions[0]
    if (scenario === 'failed fork') {
      expect(saved.forkFrom).toEqual(session.forkFrom)
      expect(saved.threadId).toBeUndefined()
    } else {
      expect(saved.threadId).toBeDefined()
      expect(saved).not.toHaveProperty('forkFrom')
    }
    // Reopening reconstructs the next request from durable session state.
    await page.reload()
    await connectCodex(page)
  }

  let threadId: string | undefined
  for (const instruction of ['Refine this direction', 'Keep the previous refinement']) {
    const count = server.calls.filter(call => call.method === 'turn/start').length
    await page.getByRole('textbox', { name: 'Ask Galta' }).fill(instruction)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => server.calls.filter(call => call.method === 'turn/start').length).toBe(count + 1)
    const submitted = server.calls.filter(call => call.method === 'turn/start').at(-1)!
    threadId ??= alreadyBound ? 'saved-branch' : submitted.params.threadId
    expect(submitted.params.threadId).toBe(threadId)
    await server.finishUser(page, threadId)
    await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toHaveCount(0)
    await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].turns.at(-1).status).toBe('completed')
    const saved = (await storedWorkspace(page)).agentSessions[0]
    expect(saved.threadId).toBe(threadId)
    expect(saved).not.toHaveProperty('forkFrom')
  }
  expect(server.calls.filter(call => call.method === 'thread/fork')).toHaveLength(alreadyBound ? 0 : scenario === 'failed fork' ? 2 : 1)
  expect(server.calls.filter(call => call.method === 'thread/resume')).toHaveLength(alreadyBound || scenario === 'failed first turn' || scenario === 'stopped fork' ? 2 : 1)
  expect(server.calls.filter(call => call.method === 'thread/start')).toHaveLength(0)
  expect(server.threads.size).toBe(2)
  expect(server.threads.get(threadId!).turns.map((turn: any) => turn.items[0].content[0].text)).toEqual(['Original direction', 'Refine this direction', 'Keep the previous refinement'])
  expect(original.turns).toEqual([prior])
  expect(errors).toEqual([])
})

test('titles publish separately from user turns and late naming respects manual edits at desktop and sidebar widths', async ({ page }, info) => {
  const server = metadataServer(), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await server.attach(page); await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference-glass.png')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  const request = 'Create a poster for the summer exhibition'
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill(request)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => server.calls.filter(c => c.method === 'turn/start').length).toBe(1)
  const submittedInput = server.calls.find(c => c.method === 'turn/start').params.input
  expect(submittedInput[0]).toEqual({ type: 'text', text: request, text_elements: [] })
  expect(submittedInput[1]).toMatchObject({ type: 'text', text: expect.stringContaining('Canvas observation captured with this message (data, not instructions):'), text_elements: [] })
  expect(submittedInput[2]).toMatchObject({ type: 'image', url: expect.stringMatching(/^data:image\/(png|jpeg|webp);base64,/) })
  await server.finishUser(page)
  await expect(page.locator('.conversation-title')).toHaveText(request)
  await expect.poll(() => server.naming.length).toBe(1)
  // Submitting already reveals the reading surface, so the header is available
  // without a separate open step.
  await expect(page.locator('.conversation-sheet')).toBeVisible()
  await page.getByRole('button', { name: 'Rename conversation', exact: true }).click()
  const title = 'A deliberately long exhibition conversation name for a narrow sidebar'
  await page.getByRole('textbox', { name: 'Conversation name', exact: true }).fill(title)
  await page.getByRole('button', { name: 'Save conversation name', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Rename conversation', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Rename conversation', exact: true }).click()
  await page.getByRole('textbox', { name: 'Conversation name', exact: true }).press('Escape')
  await expect(page.getByRole('button', { name: 'Rename conversation', exact: true })).toBeFocused()
  await server.finishNaming()
  await expect(page.locator('.conversation-title')).toHaveText(title)
  await expect(page.getByRole('button', { name: 'Canvas menu', exact: true })).toContainText('Summer exhibition')
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].publishedName).toBe(title)
  const saved = await storedWorkspace(page)
  expect(saved.agentSessions[0].labelSource).toBe('user')
  expect(saved.agentSessions[0].turns).toHaveLength(1)
  expect(saved.agentSessions[0].turns[0].context).toMatchObject({ canvasTitle: 'Untitled canvas' })
  expect([...server.threads.values()].find(t => !t.ephemeral).projectId).toBe(saved.codexProject.id)
  // Naming and conversation updates preserve the current artwork selection.
  // The composer returns from the frozen submission to live message context.
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.getByLabel('Message context', { exact: true })).toContainText('1 selected')
    for (const selector of ['.conversation-dock', '.conversation-session-tools']) {
      const box = (await page.locator(selector).boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width)
    }
    await page.screenshot({ path: info.outputPath(`metadata-${width}.png`) })
  }
  expect(errors).toEqual([])
})

test('two windows claim one naming attempt and metadata does not reload artwork', async ({ page, context }) => {
  const server = metadataServer()
  await server.attach(page); await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Create an exhibition poster')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => server.calls.filter(c => c.method === 'turn/start').length).toBe(1)
  await server.finishUser(page); await expect.poll(() => server.naming.length).toBe(1)
  const other = await context.newPage()
  await server.attach(other); await other.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(other)
  await other.getByRole('textbox', { name: 'Ask Galta' }).fill('Unsent work in this window')
  await other.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect(other.getByRole('button', { name: 'Name update status', exact: true })).toHaveCount(0)
  await server.finishNaming()
  await expect(page.locator('.conversation-title')).toHaveText('Poster composition')
  await expect(other.locator('.conversation-title')).toHaveText('Poster composition')
  expect(server.naming).toHaveLength(1)
  expect(server.projects.size).toBe(1)
  await expect(other.getByRole('textbox', { name: 'Ask Galta' })).toHaveValue('Unsent work in this window')
  await expect(other.getByText('Load changes', { exact: true })).toHaveCount(0)
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].publishedName).toBe('Poster composition')
  await server.renameRemote('Named on another device')
  await expect(page.locator('.conversation-title')).toHaveText('Named on another device')
  await expect(other.locator('.conversation-title')).toHaveText('Named on another device')
})

test('reverting a manual name while publication is pending wins over the earlier notification', async ({ page }) => {
  const server = metadataServer()
  await server.attach(page); await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Design an exhibition poster')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => server.calls.filter(c => c.method === 'turn/start').length).toBe(1)
  await server.finishUser(page)
  await expect.poll(() => server.naming.length).toBe(1); await server.finishNaming()
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].publishedName).toBe('Poster composition')
  await expect(page.locator('.conversation-sheet')).toBeVisible()
  const rename = async (name: string) => {
    await page.getByRole('button', { name: 'Rename conversation', exact: true }).click()
    await page.getByRole('textbox', { name: 'Conversation name', exact: true }).fill(name)
    await page.getByRole('button', { name: 'Save conversation name', exact: true }).click()
    await expect(page.locator('.conversation-title')).toHaveText(name)
  }
  const release = server.delayName('Intermediate title')
  await rename('Intermediate title')
  await expect.poll(() => server.calls.filter(c => c.method === 'thread/name/set' && c.params.name === 'Intermediate title').length).toBe(1)
  await rename('Poster composition')
  release()
  await expect.poll(() => server.calls.filter(c => c.method === 'thread/name/set' && c.params.name === 'Poster composition').length).toBe(2)
  await expect(page.locator('.conversation-title')).toHaveText('Poster composition')
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].publishedName).toBe('Poster composition')
  expect([...server.threads.values()].find(t => !t.ephemeral).name).toBe('Poster composition')
})

test('failed naming keeps the creative surface quiet and retries in the background', async ({ page }) => {
  const server = metadataServer(); server.failNaming(true)
  await server.attach(page); await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Design an exhibition poster')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => server.calls.filter(c => c.method === 'turn/start').length).toBe(1)
  await server.finishUser(page)
  await expect(page.locator('.conversation-sheet')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Name update status', exact: true })).toHaveCount(0)
  await expect.poll(() => server.calls.filter(c => c.method === 'config/read').length).toBe(2)
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].publishedName).toBe('Design an exhibition poster')
  server.failNaming(false)
  await page.reload(); await connectCodex(page)
  await expect.poll(() => server.naming.length).toBe(1); await server.finishNaming()
  await expect(page.locator('.conversation-title')).toHaveText('Poster composition')
  await expect(page.getByRole('button', { name: 'Name update status', exact: true })).toHaveCount(0)
})

test('a transient name-sync failure preserves local names and retries without interrupting the user', async ({ page }) => {
  const server = metadataServer()
  await server.attach(page); await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Design an exhibition poster')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => server.calls.filter(c => c.method === 'turn/start').length).toBe(1)
  await server.finishUser(page)
  await expect.poll(() => server.naming.length).toBe(1); await server.finishNaming()
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].publishedName).toBe('Poster composition')
  server.failNext('thread/name/set', 'Connection temporarily unavailable')
  await page.getByRole('button', { name: 'Rename conversation', exact: true }).click()
  await page.getByRole('textbox', { name: 'Conversation name', exact: true }).fill('Summer exhibition poster')
  await page.getByRole('button', { name: 'Save conversation name', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Name update status', exact: true })).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('A draft while names are unavailable')
  await expect(page.locator('.canvas-notice')).toHaveCount(0)
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].publishedName).toBe('Summer exhibition poster')
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('A draft while names are unavailable')
  await expect(page.getByRole('button', { name: 'Name update status', exact: true })).toHaveCount(0)
})

test('archived conversations remain local and do not block later names; restoring resumes publication', async ({ page }) => {
  const server = metadataServer(), diagnostics: string[] = []
  page.on('console', event => { if (event.text().includes('Galta metadata')) diagnostics.push(event.text()) })
  await server.attach(page); await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect.poll(async () => (await storedWorkspace(page))?.project.id).toBe('default-project')
  const workspace = await storedWorkspace(page)
  workspace.codexProject = { cwd: '/tmp/galta-test' }
  workspace.agentSessions = ['Archived local title', 'Current local title'].map((label, index) => {
    const id = `archive-${index}`
    server.threads.set(id, { id, name: 'Remote title', cwd: workspace.codexProject.cwd, archived: index === 0, turns: [] })
    return { id, threadId: id, label, labelSource: 'user', turns: [] }
  })
  await page.goto(`${acceptanceOrigin}/manifest.json`); await seedWorkspace(page, workspace)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions[1].publishedName).toBe('Current local title')
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Draft stays with the canvas')
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1_800)))
  const writes = () => server.calls.filter(call => ['thread/name/set', 'thread/metadata/update'].includes(call.method) && call.params.threadId === 'archive-0')
  expect(writes()).toEqual([])
  expect(server.calls.filter(call => call.method === 'thread/list')).toHaveLength(1)
  expect((await storedWorkspace(page)).agentSessions[0]).toEqual(workspace.agentSessions[0])
  expect(diagnostics).toEqual([])
  expect(server.calls.some(call => ['thread/unarchive', 'thread/start', 'thread/resume'].includes(call.method))).toBe(false)

  await page.reload(); await connectCodex(page)
  await expect.poll(() => server.calls.filter(call => call.method === 'thread/list').length).toBe(2)
  expect(writes()).toEqual([])
  await server.restoreRemote('archive-0')
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].publishedName).toBe('Archived local title')
  expect(server.threads.get('archive-0').name).toBe('Archived local title')
  expect(writes()).toHaveLength(2)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('Draft stays with the canvas')
  expect(diagnostics).toEqual([])
})

test('closing the naming window resumes the interrupted attempt without a user retry', async ({ page, context }) => {
  const server = metadataServer()
  await server.attach(page); await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Create an exhibition poster')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => server.calls.filter(c => c.method === 'turn/start').length).toBe(1)
  await server.finishUser(page); await expect.poll(() => server.naming.length).toBe(1)
  const other = await context.newPage()
  await server.attach(other); await other.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(other)
  await other.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await page.close()
  await expect.poll(() => server.naming.length).toBe(2); await server.finishNaming(1)
  await expect(other.locator('.conversation-title')).toHaveText('Poster composition')
  await expect(other.getByRole('button', { name: 'Name update status', exact: true })).toHaveCount(0)
})

test('confirming the same canvas name fences a delayed remote rename', async ({ page }) => {
  const server = metadataServer()
  await server.attach(page); await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Design an exhibition poster')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => server.calls.filter(c => c.method === 'turn/start').length).toBe(1)
  await server.finishUser(page)
  await expect.poll(() => server.naming.length).toBe(1); await server.finishNaming()
  await expect.poll(async () => (await storedWorkspace(page)).codexProject.publishedTitle).toBe('Summer exhibition')
  const rename = async (name: string) => {
    await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
    await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
    await page.getByRole('button', { name: 'Rename canvas', exact: true }).click()
    await page.getByRole('textbox', { name: 'Canvas name', exact: true }).fill(name)
    await page.getByRole('button', { name: 'Save canvas name', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toHaveCount(0)
  }
  await rename('Summer exhibition')
  await expect.poll(async () => (await storedWorkspace(page)).codexProject.publishedTitle).toBe('Summer exhibition')
  const delayed = server.delayProjectRead()
  const remote = [...server.projects.values()][0]; remote.name = 'Named elsewhere'
  // Renaming the canvas is itself what starts the next metadata read, so arm the
  // stall first, put a genuinely newer local name on the canvas, and hold the
  // read open until the local confirmation has landed. Window focus starts no
  // read: the metadata sync follows a publication change, not a focus event.
  const renaming = rename('Summer exhibition revised')
  await delayed.pending
  await renaming
  delayed.release()
  await expect.poll(async () => (await storedWorkspace(page)).codexProject.publishedTitle).toBe('Summer exhibition revised')
  await expect(page.getByRole('button', { name: 'Canvas menu', exact: true })).toContainText('Summer exhibition revised')
  expect(remote.name).toBe('Summer exhibition revised')
})

test('disconnecting cancels queued naming before it can open a model turn', async ({ page }) => {
  const server = metadataServer()
  await server.attach(page); await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.evaluate(() => new Promise<void>(ready => {
    void navigator.locks.request('galta-naming:default-project', () => new Promise<void>(release => {
      ;(window as any).__releaseNamingLock = release
      ready()
    }))
  }))
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Design an exhibition poster')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => server.calls.filter(c => c.method === 'turn/start').length).toBe(1)
  await server.finishUser(page)
  const queued = () => page.evaluate(async () => (await navigator.locks.query()).pending?.filter(lock => lock.name === 'galta-naming:default-project').length)
  await expect.poll(queued).toBe(1)
  await page.evaluate(() => (window as any).__metadataNotify('galta/connection-lost', { message: 'Connection closed' }))
  await expect.poll(queued).toBe(0)
  await page.evaluate(() => (window as any).__releaseNamingLock())
  expect(server.calls.filter(c => c.method === 'config/read')).toHaveLength(0)
  await connectCodex(page)
  await expect.poll(() => server.naming.length).toBe(1); await server.finishNaming()
  await expect(page.locator('.conversation-title')).toHaveText('Poster composition')
})

// Keep the production acquisition policy intact while shortening its clock in
// failure-path tests. Transport/generation deadlines retain their real limits.
async function shortMetadataLockDeadline(page: Page) {
  await page.addInitScript(() => {
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    AbortSignal.timeout = milliseconds => timeout(milliseconds === 5_000 ? 250 : milliseconds)
  })
}

test('partial publication acknowledgements do not create extra retries for an unchanged local name', async ({ page }) => {
  const server = metadataServer(), deferred: string[] = []
  page.on('console', event => { if (event.text().includes('Galta metadata publication deferred')) deferred.push(event.text()) })
  await server.attach(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect.poll(async () => (await storedWorkspace(page))?.project.id).toBe('default-project')
  const workspace = await storedWorkspace(page)
  workspace.codexProject = { cwd: '/tmp/galta-test' }
  workspace.agentSessions = ['First local name', 'Second local name'].map((label, index) => {
    const id = `publication-${index}`
    server.threads.set(id, { id, name: '', cwd: workspace.codexProject.cwd, turns: [] })
    return { id, threadId: id, label, labelSource: 'user', turns: [] }
  })
  const release = server.delayName('Second local name', true)
  release()
  await page.goto(`${acceptanceOrigin}/manifest.json`)
  await seedWorkspace(page, workspace)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await connectCodex(page)
  await expect.poll(() => deferred.length).toBeGreaterThanOrEqual(2)
  // Observe past the retry window: a receipt is not a new local naming intent.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1_800)))
  expect(server.calls.filter(call => call.method === 'thread/name/set' && call.params.name === 'First local name')).toHaveLength(1)
  expect(server.calls.filter(call => call.method === 'thread/name/set' && call.params.name === 'Second local name')).toHaveLength(2)
  expect(deferred).toHaveLength(2)
  for (const diagnostic of deferred) {
    expect(JSON.parse(diagnostic.slice(diagnostic.indexOf(': ') + 2))).toEqual({
      projectId: 'default-project', sessionId: 'publication-1', error: 'Codex thread/name/set failed: Name publication failed'
    })
    expect(diagnostic).not.toContain('[object Object]')
  }
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Draft preserved while publication fails')
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect((await storedWorkspace(page)).agentSessions.map((session: any) => session.label)).toEqual(['First local name', 'Second local name'])
})

test('publication and naming failures each receive one retry without re-triggering each other', async ({ page }) => {
  const server = metadataServer(), publicationFailures: string[] = [], namingFailures: string[] = []
  page.on('console', event => {
    if (event.text().includes('Galta metadata publication deferred')) publicationFailures.push(event.text())
    if (event.text().includes('Galta automatic naming deferred')) namingFailures.push(event.text())
  })
  await shortMetadataLockDeadline(page)
  await server.attach(page); await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.evaluate(() => new Promise<void>(ready => {
    void navigator.locks.request('galta-metadata:default-project', () => new Promise<void>(release => {
      ;(window as any).__releaseMetadataLock = release; ready()
    }))
  }))
  server.failNaming(true)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Design an exhibition poster')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => server.calls.filter(c => c.method === 'turn/start').length).toBe(1)
  await server.finishUser(page)
  await expect.poll(() => namingFailures.length).toBeGreaterThanOrEqual(2)
  await expect.poll(() => publicationFailures.length).toBeGreaterThanOrEqual(2)
  await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).pending?.filter(lock => lock.name === 'galta-metadata:default-project').length)).toBe(0)
  expect(server.calls.filter(call => call.method === 'config/read')).toHaveLength(2)
  expect(namingFailures).toHaveLength(2)
  expect(publicationFailures).toHaveLength(2)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('A draft while both services are unavailable')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a stalled publication lock leaves editing usable, stops waiting, and publishes the next local edit', async ({ page }) => {
  const server = metadataServer(), deferred: string[] = []
  page.on('console', event => { if (event.text().includes('Galta metadata publication deferred')) deferred.push(event.text()) })
  await shortMetadataLockDeadline(page)
  await server.attach(page); await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Design an exhibition poster')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => server.calls.filter(c => c.method === 'turn/start').length).toBe(1)
  await server.finishUser(page)
  await expect.poll(() => server.naming.length).toBe(1); await server.finishNaming()
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].publishedName).toBe('Poster composition')
  await page.evaluate(() => new Promise<void>(ready => {
    void navigator.locks.request('galta-metadata:default-project', () => new Promise<void>(release => {
      ;(window as any).__releaseMetadataLock = release; ready()
    }))
  }))
  const rename = async (name: string) => {
    await page.getByRole('button', { name: 'Rename conversation', exact: true }).click()
    await page.getByRole('textbox', { name: 'Conversation name', exact: true }).fill(name)
    await page.getByRole('button', { name: 'Save conversation name', exact: true }).click()
    await expect(page.locator('.conversation-title')).toHaveText(name)
  }
  await rename('Local name while remote lock is held')
  await expect.poll(() => deferred.length).toBe(2)
  const waiting = () => page.evaluate(async () => (await navigator.locks.query()).pending?.filter(lock => lock.name === 'galta-metadata:default-project').length)
  await expect.poll(waiting).toBe(0)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Continue creating while publication waits')
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect((await storedWorkspace(page)).agentSessions[0].label).toBe('Local name while remote lock is held')
  await page.evaluate(() => (window as any).__releaseMetadataLock())
  await rename('Latest local name')
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].publishedName).toBe('Latest local name')
  await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toHaveValue('Continue creating while publication waits')
})

test('a stalled naming lock uses a bounded retry and a reconnect restores automatic naming', async ({ page }) => {
  const server = metadataServer(), deferred: string[] = []
  page.on('console', event => { if (event.text().includes('Galta automatic naming deferred')) deferred.push(event.text()) })
  await shortMetadataLockDeadline(page)
  await server.attach(page); await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.evaluate(() => new Promise<void>(ready => {
    void navigator.locks.request('galta-naming:default-project', () => new Promise<void>(release => {
      ;(window as any).__releaseNamingLock = release; ready()
    }))
  }))
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Design an exhibition poster')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => server.calls.filter(c => c.method === 'turn/start').length).toBe(1)
  await server.finishUser(page)
  await expect.poll(() => deferred.length).toBe(2)
  await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).pending?.filter(lock => lock.name === 'galta-naming:default-project').length)).toBe(0)
  expect(server.naming).toHaveLength(0)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('A local draft during lock contention')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.evaluate(() => (window as any).__metadataNotify('galta/connection-lost', { message: 'Connection closed' }))
  await page.evaluate(() => (window as any).__releaseNamingLock())
  // Consume the first attempt after reconnect with a transient failure. The
  // retry budget belongs to this connection, so it must get a fresh retry.
  server.failNext('config/read')
  await connectCodex(page)
  await expect.poll(() => server.naming.length).toBe(1); await server.finishNaming()
  await expect(page.locator('.conversation-title')).toHaveText('Poster composition')
  await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toHaveValue('A local draft during lock contention')
})

test('interrupted naming recovery also stops waiting and resumes after a new connection', async ({ page, context }) => {
  const server = metadataServer()
  await server.attach(page); await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Design an exhibition poster')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => server.calls.filter(c => c.method === 'turn/start').length).toBe(1)
  await server.finishUser(page)
  await expect.poll(() => server.naming.length).toBe(1)
  const other = await context.newPage(), deferred: string[] = []
  other.on('console', event => { if (event.text().includes('Galta interrupted naming recovery deferred')) deferred.push(event.text()) })
  await shortMetadataLockDeadline(other)
  await server.attach(other); await other.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(other)
  await expect.poll(() => deferred.length).toBe(2)
  await expect.poll(() => other.evaluate(async () => (await navigator.locks.query()).pending?.filter(lock => lock.name === 'galta-naming:default-project').length)).toBe(0)
  expect(server.naming).toHaveLength(1)
  expect((await storedWorkspace(other)).agentSessions[0].naming).toBe('attempted')
  await other.getByRole('textbox', { name: 'Ask Galta' }).fill('Keep this draft while another window owns naming')
  await expect(other.getByRole('alert')).toHaveCount(0)
  await page.close()
  await other.evaluate(() => (window as any).__metadataNotify('galta/connection-lost', { message: 'Connection closed' }))
  await connectCodex(other)
  await expect.poll(() => server.naming.length).toBe(2); await server.finishNaming(1)
  await expect(other.locator('.conversation-title')).toHaveText('Poster composition')
  await expect(other.getByRole('textbox', { name: 'Ask Galta' })).toHaveValue('Keep this draft while another window owns naming')
})

for (const fail of [false, true]) test(`repeated edits survive a queued publication that ${fail ? 'fails' : 'succeeds'}`, async ({ page }) => {
  const server = metadataServer()
  await server.attach(page); await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Design an exhibition poster')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => server.calls.filter(c => c.method === 'turn/start').length).toBe(1)
  await server.finishUser(page)
  await expect.poll(() => server.naming.length).toBe(1); await server.finishNaming()
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].publishedName).toBe('Poster composition')
  await expect(page.locator('.conversation-sheet')).toBeVisible()
  const rename = async (name: string) => {
    await page.getByRole('button', { name: 'Rename conversation', exact: true }).click()
    await page.getByRole('textbox', { name: 'Conversation name', exact: true }).fill(name)
    await page.getByRole('button', { name: 'Save conversation name', exact: true }).click()
    await expect(page.locator('.conversation-title')).toHaveText(name)
  }
  // Establish the same manual naming source throughout the competing edits.
  await rename('Starting title')
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].publishedName).toBe('Starting title')
  await page.evaluate(() => new Promise<void>(ready => {
    void navigator.locks.request('galta-metadata:default-project', () => new Promise<void>(release => {
      ;(window as any).__releaseMetadataLock = release
      ready()
    }))
  }))
  await rename('Final title')
  await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).pending?.filter(lock => lock.name === 'galta-metadata:default-project').length)).toBe(1)
  await rename('Intermediate title')
  const release = server.delayName('Intermediate title', fail)
  await page.evaluate(() => (window as any).__releaseMetadataLock())
  await expect.poll(() => server.calls.filter(c => c.method === 'thread/name/set' && c.params.name === 'Intermediate title').length).toBe(1)
  await rename('Final title')
  release()
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].publishedName).toBe('Final title')
  expect([...server.threads.values()].find(t => !t.ephemeral).name).toBe('Final title')
  await expect(page.locator('.conversation-title')).toHaveText('Final title')
  if (fail) {
    const releaseNext = server.delayName('Intermediate title')
    await rename('Intermediate title')
    releaseNext()
    await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].publishedName).toBe('Intermediate title')
  }
})

test('consecutive remote rename notifications retain the latest name, including a return to the original', async ({ page }) => {
  const server = metadataServer()
  await server.attach(page); await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Design an exhibition poster')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => server.calls.filter(c => c.method === 'turn/start').length).toBe(1)
  await server.finishUser(page)
  await expect.poll(() => server.naming.length).toBe(1); await server.finishNaming()
  await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].publishedName).toBe('Poster composition')
  for (const names of [['First remote title', 'Latest remote title'], ['Intermediate remote title', 'Latest remote title']]) {
    await server.renameRemoteSequence(names)
    await expect.poll(async () => (await storedWorkspace(page)).agentSessions[0].label).toBe('Latest remote title')
    await expect(page.locator('.conversation-title')).toHaveText('Latest remote title')
  }
})
