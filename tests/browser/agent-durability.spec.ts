import { storedWorkspace } from '../helpers/stored-workspace'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { test, expect, type Page } from '@playwright/test'
import { installCanvasPort, connectCodex } from '../helpers/canvas-port'
import { brushBase, brushOperations } from '../helpers/brush-workload'
import { CANVAS_MESSAGE_LABEL } from '../../packages/canvas/src/message'

// Deterministic native-message fixture for storage races. It does not certify
// a model/provider; the separate live acceptance exercises actual Codex.
async function controlledCodex(page: Page) {
  await page.addInitScript(() => {
    const w = window as any, listeners = new Set<(message: unknown) => void>()
    const thread = JSON.parse(sessionStorage.getItem('durability-thread') ?? '{"id":"durability-thread","turns":[]}')
    const notify = (notification: any) => { for (const listener of listeners) listener({ type: 'codex-notification', notification }) }
    const finish = (status = 'completed') => {
      const turn = thread.turns.at(-1)
      turn.status = status
      sessionStorage.setItem('durability-thread', JSON.stringify(thread))
      notify({ method: 'turn/completed', params: { threadId: thread.id, turn } })
    }
    w.durability = {
      active: false, interrupts: 0, connections: 0, calls: [], finish,
      call(tool: string, args: unknown) {
        return w.__canvasToolCall(tool, args)
      },
      holdSave(mode: string) {
        const put = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
          if (this.name !== 'workspaces' || !Object.values(value?.project?.commits ?? {}).some((commit: any) => commit.source === 'agent')) return put.call(this, value, key!)
          IDBObjectStore.prototype.put = put
          const tx = this.transaction
          if (mode === 'failure') {
            const aborted = tx.onabort!
            tx.onabort = event => { w.durability.held = true; w.durability.release = () => aborted.call(tx, event) }
            throw new DOMException('Agent save test', 'QuotaExceededError')
          }
          const complete = tx.oncomplete!
          tx.oncomplete = event => { w.durability.held = true; w.durability.release = () => complete.call(tx, event) }
          if (mode === 'activation-failure') IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
            if (this.name === 'workspaces' && value?.project?.commits[value.project.headCommitId]?.source === 'agent') {
              IDBObjectStore.prototype.put = put
              throw new DOMException('Activation save test', 'QuotaExceededError')
            }
            return put.call(this, value, key!)
          }
          return put.call(this, value, key!)
        }
      }
    }
    Object.assign(window, { chrome: { ...(window as any).chrome,
      windows: { getCurrent: async () => ({ id: 1 }) },
      storage: {
        session: { get: async () => ({}) },
        local: {
          get: async () => JSON.parse(sessionStorage.getItem('durability-preferences') ?? '{}'),
          set: async (value: any) => { sessionStorage.setItem('durability-preferences', JSON.stringify({ ...JSON.parse(sessionStorage.getItem('durability-preferences') ?? '{}'), ...value })) }
        }
      }, runtime: {
      onMessage: { addListener: (listener: any) => listeners.add(listener), removeListener: (listener: any) => listeners.delete(listener) },
      connect: () => ({ onDisconnect: { addListener() {} }, disconnect() {} }),
      async sendMessage(message: any) {
        if (message.type === 'codex-connect') { w.durability.connections++; return { ok: true, models: [{ id: 'gpt-5.6-sol', displayName: 'Test model', isDefault: true }] } }
        if (message.type === 'codex-respond') throw new Error('Unexpected dynamic tool response')
        if (message.type !== 'codex-rpc') throw new Error(`Unexpected message ${message.type}`)
        w.durability.calls.push({ method: message.method, params: message.params })
        let result: any = {}
        switch (message.method) {
          case 'galta/config/read': result = { toolContract: (window as any).__galtaToolContract }; break
          case 'thread/start': case 'thread/resume': case 'thread/read': result = { thread }; break
          case 'thread/name/set': break
          case 'turn/start': {
            w.durability.input = message.params.input
            const turn = { id: `turn-${thread.turns.length + 1}`, status: 'inProgress', items: [] }
            thread.turns.push(turn); result = { turn }; w.durability.active = true
            notify({ method: 'turn/started', params: { threadId: thread.id, turn } }); break
          }
          case 'turn/interrupt': w.durability.interrupts++; finish('interrupted'); break
          default: throw new Error(`Unexpected RPC ${message.method}`)
        }
        return { ok: true, result }
      }
    } } })
  })
  await installCanvasPort(page)
}
const workspace = storedWorkspace
function document(bundle: any) { return bundle.snapshots[bundle.project.headCommitId].document }
async function draw(page: Page, x: number) {
  await page.getByRole('button', { name: 'Draw — P', exact: true }).click()
  await page.mouse.move(x, 200); await page.mouse.down(); await page.mouse.move(x + 100, 320, { steps: 12 }); await page.mouse.up()
}

