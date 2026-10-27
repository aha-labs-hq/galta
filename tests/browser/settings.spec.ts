import { test, expect, type Page } from '@playwright/test'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'

const ADA = { id: 'u1', name: '', email: 'ada@example.com', image: null }

/** Stands in for the background's account owner (background/account.ts, unit
 * tested in account-background.test.mjs) and the Mac app's status. `finishGoogle`
 * plays the account service's handoff page. */
async function fixture(page: Page, options: { connected?: boolean; signedIn?: boolean; user?: typeof ADA; unavailable?: boolean } = {}) {
  if (options.connected) await installReturningAccount(page)
  await page.addInitScript(({ connected, signedIn, ada, unavailable }) => {
    const listeners = new Set<(changes: Record<string, unknown>) => void>()
    let state = { user: signedIn ? ada : null as typeof ada | null, ended: false, google: null as string | null }
    const requests: unknown[] = []
    const changed = () => { for (const listener of listeners) listener({ 'galta.account': {} }) }
    const answer = async (request: any) => {
      requests.push(request)
      await new Promise(resolve => setTimeout(resolve, 60))
      switch (request.action) {
        case 'send-code': return request.email.includes('@') ? { ok: true, state } : { ok: false, error: 'Enter a valid email address.', state }
        case 'verify-code':
          if (request.code !== '123456') return { ok: false, error: 'That code isn’t right.', state }
          state = { user: { ...ada, email: request.email }, ended: false, google: null }; return { ok: true, state }
        case 'google': state = { ...state, google: 'waiting' }; return { ok: true, state }
        case 'google-cancel': state = { ...state, google: null }; return { ok: true, state }
        case 'rename': state = { ...state, user: { ...state.user!, name: request.name.trim() } }; return { ok: true, state }
        case 'sign-out': state = { user: null, ended: false, google: null }; return { ok: true, state }
        case 'delete':
          if (request.code !== '123456') return { ok: false, error: 'That code isn’t right.', state }
          state = { user: null, ended: false, google: null }; return { ok: true, state }
        default: return { ok: true, state }
      }
    }
    const chrome = (window as any).chrome ?? {}
    const send = chrome.runtime?.sendMessage?.bind(chrome.runtime)
    Object.assign(window, {
      accountRequests: requests,
      accountAvailable: !unavailable,
      finishGoogle() { state = { user: { ...ada, name: 'Ada Lovelace' }, ended: false, google: null }; changed() },
      endGoogle(result: string) { state = { ...state, google: result }; changed() },
      chrome: { ...chrome,
        storage: { ...chrome.storage, onChanged: { addListener: (listener: any) => listeners.add(listener), removeListener: (listener: any) => listeners.delete(listener) } },
        runtime: { id: 'galta-test', getURL: (path: string) => new URL(`/${path}`, location.origin).href, onMessage: { addListener() {}, removeListener() {} },
          connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} }),
          ...chrome.runtime,
          async sendMessage(message: any) {
            if (message.type === 'account') return (window as any).accountAvailable ? answer(message.request) : undefined
            if (message.type === 'setup-status') return { state: 'ready', health: { protocol: 1, version: '0.1.1', releaseId: 'test', channel: 'development', capabilities: ['canvas/1', 'codex/1', 'mcp/1'], runtime: { available: true }, mcpCommand: '/Applications/Galta.app/galta-mcp' } }
            if (message.type === 'media-settings') return { ok: true, providers: [{ id: 'byteplus', connected: true }, { id: 'openrouter', connected: false }] }
            if (message.type === 'codex-connect') return connected
              ? { ...await send(message), account: { type: 'chatgpt', planType: 'pro' } }
              : { ok: true, requiresAuth: true }
            return connected && send ? send(message) : { ok: true }
          } } },
    })
  }, { connected: Boolean(options.connected), signedIn: Boolean(options.signedIn), ada: options.user ?? ADA, unavailable: Boolean(options.unavailable) })
}

const corner = (page: Page) => page.locator('.settings-corner').getByRole('button', { name: 'Settings', exact: true })
/** Behind the open dialog the corner leaves the accessibility tree; read its attributes. */
const signedInAs = (page: Page) => page.locator('.settings-corner-button')
const requests = (page: Page) => page.evaluate(() => (window as any).accountRequests.map((request: any) => request.action).filter((action: string) => action !== 'status'))

