import { test, expect } from '@playwright/test'
import { installCanvasPort } from '../helpers/canvas-port'
import { galtaToolContract } from '../../packages/canvas/src/contract'

async function clickInvitation(page: import('@playwright/test').Page, name: string) {
  const bounds = (await page.getByRole('group', { name: 'Meet your canvas agent' }).getByRole('button', { name, exact: true }).boundingBox())!
  // Native canvas owns pointer hit testing. The corresponding DOM target is
  // unpainted and provides keyboard/screen-reader semantics only.
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
}

test('before connection the canvas invitation is independent of drawing', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1505, height: 1045 })
  await page.goto('/canvas/index.html')
  await expect(page.locator('.conversation-dock').getByRole('button', { name: 'Connect an agent', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const input = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  await expect(input).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open conversation', exact: true })).toHaveCount(0)
  await expect(page.getByRole('slider', { name: 'Move composer', exact: true })).toHaveCount(0)
  const dock = await page.locator('.conversation-dock').boundingBox()
  expect(dock!.width).toBeLessThan(230)
  expect(dock!.height).toBeLessThanOrEqual(52)
  await page.screenshot({ path: testInfo.outputPath('composer.png') })
  await page.locator('.conversation-dock').getByRole('button', { name: 'Connect an agent', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('connection-dialog.png') })
  await page.getByRole('dialog').screenshot({ path: testInfo.outputPath('connection-panel.png') })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.conversation-dock').getByRole('button', { name: 'Connect an agent', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect(input).toHaveCount(0)
  // The drawing tool remains usable without installing anything or signing in.
  await page.getByRole('button', { name: 'Draw — P' }).click()
  await page.mouse.move(320, 280); await page.mouse.down(); await page.mouse.move(450, 350, { steps: 8 }); await page.mouse.up()
  await expect(page.getByLabel('Galta canvas, 1 objects', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Meet your canvas agent')).toHaveCount(0)
  await page.keyboard.press('Meta+z')
  await expect(page.getByLabel('Galta canvas, 0 objects', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Meet your canvas agent')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.conversation-dock').getByRole('button', { name: 'Connect an agent', exact: true })).toBeVisible()
  await expect(page.getByLabel('Meet your canvas agent')).toHaveCount(0)
})

test('the narrow-panel connection dialog fits and has a working close control', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 380, height: 540 })
  await page.goto('/canvas/index.html')
  await page.locator('.conversation-dock').getByRole('button', { name: 'Connect an agent', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const bounds = await dialog.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(16)
  expect(bounds!.width).toBeLessThanOrEqual(348)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(524)
  await page.screenshot({ path: testInfo.outputPath('narrow-dialog.png') })
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect(dialog).toHaveCount(0)
})

test('sign-in reveals the composer without automatically submitting', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    let signedIn = false
    const listeners = new Set<(message: unknown) => void>()
    const fixture = window as unknown as { chrome: unknown; submitted: number }
    fixture.submitted = 0
    fixture.chrome = { runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      getURL: (path: string) => new URL(`/${path}`, location.origin).href,
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.add(listener), removeListener: (listener: (message: unknown) => void) => listeners.delete(listener) },
      connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} }),
      sendMessage: async (message: { type: string; method?: string }) => {
        if (message.type === 'setup-status') return { state: 'ready', health: { protocol: 1, version: '0.1.0', releaseId: 'fixture', channel: 'development', capabilities: ['canvas/1', 'codex/1', 'mcp/1'], runtime: { available: true, version: '0.147.0' } } }
        if (message.type === 'codex-connect') return signedIn ? { ok: true, models: [{ id: 'test-model', displayName: 'Test model' }] } : { ok: true, requiresAuth: true }
        if (message.type === 'codex-login') {
          signedIn = true
          queueMicrotask(() => listeners.forEach(listener => listener({ type: 'codex-notification', notification: { method: 'account/login/completed', params: { success: true } } })))
          return { ok: true }
        }
        if (message.method === 'turn/start') fixture.submitted++
        return { ok: true, result: {} }
      },
    } }
  })
  await installCanvasPort(page)
  await page.goto('/canvas/index.html')
  const draft = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  await expect(draft).toHaveCount(0)
  await page.locator('.conversation-dock').getByRole('button', { name: 'Connect an agent', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: /^Chat in Galta/ }).click()
  await expect(page.getByRole('button', { name: 'Sign in with ChatGPT', exact: true })).toBeVisible()
  await page.getByRole('dialog').screenshot({ path: testInfo.outputPath('sign-in-panel.png') })
  await page.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).click()
  await expect(page.getByText('You’re connected. Make something together.', { exact: true })).toBeVisible()
  await page.getByRole('dialog').screenshot({ path: testInfo.outputPath('ready-panel.png') })
  await page.getByRole('button', { name: 'Back to your canvas' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(draft).toBeVisible()
  await expect(draft).toHaveValue('')
  // The task host may still be opening. Draft entry is independent from the
  // send transport, so sign-in should return the user to an editable composer.
  await expect(draft).toBeEnabled()
  await expect(draft).toBeFocused()
  await expect(page.getByRole('button', { name: 'Open conversation', exact: true })).toBeVisible()
  const composer = await page.locator('.conversation-composer').boundingBox()
  await expect.poll(() => page.locator('.galta-shell').evaluate(el => parseFloat((el as HTMLElement).style.getPropertyValue('--composer-height')))).toBe(composer!.height)
  expect(await page.evaluate(() => (window as unknown as { submitted: number }).submitted)).toBe(0)
})

