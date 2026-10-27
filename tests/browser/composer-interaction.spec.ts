import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { test, expect } from '@playwright/test'
import { historyWorkspace } from './history-helpers'
import { installCanvasPort, connectCodex } from '../helpers/canvas-port'

test('composer keeps context, execution settings and send coherent through a full conversation', async ({ page }, info) => {
  // Exercise the production UI and outbound runtime contract without starting a live model.
  await page.addInitScript(() => {
    const w = window as any, listeners = new Set<(message: unknown) => void>()
    const thread = { id: 'composer-interaction', turns: [] as any[] }
    const notify = (method: string, params: any) => listeners.forEach(listener => listener({ type: 'codex-notification', notification: { method, params } }))
    const fixture = w.composerFixture = {
      starts: [] as any[],
      steers: [] as any[],
      holdSteer: false,
      releaseSteer: () => {},
      ports: [] as any[],
      disconnect() {
        w.chrome.runtime.lastError = { message: 'The browser connection closed.' }
        fixture.ports.findLast(port => port.name.startsWith('galta-codex-client:') && !port.closed).fail()
        delete w.chrome.runtime.lastError
      },
      finish(status = 'completed') {
        const turn = thread.turns.at(-1)
        turn.status = status
        if (status === 'completed') {
          turn.items.forEach((item: any) => { item.status = 'completed' })
          const item = { id: 'answer-' + turn.id, type: 'agentMessage', phase: 'final_answer', text: 'The light is balanced. The original image is unchanged.', status: 'completed' }
          turn.items.push(item)
          notify('item/completed', { threadId: thread.id, turnId: turn.id, item })
        }
        notify('turn/completed', { threadId: thread.id, turn })
      }
    }
    Object.assign(window, { chrome: { ...(window as any).chrome,
      windows: { getCurrent: async () => ({}) },
      runtime: {
      onMessage: { addListener: (listener: any) => listeners.add(listener), removeListener: (listener: any) => listeners.delete(listener) },
      connect: ({ name }: { name: string }) => {
        const disconnected = new Set<() => void>()
        const port = { name, closed: false, onDisconnect: { addListener: (listener: () => void) => disconnected.add(listener) }, disconnect() { port.closed = true }, fail() { port.closed = true; disconnected.forEach(listener => listener()) } }
        fixture.ports.push(port)
        return port
      },
      async sendMessage(message: any) {
        if (message.type === 'codex-connect') return { ok: true, models: [
          { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: true, supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) },
          { id: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }
        ] }
        if (message.type !== 'codex-rpc') throw new Error('Unexpected fixture message: ' + message.type)
        let result: any = {}
        switch (message.method) {
          case 'galta/config/read': result = { toolContract: (window as any).__galtaToolContract }; break
          case 'thread/start': case 'thread/resume': case 'thread/read': result = { thread }; break
          case 'thread/name/set': break
          case 'turn/start': {
            fixture.starts.push(message.params)
            const turn = { id: 'turn-' + fixture.starts.length, status: 'inProgress', items: [{ id: 'thinking-' + fixture.starts.length, type: 'reasoning', text: 'Comparing the light.', status: 'inProgress' }] }
            thread.turns.push(turn); result = { turn }
            notify('turn/started', { threadId: thread.id, turn })
            notify('item/started', { threadId: thread.id, turnId: turn.id, item: turn.items[0] }); break
          }
          case 'turn/interrupt': fixture.finish('interrupted'); break
          case 'turn/steer':
            fixture.steers.push(message.params)
            if (fixture.holdSteer) await new Promise<void>(resolve => { fixture.releaseSteer = resolve })
            break
          default: throw new Error('Unexpected fixture RPC: ' + message.method)
        }
        return { ok: true, result }
      }
    } } })
  })
  await installCanvasPort(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await connectCodex(page)
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference-glass.png')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  const before = await historyWorkspace(page)
  const input = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  await input.fill('Study the light.')
  const centeredDock = (await page.locator('.conversation-dock').boundingBox())!
  const dragHandle = page.getByRole('slider', { name: 'Move composer', exact: true })
  await expect(dragHandle.locator('.composer-resize-glyph')).toHaveCSS('opacity', '0.24')
  await expect(dragHandle).toHaveCSS('cursor', 'grab')
  await dragHandle.hover()
  await expect(dragHandle.locator('.composer-resize-glyph')).toHaveCSS('opacity', '0.56')
  await dragHandle.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await page.locator('.conversation-dock').boundingBox())!.x).toBeCloseTo(centeredDock.x + 24, 0)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => (await page.locator('.conversation-dock').boundingBox())!.x).toBeCloseTo(centeredDock.x, 0)
  const send = (await page.locator('.composer-submit').boundingBox())!
  await page.getByRole('button', { name: /^Model GPT/ }).click()
  await expect(page.getByRole('combobox')).toHaveCount(0)
  await page.getByRole('button', { name: /^Effort / }).click()
  await page.getByRole('menuitemradio', { name: 'High', exact: true }).focus()
  await page.keyboard.press('ArrowUp', { delay: 60 })
  await expect(page.getByRole('menuitemradio', { name: 'Medium', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('.runtime-model')).toContainText('Medium')
  await page.getByRole('radiogroup', { name: 'Model', exact: true }).getByText('GPT-5.6-Luna', { exact: true }).click()
  await expect(page.locator('.runtime-model')).toContainText('Low')
  await page.getByRole('button', { name: 'Effort Low', exact: true }).click()
  await expect(page.getByRole('menuitemradio')).toHaveCount(1)
  await expect(page.getByRole('menuitemradio', { name: 'Low', exact: true })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Model settings', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.runtime-model')).toBeFocused()
  await expect(input).toHaveValue('Study the light.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).composerFixture.starts.length)).toBe(1)
  expect(await page.evaluate(() => (window as any).composerFixture.starts[0])).toMatchObject({ model: 'gpt-5.6-luna', effort: 'low' })
  // Work lights the outline of the whole dock, around the open reading sheet
  // as well as the composer.
  await expect(page.locator('.dock-trace')).toHaveAttribute('data-working', 'true')
  await expect(page.locator('.dock-trace .agent-light-glow path')).toHaveCount(3)
  await expect(page.locator('.dock-trace .agent-light-hairline')).toHaveCount(1)
  await expect(page.locator('.conversation-sheet')).toHaveCount(1)
  await page.locator('.conversation-presence').evaluate(element => element.getAnimations().forEach(animation => animation.finish()))
  // The light follows the edge of the whole dock, from its crown to its feet.
  await expect.poll(() => page.evaluate(() => {
    const dock = document.querySelector('.conversation-dock')!.getBoundingClientRect().height
    return Math.abs(document.querySelector<SVGPathElement>('.dock-trace .agent-light-glow path')!.getBBox().height - dock)
  })).toBeLessThan(.5)
  await expect(page.getByRole('button', { name: 'Collapse conversation', exact: true })).toHaveCount(1)
  await input.fill('Keep this draft.\nPreserve all the materials.')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible()
  await expect(page.locator('.composer-submit-label')).toHaveCount(0)
  await expect(page.locator('.composer-submit')).toHaveAttribute('data-action', 'send')
  await expect(page.getByRole('button', { name: 'Collapse conversation', exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Switch conversation', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: /^Model GPT/ }).click()
  for (const radio of await page.getByRole('radio').all()) await expect(radio).toBeDisabled()
  await page.getByRole('button', { name: /^Effort / }).click()
  for (const option of await page.getByRole('menuitemradio').all()) await expect(option).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Model settings', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  const steer = (await page.locator('.composer-submit').boundingBox())!
  expect(steer.x + steer.width).toBeCloseTo(send.x + send.width, 0)
  expect(steer.y + steer.height).toBeCloseTo(send.y + send.height, 0)
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible()
  await page.evaluate(() => { (window as any).composerFixture.holdSteer = true })
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await input.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).composerFixture.steers.length)).toBe(1)
  await input.fill('Keep this newer draft after sending.')
  await page.evaluate(() => { (window as any).composerFixture.releaseSteer() })
  await expect(page.locator('.conversation-followup')).toContainText('Preserve all the materials.')
  await expect(input).toHaveValue('Keep this newer draft after sending.')
  const accepted = (await historyWorkspace(page)).agentSessions!.flatMap(session => session.turns).flatMap(turn => turn.steering ?? [])
  expect(accepted).toHaveLength(1)
  expect(accepted[0]!.afterItemId).toBe('thinking-1')
  await input.fill('')
  await expect(input).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible()
  await expect(page.locator('.composer-submit')).toHaveAttribute('data-action', 'stop')
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click()
  await expect(input).toHaveValue('')
  expect(await page.evaluate(() => (window as any).composerFixture.starts.length)).toBe(1)
  await input.fill('Keep this draft.\nPreserve all the materials.')
  await page.getByRole('button', { name: 'Collapse conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).composerFixture.starts.length)).toBe(2)
  await expect(page.getByRole('button', { name: 'Collapse conversation', exact: true })).toHaveCount(1)
  await expect(page.locator('.conversation-turn').first().locator('.working-dot')).toHaveCount(0)
  // The stopped turn's only step has nothing more to show, so it is its line.
  await expect(page.locator('.conversation-turn').first()).toContainText('Thinking stopped')
  await expect(page.locator('.conversation-turn').first().getByRole('button', { name: 'Execution details', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Collapse conversation', exact: true }).click()
  await page.evaluate(() => (window as any).composerFixture.finish())
  await expect(page.locator('.composer-conversation')).toHaveAttribute('data-unread', 'true')
  await expect(page.locator('.conversation-sheet')).toHaveCount(0)
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect(page.locator('.conversation-assistant').last()).toContainText('The original image is unchanged.')
  await page.screenshot({ path: info.outputPath('production-conversation.png'), animations: 'disabled' })
  await page.getByRole('button', { name: 'Collapse conversation', exact: true }).click()
  await expect(page.locator('.composer-conversation')).toHaveAttribute('data-unread', 'false')
  const after = await historyWorkspace(page)
  expect(after.project).toEqual(before.project)
  expect(after.snapshots).toEqual(before.snapshots)
  await input.fill('Keep my draft through reconnection.')
  const portsBefore = await page.evaluate(() => (window as any).composerFixture.ports.length)
  await page.evaluate(() => (window as any).composerFixture.disconnect())
  await expect(page.getByRole('button', { name: 'Reconnect agent', exact: true })).toBeVisible()
  await expect(input).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open conversation', exact: true })).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).composerFixture.ports.length)).toBe(portsBefore)
  await page.getByRole('button', { name: 'Reconnect agent', exact: true }).click()
  await expect(page.getByText('You’re connected. Make something together.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).composerFixture.ports.length)).toBe(portsBefore + 1)
  await page.getByRole('button', { name: 'Back to your canvas', exact: true }).click()
  await expect(input).toHaveValue('Keep my draft through reconnection.')
  await expect(input).toBeFocused()
  expect(await page.evaluate(() => (window as any).composerFixture.starts.length)).toBe(2)
})