test('an unavailable account background reports the failure and clears it after a verified response', async ({ page }) => {
  await fixture(page, { unavailable: true })
  await page.goto(`${acceptanceOrigin}/canvas/index.html`)
  await corner(page).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Reload this canvas to reconnect to Galta.', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Checking…', { exact: true })).toHaveCount(0)
  await dialog.locator('.settings-row-hero').click()
  await expect(dialog.getByRole('alert')).toHaveText('Reload this canvas to reconnect to Galta.')
  await page.evaluate(() => { (window as any).accountAvailable = true; window.dispatchEvent(new Event('focus')) })
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(dialog.getByText('One Aha Labs account for every app', { exact: true })).toBeVisible()
})

test('narrow Settings keeps every destination and connected provider readable', async ({ page }, info) => {
  await fixture(page)
  await page.setViewportSize({ width: 288, height: 540 })
  await page.goto(`${acceptanceOrigin}/canvas/index.html`)
  await corner(page).click()
  const dialog = page.getByRole('dialog')
  await dialog.screenshot({ path: info.outputPath('settings-narrow.png'), animations: 'disabled' })
  expect(await dialog.locator('.settings-row-label, .settings-row-detail').evaluateAll(labels => labels.filter(label => label.scrollWidth > label.clientWidth + 1).map(label => label.textContent))).toEqual([])
  await dialog.getByRole('button', { name: /^Generation/ }).click()
  await dialog.screenshot({ path: info.outputPath('generation-narrow.png'), animations: 'disabled' })
  expect(await dialog.locator('.settings-row-label').evaluateAll(labels => labels.filter(label => label.scrollWidth > label.clientWidth + 1).map(label => label.textContent))).toEqual([])
})