test('a manual preview check gives feedback and expanded details fit a short panel', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 500 })
  await page.goto('/canvas/index.html')
  await page.locator('.conversation-dock').getByRole('button', { name: 'Connect an agent', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Work in Codex or Claude Code', exact: true }).click()
  const runtime = page.getByRole('dialog').locator('.settings-row').filter({ hasText: 'Galta for Mac' })
  await expect(runtime).toBeVisible()
  await expect(runtime).toHaveText('Galta for MacNot connected')
  await page.getByRole('button', { name: 'Check connection', exact: true }).click()
  await expect(page.getByText('This preview can’t connect. Open the Galta extension to connect an agent.')).toBeVisible()
  await page.getByText('Connection details', { exact: true }).click()
  await expect(page.getByText('Use the Mac app included with this build. A public download is not available yet.')).toBeVisible()
  const dialog = page.getByRole('dialog')
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  const bounds = await dialog.boundingBox()
  expect(bounds!.y).toBeGreaterThanOrEqual(16)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(484)
  await page.screenshot({ path: testInfo.outputPath('compact-details.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.conversation-dock').getByRole('button', { name: 'Connect an agent', exact: true })).toBeFocused()
})

for (const runtime of [true, false]) test(`one connection handoff works with embedded runtime ${runtime ? 'available' : 'unavailable'}`, async ({ page }, testInfo) => {
  await page.addInitScript(runtime => {
    const state = { calls: [] as string[], clipboard: '' }
    Object.assign(window, { agentSetup: state, chrome: { runtime: {
      id: 'galta-test', getURL: (path: string) => new URL(`/${path}`, location.origin).href,
      onMessage: { addListener() {}, removeListener() {} },
      connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} }),
      sendMessage: async (message: { type: string }) => {
        state.calls.push(message.type)
        return { state: runtime ? 'ready' : 'runtime-unavailable', health: { protocol: 1, version: '0.1.0', releaseId: 'test', channel: 'development', capabilities: ['canvas/1', 'codex/1', 'mcp/1'], runtime: { available: runtime }, mcpCommand: "/Users/Artist's Studio/Library/Application Support/Galta/current/Resources/galta-mcp" } }
      }
    } } })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { state.clipboard = text } } })
  }, runtime)
  await page.goto('/canvas/index.html')
  await clickInvitation(page, 'Connect through the Galta illustration')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toHaveAccessibleName('Settings')
  await dialog.getByRole('button', { name: 'Work in Codex or Claude Code', exact: true }).click()
  await expect(dialog).toHaveAccessibleName('Work in Codex or Claude Code')
  await expect(dialog.getByRole('button', { name: /Codex|Claude|Other agents|Sign in/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Copy instructions', exact: true }).click()
  await expect(page.getByText('Waiting for your AI app', { exact: true })).toBeVisible()
  await expect(page.getByText('Your AI app is connected to this canvas.', { exact: true })).toHaveCount(0)
  const state = await page.evaluate(() => (window as any).agentSetup)
  expect(state.calls).not.toContain('codex-connect')
  expect(state.calls).not.toContain('codex-login')
  expect(state.clipboard).toContain('canvas_list, then canvas_connect')
  expect(state.clipboard).toMatch(/ID ends with \/[0-9a-f-]{36}/)
  const configuration = JSON.parse(state.clipboard.split('\n\n')[1])
  expect(configuration).toEqual({ mcpServers: { galta: { command: "/Users/Artist's Studio/Library/Application Support/Galta/current/Resources/galta-mcp", args: [] } } })
  await dialog.screenshot({ path: testInfo.outputPath('unified-agent-panel.png') })
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toHaveCount(0)
  await expect(page.getByLabel('Meet your canvas agent')).toBeVisible()
})

test('an installed Mac app that needs attention names its problem and next step, not first-time setup', async ({ page }) => {
  const repair = 'Galta for Mac needs to repair this browser’s connection. Open Galta on your Mac and choose “Repair connection”.'
  await page.addInitScript(detail => {
    const state = { status: { state: 'unavailable', detail } as unknown }
    Object.assign(window, { setupStatus: state, chrome: { runtime: {
      id: 'galta-test', onMessage: { addListener() {}, removeListener() {} },
      connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} }),
      sendMessage: async (message: { type: string }) => message.type === 'setup-status' ? state.status : { ok: true }
    } } })
  }, repair)
  await page.goto('/canvas/index.html')
  await page.locator('.conversation-dock').getByRole('button', { name: 'Connect an agent', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Work in Codex or Claude Code', exact: true }).click()
  await expect(dialog.locator('.settings-row').filter({ hasText: 'Galta for Mac' })).toHaveText('Galta for MacNeeds attention')
  await expect(dialog.getByText(repair, { exact: true })).toBeVisible()
  await expect(dialog.getByText(/Connect browser/)).toHaveCount(0)
  await dialog.getByText('Connection details', { exact: true }).click()
  await expect(dialog.getByText('Use the Mac app included with this build. A public download is not available yet.')).toHaveCount(0)
  // After the repair, returning to the canvas checks again and offers the handoff.
  await page.evaluate(() => { (window as any).setupStatus.status = { state: 'ready', health: { protocol: 1, version: '0.1.1', releaseId: 'test', channel: 'development', capabilities: ['canvas/1', 'codex/1', 'mcp/1'], runtime: { available: true }, mcpCommand: '/Applications/Galta.app/galta-mcp' } } })
  await dialog.getByRole('button', { name: 'Check connection', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Copy instructions', exact: true })).toBeVisible()
  await expect(dialog.getByText(repair, { exact: true })).toHaveCount(0)
})

test('a canvas opened before Galta for Mac was connected registers when the user returns, under the ID the agent is given', async ({ page }) => {
  await page.addInitScript(toolContract => {
    const link = { mac: 'absent', host: 'missing', attempts: [] as string[], registered: [] as string[], clipboard: '' }
    const health = { protocol: 1, version: '0.1.1', releaseId: 'test', channel: 'development', capabilities: ['canvas/1', 'codex/1', 'mcp/1'], runtime: { available: true }, mcpCommand: '/Applications/Galta.app/galta-mcp' }
    Object.assign(window, { link, chrome: { runtime: {
      id: 'galta-test', onMessage: { addListener() {}, removeListener() {} },
      sendMessage: async (message: { type: string }) => message.type !== 'setup-status' ? { ok: true }
        : link.mac === 'ready' ? { state: 'ready', health } : { state: 'absent', detail: 'Galta for Mac isn’t connected to this browser.' },
      // The background's canvas port: it closes every canvas when the native host is missing.
      connect: ({ name }: { name: string }) => {
        const listeners = new Set<(message: any) => void>()
        const emit = (message: any) => queueMicrotask(() => listeners.forEach(fn => fn(message)))
        return { onMessage: { addListener: (fn: any) => listeners.add(fn) }, onDisconnect: { addListener() {} }, disconnect() {},
          postMessage(message: any) {
            if (message.method !== 'canvas/register') { if (message.method) emit({ id: message.id, result: {} }); return }
            const canvasId = name.slice('galta-canvas:'.length)
            link.attempts.push(canvasId)
            if (link.host === 'missing') emit({ method: 'canvas/disconnected', params: { message: 'Specified native messaging host not found.' } })
            else if (link.host === 'incompatible') emit({ id: message.id, error: { message: 'Galta’s extension and local runtime have incompatible tools. Update Galta for Mac, connect the browser, then reload the Galta extension and its open canvases before sending again.' } })
            else { link.registered.push(canvasId); emit({ id: message.id, result: { toolContract } }) }
          } }
      }
    } } })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { link.clipboard = text } } })
  }, await galtaToolContract())
  await page.goto('/canvas/index.html')
  await expect.poll(() => page.evaluate(() => (window as any).link.attempts.length)).toBe(1)
  await page.locator('.conversation-dock').getByRole('button', { name: 'Connect an agent', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Work in Codex or Claude Code', exact: true }).click()
  await expect(dialog.getByText('Open Galta on your Mac and choose “Connect browser”. You only need to do this once.', { exact: true })).toBeVisible()
  // The user connects Galta for Mac and returns; this browser's bridge still has other tools.
  await page.evaluate(() => { const link = (window as any).link; link.mac = 'ready'; link.host = 'incompatible'; window.dispatchEvent(new Event('focus')) })
  await expect(dialog.getByText(/^This canvas couldn’t connect to Galta for Mac\. .*incompatible tools/)).toBeVisible()
  await expect(dialog.locator('.settings-row').filter({ hasText: 'Galta for Mac' })).toHaveText('Galta for MacNeeds attention')
  await expect(dialog.getByRole('button', { name: 'Copy instructions', exact: true })).toHaveCount(0)
  await page.evaluate(() => { (window as any).link.host = 'ready' })
  await dialog.getByRole('button', { name: 'Check connection', exact: true }).click()
  await dialog.getByRole('button', { name: 'Copy instructions', exact: true }).click()
  const link = await page.evaluate(() => (window as any).link)
  expect(new Set(link.attempts).size).toBe(1)
  expect(link.registered).toEqual([link.attempts[0]])
  expect(link.clipboard).toContain(`ID ends with /${link.attempts[0]}`)
})

test('closing setup ignores a delayed connection check', async ({ page }) => {
  await page.addInitScript(() => {
    const state = { calls: [] as string[], finish: null as null | (() => void) }
    Object.assign(window, { setupRace: state, chrome: { runtime: {
      id: 'galta-test', onMessage: { addListener() {}, removeListener() {} },
      connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} }),
      sendMessage: async (message: { type: string }) => {
        state.calls.push(message.type)
        if (message.type === 'setup-status') return new Promise(resolve => { state.finish = () => resolve({ state: 'ready', health: { runtime: { available: true } } }) })
        return { ok: true }
      }
    } } })
  })
  await page.goto('/canvas/index.html')
  await clickInvitation(page, 'Connect through the Galta illustration')
  await page.getByRole('dialog').getByRole('button', { name: 'Work in Codex or Claude Code', exact: true }).click()
  await expect(page.getByText('Checking connection…', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await page.evaluate(() => (window as any).setupRace.finish())
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).setupRace.calls)).not.toContain('codex-connect')
})

