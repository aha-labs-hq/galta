import { expect, type Page } from '@playwright/test'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installCanvasPort, connectCodex } from './canvas-port'

/** The production UI with a Codex that answers from a fixture: no live model.
 * `delay` is how long the host takes to start a turn. `window.dockFixture.turns()`
 * counts the turns started, and `finish(text)` completes the latest one. */
export async function installDockCodex(page: Page, delay = 0) {
  await page.addInitScript(delay => {
    const w = window as any, listeners = new Set<(message: unknown) => void>()
    const thread = { id: 'dock-fixture', turns: [] as any[] }
    const notify = (method: string, params: any) => listeners.forEach(listener => listener({ type: 'codex-notification', notification: { method, params } }))
    w.dockFixture = {
      turns: () => thread.turns.length,
      finish(text: string) {
        const turn = thread.turns.at(-1)
        turn.status = 'completed'
        turn.items.forEach((item: any) => { item.status = 'completed' })
        const item = { id: 'answer-' + turn.id, type: 'agentMessage', phase: 'final_answer', text, status: 'completed' }
        turn.items.push(item)
        notify('item/completed', { threadId: thread.id, turnId: turn.id, item })
        notify('turn/completed', { threadId: thread.id, turn })
      }
    }
    Object.assign(window, { chrome: { ...w.chrome,
      windows: { getCurrent: async () => ({}) },
      runtime: {
        onMessage: { addListener: (listener: any) => listeners.add(listener), removeListener: (listener: any) => listeners.delete(listener) },
        connect: ({ name }: { name: string }) => ({ name, onDisconnect: { addListener() {} }, disconnect() {} }),
        async sendMessage(message: any) {
          if (message.type === 'codex-connect') return { ok: true, models: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] }
          if (message.type !== 'codex-rpc') throw new Error('Unexpected fixture message: ' + message.type)
          let result: any = {}
          switch (message.method) {
            case 'galta/config/read': result = { toolContract: w.__galtaToolContract }; break
            case 'thread/start': case 'thread/resume': case 'thread/read': result = { thread }; break
            case 'thread/name/set': break
            case 'turn/start': {
              // The host takes `delay` ms to start the turn, so its first item
              // reaches the sheet that long after Send.
              await new Promise(resolve => setTimeout(resolve, delay))
              const n = thread.turns.length + 1
              const turn = { id: 'turn-' + n, status: 'inProgress', items: [{ id: 'thinking-' + n, type: 'reasoning', text: 'Comparing the light.', status: 'inProgress' }] }
              thread.turns.push(turn); result = { turn }
              notify('turn/started', { threadId: thread.id, turn })
              notify('item/started', { threadId: thread.id, turnId: turn.id, item: turn.items[0] }); break
            }
            default: throw new Error('Unexpected fixture RPC: ' + message.method)
          }
          return { ok: true, result }
        }
      } } })
  }, delay)
  await installCanvasPort(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await connectCodex(page)
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference-glass.png')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
}

/** Sends `count` requests and completes each with a reply of a few lines. */
export async function buildHistory(page: Page, count: number) {
  const input = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  const done = await page.locator('.conversation-turn').count()
  for (let n = done + 1; n <= done + count; n++) {
    await input.fill(`Request ${n}`)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.waitForFunction(turns => (window as any).dockFixture.turns() === turns, n)
    await page.evaluate(n => (window as any).dockFixture.finish(`Reply ${n}. ` + 'The light is balanced and the original is unchanged. '.repeat(6)), n)
    await expect(page.locator('.conversation-reply')).toHaveCount(n)
  }
}