test('composer submissions carry unselected drawings, durable per-conversation changes and unchanged previews through reload', async ({ page }, info) => {
  await controlledCodex(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await connectCodex(page)
  const submit = async (instruction: string) => {
    await page.evaluate(() => { (window as any).durability.active = false })
    await page.getByRole('textbox', { name: 'Ask Galta' }).fill(instruction)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.waitForFunction(() => (window as any).durability.active)
    return page.evaluate(label => {
      const parts = (window as any).durability.input
      return { text: parts[0].text, context: JSON.parse(parts.find((part: any) => part.type === 'text' && part.text.startsWith(label)).text.slice(label.length)), imageCount: parts.filter((part: any) => part.type === 'image').length }
    }, CANVAS_MESSAGE_LABEL)
  }
  const finish = async () => {
    await page.evaluate(() => (window as any).durability.finish())
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible()
  }
  await draw(page, 200)
  const first = await submit('What do you think?')
  expect(first.text).toBe('What do you think?')
  expect(first.context.selection.total).toBe(0)
  expect(first.context.visible.items.some((item: any) => item.kind === 'draw')).toBe(true)
  expect(first.context.changes.status).toBe('initial')
  expect(first.context.preview.status).toBe('attached')
  expect(first.imageCount).toBe(1)
  await page.evaluate(async () => {
    const d = (window as any).durability
    const read = (await d.call('canvas_inspect', {})).structuredContent
    const result = await d.call('canvas_edit', { revision: read.revision, operations: [{ type: 'create_text', id: 'agent-note', text: 'A composition note', x: 400, y: 350 }] })
    if (result.isError) throw new Error(result.content[0].text)
  })
  await finish()
  await draw(page, 650)
  const second = await submit('And now?')
  const versions = await workspace(page)
  const before = versions.snapshots[first.context.commitId].document.elements
  const after = versions.snapshots[second.context.commitId].document.elements
  const changedFields = before.map((element: any) => {
    const next = after.find((item: any) => item.id === element.id)
    return { id: element.id, fields: Object.fromEntries([...new Set([...Object.keys(element), ...Object.keys(next ?? {})])].filter(key => JSON.stringify(element[key]) !== JSON.stringify(next?.[key])).map(key => [key, { before: element[key], after: next?.[key] }])) }
  })
  await info.attach('observation-diff.json', { body: JSON.stringify({ first, second, changedFields }, null, 2), contentType: 'application/json' })
  expect(second.context.changes, JSON.stringify(changedFields)).toMatchObject({ since: first.context.commitId, status: 'compared', total: 2 })
  expect(second.context.changes.items).toContainEqual({ id: 'agent-note', change: 'created', sources: ['agent'] })
  expect(second.context.changes.items.some((item: any) => item.change === 'created' && item.sources.join() === 'user')).toBe(true)
  const frozen = await page.evaluate(async () => (await (window as any).durability.call('canvas_inspect', { scope: 'changes' })).structuredContent)
  expect(frozen.elements.map((item: any) => item.id).sort()).toEqual(second.context.changes.items.map((item: any) => item.id).sort())
  await finish()
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toBeVisible()
  const third = await submit('Compare the two strokes.')
  expect(third.context.changes).toMatchObject({ since: second.context.commitId, status: 'compared', total: 0, items: [] })
  // The thread already holds the second turn's pixels for this commit and view.
  expect(third.context.preview).toEqual({ status: 'unchanged', evidenceId: second.context.preview.evidenceId })
  expect(third.imageCount).toBe(0)
  await finish()
  const saved = await workspace(page)
  const turns = saved.agentSessions.flatMap((session: any) => session.turns)
  expect(turns.map((turn: any) => turn.instruction)).toEqual(['What do you think?', 'And now?', 'Compare the two strokes.'])
  expect(turns.every((turn: any) => turn.turnId)).toBe(true)
  expect(turns.map((turn: any) => turn.context.canvas?.preview)).toEqual(['attached', 'attached', 'unchanged'])
  expect(turns[2].context.canvas.previewEvidenceId).toBe(turns[1].context.canvas.previewEvidenceId)
})

test('background writes publish complete durable versions and preserve native undo', async ({ page }, info) => {
  await controlledCodex(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await connectCodex(page)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Draw a detailed study')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.waitForFunction(() => (window as any).durability.active)
  const result = await page.evaluate(async ({ base, operations }) => {
    const d = (window as any).durability
    const status = JSON.parse((await d.call('canvas_inspect', {})).content[0].text)
    const initial = await d.call('canvas_edit', { revision: status.revision, operations: base })
    if (initial.isError) throw new Error(initial.content[0].text)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const gaps: number[] = [], tasks: number[] = []
    let done = false, previous = performance.now(), previewFrames = 0
    const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => entry.duration)))
    observer.observe({ entryTypes: ['longtask'] })
    const frame = () => {
      const now = performance.now(); gaps.push(now - previous); previous = now
      if (document.querySelector('.canvas-presentation [data-preview]')) previewFrames++
      if (!done) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    const start = performance.now()
    const result = await d.call('canvas_edit', { revision: JSON.parse(initial.content[0].text).revision, operations })
    const elapsed = performance.now() - start
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    done = true; observer.disconnect()
    return { error: result.isError === true, elapsed, maxFrame: Math.max(...gaps), tasks, previewFrames }
  }, { base: brushBase, operations: brushOperations })
  await info.attach('production-performance', { body: JSON.stringify(result), contentType: 'application/json' })
  expect(result.error).toBe(false)
  expect(result.previewFrames).toBe(0)
  await expect(page.getByRole('region', { name: 'Galta canvas, 74 objects', exact: true })).toBeVisible()
  await expect(page.locator('.canvas-presentation [data-preview]')).toHaveCount(0)
  const saved = await workspace(page)
  expect(document(saved).elements).toHaveLength(74)
  expect(Object.values(saved.project.commits).filter((commit: any) => commit.source === 'agent')).toHaveLength(2)
  await page.evaluate(() => (window as any).durability.finish())
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toHaveCount(0)
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+z')
  await expect(page.getByRole('region', { name: 'Galta canvas, 46 objects', exact: true })).toBeVisible()
  await page.keyboard.press('Meta+Shift+z')
  await expect(page.getByRole('region', { name: 'Galta canvas, 74 objects', exact: true })).toBeVisible()
  await expect.poll(async () => document(await workspace(page)).elements.filter((el: any) => !el.isDeleted).length).toBe(74)
  await page.reload()
  await expect(page.getByRole('region', { name: 'Galta canvas, 74 objects', exact: true })).toBeVisible()
})