test('connected built-in chat does not imply that another AI app needs connecting', async ({ page }, info) => {
  await fixture(page, { connected: true, signedIn: true, user: { ...ADA, name: 'Ada Lovelace' } })
  await page.goto(`${acceptanceOrigin}/canvas/index.html`)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeVisible()
  await corner(page).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: /^Chat in Galta/ })).toHaveText('Chat in GaltaChatGPT · Pro')
  await expect(dialog.getByRole('button', { name: 'Work in Codex or Claude Code', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Work in Codex or Claude Code', exact: true })).toHaveAccessibleDescription('')
  await expect(dialog.getByText('Not connected', { exact: true })).toHaveCount(0)
  await dialog.screenshot({ path: info.outputPath('settings-connected.png'), animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Work in Codex or Claude Code', exact: true }).click()
  await expect(dialog).toHaveAccessibleDescription('Chat there. See changes on your canvas.')
  await expect(dialog.getByRole('button', { name: 'Copy instructions', exact: true })).toBeVisible()
  await expect(dialog.getByText('Galta for Mac', { exact: true })).toBeHidden()
  await expect(dialog.getByText('Your AI app is connected to this canvas.', { exact: true })).toHaveCount(0)
  await dialog.screenshot({ path: info.outputPath('other-ai-apps.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 288, height: 500 })
  await dialog.screenshot({ path: info.outputPath('other-ai-apps-narrow.png'), animations: 'disabled' })
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await dialog.getByText('Connection details', { exact: true }).press('Enter')
  await expect(dialog.locator('.settings-details .settings-row')).toHaveText('Galta for MacReady')
  await dialog.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Work in Codex or Claude Code', exact: true })).toBeFocused()
  await expect(dialog.getByRole('button', { name: /^Chat in Galta/ })).toHaveText('Chat in GaltaChatGPT · Pro')
  await dialog.screenshot({ path: info.outputPath('settings-connected-narrow.png'), animations: 'disabled' })
  expect(await dialog.locator('nav.settings-list .settings-row:not(.settings-row-hero) .settings-row-label').evaluateAll(labels => labels.every(label => label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= label.clientHeight + 1))).toBe(true)
})

test('a long account name and email keep profile actions inside a narrow dialog', async ({ page }, info) => {
  await fixture(page, { signedIn: true, user: { ...ADA, name: 'Alexandra '.repeat(8).trim(), email: `${'a'.repeat(60)}@example.com` } })
  await page.setViewportSize({ width: 320, height: 540 })
  await page.goto(`${acceptanceOrigin}/canvas/index.html`)
  await corner(page).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('.settings-row-hero').click()
  const controlsFit = () => dialog.locator('.settings-view').evaluate(element => {
    const frame = element.getBoundingClientRect()
    return Array.from(element.querySelectorAll('.settings-row, .settings-row-state, .settings-action')).every(control => {
      const box = control.getBoundingClientRect()
      return box.left >= frame.left - 1 && box.right <= frame.right + 1
    })
  })
  await dialog.screenshot({ path: info.outputPath('profile-long.png'), animations: 'disabled' })
  expect(await controlsFit()).toBe(true)
  await dialog.getByRole('button', { name: 'Delete account', exact: true }).click()
  await dialog.screenshot({ path: info.outputPath('delete-long.png'), animations: 'disabled' })
  expect(await controlsFit()).toBe(true)
})

test('code entry remains visible in high contrast and still with reduced motion', async ({ page }, info) => {
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })
  await fixture(page)
  await page.setViewportSize({ width: 288, height: 500 })
  await page.goto(`${acceptanceOrigin}/canvas/index.html`)
  await corner(page).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('.settings-row-hero').click()
  await dialog.getByRole('textbox', { name: 'Email address' }).fill('ada@example.com')
  await dialog.getByRole('button', { name: 'Continue with email', exact: true }).click()
  const code = dialog.getByRole('textbox', { name: '6-digit code' })
  await expect(code).toBeFocused()
  await code.pressSequentially('12')
  await code.press('ArrowLeft')
  await expect(dialog.locator('.settings-code-cell').nth(1)).toHaveAttribute('data-active', 'true')
  expect(await dialog.locator('.settings-code-cell[data-active]').evaluate(element => ({ border: getComputedStyle(element).borderTopWidth, outline: getComputedStyle(element).outlineWidth }))).toEqual({ border: '1px', outline: '2px' })
  expect(await dialog.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBe(0)
  await dialog.screenshot({ path: info.outputPath('code-forced-colors.png') })
})

test('pasting a spaced email code submits all six digits once', async ({ page }) => {
  await fixture(page)
  await page.goto(`${acceptanceOrigin}/canvas/index.html`)
  await corner(page).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('.settings-row-hero').click()
  await dialog.getByRole('textbox', { name: 'Email address' }).fill('ada@example.com')
  await dialog.getByRole('button', { name: 'Continue with email', exact: true }).click()
  const code = dialog.getByRole('textbox', { name: '6-digit code' })
  await expect(code).toBeFocused()
  await code.evaluate(element => {
    const data = new DataTransfer()
    data.setData('text/plain', '123 456')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(signedInAs(page)).toHaveAttribute('aria-description', 'Signed in as ada@example.com')
  expect(await requests(page)).toEqual(['send-code', 'verify-code'])
})

test('keyboard navigation announces the next settings view and returns to its row', async ({ page }) => {
  await fixture(page)
  await page.goto(`${acceptanceOrigin}/canvas/index.html`)
  await corner(page).focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  for (const name of ['Chat in Galta', 'Work in Codex or Claude Code', 'Generation']) {
    const row = dialog.getByRole('button', { name: new RegExp(`^${name}`) })
    await row.focus()
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('heading', { name, exact: true })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(dialog.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(row).toBeFocused()
  }
})

test('the bottom-left corner opens Settings, every setting is one row away, and closing returns to the corner', async ({ page }, info) => {
  await fixture(page)
  await page.goto(`${acceptanceOrigin}/canvas/index.html`)
  await corner(page).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toHaveAccessibleName('Settings')
  const rows = dialog.getByRole('navigation', { name: 'Settings' }).getByRole('button')
  await expect(rows).toHaveText([/^Sign in\s*One Aha Labs account for every app/, /^Chat in Galta\s*Set up/, /^Work in Codex or Claude Code$/, /^Generation\s*BytePlus/])
  await dialog.screenshot({ path: info.outputPath('settings.png'), animations: 'disabled' })
  // Each view is named after the row that opened it, and Back names where it goes.
  for (const [row, title] of [[/^Sign in/, 'Sign in'], [/^Chat in Galta/, 'Chat in Galta'], [/^Work in Codex or Claude Code/, 'Work in Codex or Claude Code'], [/^Generation/, 'Generation']] as const) {
    await rows.filter({ hasText: row }).click()
    await expect(dialog).toHaveAccessibleName(title)
    await dialog.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(dialog).toHaveAccessibleName('Settings')
  }
  await expect(dialog.getByRole('button', { name: 'Keep drawing' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(corner(page)).toBeFocused()
  // The model popover no longer carries a settings action of its own.
  await expect(page.getByRole('button', { name: 'Connections', exact: true })).toHaveCount(0)
})

test('an emailed code signs in without leaving the canvas; name and sign-out follow', async ({ page }, info) => {
  await fixture(page)
  await page.goto(`${acceptanceOrigin}/canvas/index.html`)
  await corner(page).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('.settings-row-hero').click()
  const email = dialog.getByRole('textbox', { name: 'Email address', exact: true })
  await expect(email).toBeFocused()
  await dialog.screenshot({ path: info.outputPath('sign-in.png'), animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Continue with email', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Enter your email address.')
  await email.fill('ada@example.com')
  await email.press('Enter')
  await expect(dialog).toHaveAccessibleName('Check your email')
  await expect(dialog).toHaveAccessibleDescription('We sent a 6-digit code to ada@example.com.')
  const code = dialog.getByRole('textbox', { name: '6-digit code', exact: true })
  await expect(code).toBeFocused()
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code')
  await expect(dialog.getByRole('button', { name: /^Resend in 0:\d\d$/ })).toBeDisabled()
  await code.pressSequentially('11')
  await expect(dialog.locator('.settings-code-cell[data-filled]')).toHaveCount(2)
  await expect(dialog.locator('.settings-code-cell').nth(2)).toHaveAttribute('data-active', 'true')
  // The sixth digit submits; a refused code marks the cells and keeps the field.
  await code.pressSequentially('1111')
  await expect(dialog.getByRole('alert')).toHaveText('That code isn’t right.')
  await expect(dialog.locator('.settings-code')).toHaveAttribute('data-invalid', 'true')
  await dialog.screenshot({ path: info.outputPath('code-refused.png'), animations: 'disabled' })
  await code.fill('')
  await code.pressSequentially('123456')
  await expect(dialog).toHaveAccessibleName('Your account')
  await expect(signedInAs(page)).toHaveAttribute('aria-description', 'Signed in as ada@example.com')
  await expect(page.locator('.settings-corner .account-avatar-initial')).toHaveText('A')
  const nameRow = dialog.getByRole('button', { name: /^Name/ })
  await expect(nameRow).toHaveText(/Not set\s*Edit/)
  await nameRow.click()
  const name = dialog.getByRole('textbox', { name: 'Name', exact: true })
  await expect(name).toBeFocused()
  // Escape folds the field and keeps Settings open.
  await name.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(nameRow).toBeFocused()
  await nameRow.click()
  await name.fill('Ada Lovelace')
  await name.press('Enter')
  await expect(dialog).toHaveAccessibleName('Ada Lovelace')
  await expect(nameRow).toHaveText(/Ada Lovelace\s*Edit/)
  await expect(nameRow).toBeFocused()
  await dialog.screenshot({ path: info.outputPath('profile.png'), animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(dialog.locator('.settings-row-hero')).toHaveText(/Ada Lovelace\s*ada@example.com/)
  await dialog.locator('.settings-row-hero').click()
  await dialog.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(dialog).toHaveAccessibleName('Sign in')
  await expect(dialog.getByRole('status')).toHaveText('You’re signed out.')
  await expect(signedInAs(page)).not.toHaveAttribute('aria-description')
  expect(await requests(page)).toEqual(['send-code', 'verify-code', 'verify-code', 'rename', 'sign-out'])
})

test('Google sign-in waits for its tab, and a sign-in elsewhere lands in every open Galta', async ({ page }, info) => {
  await fixture(page)
  await page.goto(`${acceptanceOrigin}/canvas/index.html`)
  await corner(page).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('.settings-row-hero').click()
  await dialog.getByRole('button', { name: 'Continue with Google', exact: true }).click()
  await expect(dialog).toHaveAccessibleName('Continue in the new tab')
  await expect(dialog.getByRole('status')).toHaveText('Waiting for Google')
  await dialog.screenshot({ path: info.outputPath('google-waiting.png'), animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveAccessibleName('Sign in')
  await dialog.getByRole('button', { name: 'Continue with Google', exact: true }).click()
  await page.evaluate(() => (window as any).finishGoogle())
  await expect(dialog).toHaveAccessibleName('Ada Lovelace')
  await expect(signedInAs(page)).toHaveAttribute('aria-description', 'Signed in as Ada Lovelace')
  await expect(page.locator('.settings-corner-avatar')).toHaveClass(/is-arriving/)
  expect(await requests(page)).toEqual(['google', 'google-cancel', 'google'])
})

test('a Google result reports once, where Google is, and never as a bad address', async ({ page }) => {
  await fixture(page)
  await page.goto(`${acceptanceOrigin}/canvas/index.html`)
  await corner(page).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('.settings-row-hero').click()
  await dialog.getByRole('button', { name: 'Continue with Google', exact: true }).click()
  await expect(dialog).toHaveAccessibleName('Continue in the new tab')
  await page.evaluate(() => (window as any).endGoogle('cancelled'))
  await expect(dialog.getByRole('alert')).toHaveText('Google sign-in was cancelled.')
  await expect(dialog.getByRole('textbox', { name: 'Email address' })).not.toHaveAttribute('aria-invalid')
  // Leaving and coming back does not bring an old result back.
  await dialog.getByRole('button', { name: 'Settings', exact: true }).click()
  await dialog.locator('.settings-row-hero').click()
  await expect(dialog).toHaveAccessibleName('Sign in')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
})

test('deleting the account needs a code and leaves Galta signed out with the canvas intact', async ({ page }, info) => {
  await fixture(page, { signedIn: true })
  await page.goto(`${acceptanceOrigin}/canvas/index.html`)
  await corner(page).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('.settings-row-hero').click()
  await dialog.getByRole('button', { name: 'Delete account', exact: true }).click()
  await expect(dialog).toHaveAccessibleName('Delete account')
  await dialog.getByRole('button', { name: 'Send verification code', exact: true }).click()
  const code = dialog.getByRole('textbox', { name: '6-digit code', exact: true })
  await expect(code).toBeFocused()
  const remove = dialog.getByRole('button', { name: 'Delete account', exact: true })
  await expect(remove).toBeDisabled()
  // A complete code does not delete by itself; deleting is always a click.
  await code.pressSequentially('123456')
  await expect(dialog).toHaveAccessibleName('Delete account')
  await expect(remove).toBeEnabled()
  await dialog.screenshot({ path: info.outputPath('delete.png'), animations: 'disabled' })
  await remove.click()
  await expect(dialog).toHaveAccessibleName('Sign in')
  await expect(dialog.getByRole('status')).toHaveText('Your Aha Labs account was deleted.')
  expect(await requests(page)).toEqual(['send-code', 'delete'])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('region', { name: /^Galta canvas/ })).toBeVisible()
})

test('Settings grows out of the control that opened it', async ({ page }) => {
  await fixture(page)
  await page.goto(`${acceptanceOrigin}/canvas/index.html`)
  const button = (await corner(page).boundingBox())!
  await corner(page).click()
  const origin = await page.getByRole('dialog').evaluate(element => getComputedStyle(element).getPropertyValue('--settings-origin'))
  const [x, y] = origin.match(/-?\d+(\.\d+)?px/g)!.map(Number.parseFloat)
  const view = page.viewportSize()!
  expect(Math.abs(view.width / 2 + x! - (button.x + button.width / 2))).toBeLessThanOrEqual(1)
  expect(Math.abs(view.height / 2 + y! - (button.y + button.height / 2))).toBeLessThanOrEqual(1)
})

for (const size of [{ width: 1440, height: 900 }, { width: 980, height: 700 }, { width: 620, height: 640 }, { width: 480, height: 640 }, { width: 360, height: 540 }]) {
  test(`the settings corner keeps clear of the composer and the tools at ${size.width} × ${size.height}`, async ({ page }, info) => {
    await fixture(page, { connected: true, signedIn: true })
    await page.setViewportSize(size)
    await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
    await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeVisible()
    const box = async (selector: string) => (await page.locator(selector).boundingBox())!
    const apart = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y
    // Layout follows the composer as it grows; judge it once it has settled.
    const check = async (label: string) => {
      await expect.poll(async () => {
        const cornerBox = await box('.settings-corner'), dock = await box('.drawing-dock'), composer = await box('.conversation-dock')
        return [apart(cornerBox, composer) || 'corner and composer overlap', apart(cornerBox, dock) || 'corner and tools overlap',
          cornerBox.y - (dock.y + dock.height) >= 16 || 'tools lose their clearance', cornerBox.x === dock.x || 'corner leaves the tools’ edge'].filter(item => item !== true)
      }, { message: label }).toEqual([])
      return { cornerBox: await box('.settings-corner'), composer: await box('.conversation-dock') }
    }
    const { cornerBox, composer } = await check('at rest')
    if (cornerBox.y + cornerBox.height <= composer.y) expect(composer.y - (cornerBox.y + cornerBox.height)).toBeCloseTo(8, 0)
    else {
      // Beside the composer, the corner shares the footer's line.
      const footer = await box('.composer-footer')
      expect(Math.abs(cornerBox.y + cornerBox.height / 2 - (footer.y + footer.height / 2))).toBeLessThanOrEqual(1)
    }
    const handle = page.getByRole('slider', { name: 'Move composer', exact: true })
    await handle.focus()
    await page.keyboard.press('Home')
    await check('composer slid left')
    await page.keyboard.press('End')
    await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('one\ntwo\nthree\nfour\nfive')
    await check('multiline draft')
    await page.screenshot({ path: info.outputPath(`corner-${size.width}.png`), animations: 'disabled' })
  })
}