for (const viewport of [{ width: 320, height: 500 }, { width: 380, height: 540 }, { width: 620, height: 420 }]) test(`invitation remains usable at ${viewport.width} × ${viewport.height}`, async ({ page }, testInfo) => {
  await page.setViewportSize(viewport)
  await page.goto('/canvas/index.html')
  const invitation = page.getByLabel('Meet your canvas agent')
  await expect(invitation).toBeVisible()
  for (const name of ['Connect through the Galta illustration']) {
    const button = invitation.getByRole('button', { name, exact: true })
    const bounds = (await button.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(64)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
    expect(bounds.y + bounds.height).toBeLessThan(viewport.height - 52)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('invitation-narrow.png') })
  await clickInvitation(page, 'Connect through the Galta illustration')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in with ChatGPT' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect(invitation).toBeVisible()
})

test('an external agent has working status and stop without a false chat composer', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { chrome: { runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      connect: () => ({ onDisconnect: { addListener() {} }, disconnect() {} }),
      sendMessage: async () => ({ ok: true })
    } } })
  })
  await installCanvasPort(page)
  await page.goto('/canvas/index.html')
  await expect(page.getByLabel('Meet your canvas agent')).toBeVisible()
  await expect.poll(() => page.evaluate(() => typeof (window as any).__beginExternalAgent)).toBe('function')
  await clickInvitation(page, 'Connect through the Galta illustration')
  const started = await page.evaluate(() => (window as any).__beginExternalAgent('Claude Code'))
  expect(started.error).toBeUndefined()
  await page.getByRole('dialog').getByRole('button', { name: 'Work in Codex or Claude Code Connected', exact: true }).click()
  await expect(page.getByText('Your AI app is connected to this canvas.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Back to your canvas' }).click()
  await expect(page.getByText('Claude Code is working', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open conversation' })).toHaveCount(0)
  await expect(page.getByLabel('Meet your canvas agent')).toHaveCount(0)
  await page.getByRole('button', { name: 'Stop agent', exact: true }).click()
  await expect(page.locator('.conversation-dock').getByRole('button', { name: 'Connect an agent', exact: true })).toBeVisible()
  await expect(page.getByLabel('Meet your canvas agent')).toHaveCount(0)
  await page.locator('.settings-corner').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Work in Codex or Claude Code', exact: true })).toBeVisible()
})