test('submission freezes the observed canvas pixels before waiting for the document lease', async ({ page }) => {
  await controlledCodex(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await connectCodex(page)
  const photo = async (color: string) => ({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(await page.evaluate(color => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 100
    const context = canvas.getContext('2d')!; context.fillStyle = color; context.fillRect(0, 0, 100, 100)
    return canvas.toDataURL().split(',')[1]!
  }, color), 'base64') })
  await page.locator('nav input[type=file]').setInputFiles(await photo('#ff0000'))
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await page.evaluate(() => { const w = window as any; w.__canvasAcquireGate = new Promise(resolve => { w.__releaseCanvasAcquire = resolve }) })
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Describe this photo')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.waitForFunction(() => (window as any).__canvasAcquireHeld)
  await page.locator('nav input[type=file]').setInputFiles(await photo('#00ff00'))
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  await page.evaluate(() => (window as any).__releaseCanvasAcquire())
  await page.waitForFunction(() => (window as any).durability.active)
  const pixel = await page.evaluate(async () => {
    const image = (window as any).durability.input.find((item: any) => item.type === 'image')
    const bitmap = await createImageBitmap(await (await fetch(image.url)).blob())
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close()
    return [...context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data].slice(0, 3)
  })
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click()
  expect(pixel[0]).toBeGreaterThan(240)
  expect(pixel[1]).toBeLessThan(15)
})

for (const mode of ['failure', 'stop-after-commit'] as const) {
  test(`background persistence boundary: ${mode}`, async ({ page }) => {
    await controlledCodex(page)
    await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
    await draw(page, 200)
    await expect.poll(async () => document(await workspace(page)).elements.length).toBe(1)
    await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Add text')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.waitForFunction(() => (window as any).durability.active)
    await page.evaluate(async mode => {
      const w = window as any, d = w.durability
      const { revision } = JSON.parse((await d.call('canvas_inspect', {})).content[0].text)
      d.holdSave(mode === 'failure' ? 'failure' : 'close')
      w.pendingMutation = d.call('canvas_edit', { revision, operations: [{ type: 'create_text', text: 'Durable background result', x: 500, y: 250 }] }).then((result: unknown) => { d.result = result })
    }, mode)
    await page.waitForFunction(() => (window as any).durability.held)
    if (mode === 'stop-after-commit') {
      expect(document(await workspace(page)).elements).toHaveLength(2)
      await page.getByRole('button', { name: 'Stop generation', exact: true }).click()
    }
    await page.evaluate(async () => { const w = window as any; w.durability.release(); await w.pendingMutation })
    const result = await page.evaluate(() => (window as any).durability.result)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain(mode === 'failure' ? 'Agent save test' : 'saved in history')
    if (mode === 'failure') await page.evaluate(() => (window as any).durability.finish())
    await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toHaveCount(0)
    const count = mode === 'failure' ? 1 : 2
    await expect.poll(async () => document(await workspace(page)).elements.length).toBe(count)
    await page.reload()
    await expect(page.getByRole('region', { name: `Galta canvas, ${count} objects`, exact: true })).toBeVisible()
  })
}

test('concurrent user edits reject a stale task revision', async ({ page }) => {
  await controlledCodex(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await draw(page, 200)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Add text')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.waitForFunction(() => (window as any).durability.active)
  const revision = await page.evaluate(async () => JSON.parse((await (window as any).durability.call('canvas_inspect', {})).content[0].text).revision)
  await draw(page, 700)
  await expect.poll(async () => document(await workspace(page)).elements.length).toBe(2)
  const result = await page.evaluate(revision => (window as any).durability.call('canvas_edit', { revision, operations: [{ type: 'create_text', text: 'Stale result', x: 500, y: 250 }] }), revision)
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('canvas changed')
  expect(document(await workspace(page)).elements.map((element: any) => element.type)).toEqual(['freedraw', 'freedraw'])
  await page.evaluate(() => (window as any).durability.finish())
})

test('switching projects leaves a task running', async ({ page }) => {
  await controlledCodex(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Keep working')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.waitForFunction(() => (window as any).durability.active)
  await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
  await page.getByRole('button', { name: 'New canvas', exact: true }).click()
  await expect(page.locator('.galta-shell')).not.toHaveAttribute('data-project-id', 'default-project')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).durability.interrupts)).toBe(0)
  await page.evaluate(() => (window as any).durability.finish())
  await expect.poll(async () => (await workspace(page)).agentSessions[0].turns.at(-1).status).toBe('completed')
})

test('stop during lease preparation saves the instruction and never starts a model turn', async ({ page }) => {
  await controlledCodex(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.evaluate(() => { const w = window as any; w.__canvasAcquireGate = new Promise(resolve => { w.__releaseCanvasAcquire = resolve }) })
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Preserve this interrupted idea')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.waitForFunction(() => (window as any).__canvasAcquireHeld)
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible()
  expect((await workspace(page)).agentSessions.flatMap((session: any) => session.turns)).toEqual(expect.arrayContaining([
    expect.objectContaining({ instruction: 'Preserve this interrupted idea', status: 'stopped' })
  ]))
  expect(await page.evaluate(() => (window as any).durability.calls.some((call: any) => call.method === 'turn/start'))).toBe(false)
})
test('a new canvas keeps the connection and starts its own native session', async ({ page }) => {
  await controlledCodex(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`); await connectCodex(page)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('First project')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.waitForFunction(() => (window as any).durability.active)
  await page.evaluate(() => (window as any).durability.finish())
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible()
  const accountReads = await page.evaluate(() => (window as any).durability.connections)
  await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
  await page.getByRole('button', { name: 'New canvas', exact: true }).click()
  await expect(page.locator('.galta-shell')).not.toHaveAttribute('data-project-id', 'default-project')
  const id = await page.locator('.galta-shell').getAttribute('data-project-id')
  await page.evaluate(() => { (window as any).durability.active = false; (window as any).durability.calls = [] })
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Second project')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.waitForFunction(() => (window as any).durability.active)
  const state = await page.evaluate(() => ({ connections: (window as any).durability.connections, calls: (window as any).durability.calls }))
  expect(state.connections).toBe(accountReads)
  expect(state.calls.some((call: any) => call.method === 'thread/start')).toBe(true)
  expect(state.calls.some((call: any) => call.method === 'thread/resume')).toBe(false)
  expect(JSON.parse(state.calls.find((call: any) => call.method === 'turn/start').params.additionalContext.canvas.value).projectId).toBe(id)
  await page.evaluate(() => (window as any).durability.finish())
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible()
})
