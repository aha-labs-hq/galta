import { test, expect, type Page } from '@playwright/test'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installCanvasPort } from '../helpers/canvas-port'

async function installAccount(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => {
    const listeners = new Set<(message: unknown) => void>()
    const result = (usedPercent: number) => ({ ok: true, account: { type: 'chatgpt', planType: 'pro' }, models: [{ id: 'gpt-test', displayName: 'GPT Test', isDefault: true }], rateLimits: { primary: { usedPercent } } })
    let current: unknown = result(97), logins = 0, reads = 0
    const emit = (method: string, params: unknown) => listeners.forEach(fn => fn({ type: 'codex-notification', notification: { method, params } }))
    Object.assign(window, {
      accountFixture: { set: (value: unknown) => { current = value }, result, emit, logins: () => logins, reads: () => reads },
      chrome: {
        windows: { getCurrent: async () => ({ id: 1 }) },
        storage: { session: { get: async () => ({}) }, local: { get: async () => ({ 'galta.ai.enabled': true }), set: async () => {} } },
        runtime: {
          onMessage: { addListener: (fn: (message: unknown) => void) => listeners.add(fn), removeListener: (fn: (message: unknown) => void) => listeners.delete(fn) },
          connect: () => ({ onDisconnect: { addListener() {} }, disconnect() {} }),
          sendMessage: async (message: { type: string }) => {
            if (message.type === 'codex-connect') { reads++; return current }
            if (message.type === 'codex-login') {
              logins++; current = result(36)
              emit('account/login/completed', { loginId: 'fixture', success: true })
              return { ok: true }
            }
            return { ok: true, result: { thread: { id: 'account-fixture', turns: [] } } }
          }
        }
      }
    })
  })
  await installCanvasPort(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeVisible()
  await expect(page.locator('.canvas-notice')).toHaveCount(0)
}

async function expectUsage(page: Page, remaining: number, plan = 'Pro') {
  await expect(page.locator('.runtime-account-line')).toHaveText(`Codex · ${plan}`)
  const meter = page.getByRole('meter', { name: 'Usage remaining', exact: true })
  await expect(meter).toHaveAttribute('aria-valuenow', String(remaining))
  await expect(meter).toHaveText(`${remaining}% left`)
  await expect(page.getByRole('button', { name: 'Refresh account and usage', exact: true })).toHaveCount(0)
}

test('revoked sign-in removes stale usage, preserves the draft, and recovers only through explicit sign-in', async ({ page }) => {
  await installAccount(page)
  const draft = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  await draft.fill('Keep this draft through sign-in')
  await page.getByRole('button', { name: /^Model GPT/ }).click()
  await expectUsage(page, 3)
  await page.evaluate(() => (window as any).accountFixture.set({ ok: true, requiresAuth: true, error: 'Your Codex sign-in has expired. Sign in with ChatGPT to continue.' }))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('meter', { name: 'Usage remaining', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign in with ChatGPT', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).accountFixture.logins())).toBe(0)
  await page.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(page.getByRole('dialog', { name: 'Model settings', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('alert')).toHaveText('Your Codex sign-in has expired. Sign in with ChatGPT to continue.')
  await dialog.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Back to your canvas', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Model settings', exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Back to your canvas', exact: true }).click()
  await expect(draft).toHaveValue('Keep this draft through sign-in')
  await page.getByRole('button', { name: /^Model GPT/ }).click()
  await expectUsage(page, 64)
  await expect(page.locator('.runtime-menu [role="alert"]')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).accountFixture.logins())).toBe(1)
})

test('usage outage is visible without disabling chat, and pushed usage clears it at wide and narrow widths', async ({ page }, testInfo) => {
  await installAccount(page)
  await page.evaluate(() => {
    const f = (window as any).accountFixture, { rateLimits, ...account } = f.result(97)
    f.set({ ...account, usageError: 'Usage is unavailable.' })
  })
  await page.getByRole('button', { name: /^Model GPT/ }).click()
  await expect(page.locator('.runtime-menu [role="alert"]')).toHaveText('Usage is unavailable.')
  await expect(page.getByRole('meter', { name: 'Usage remaining', exact: true })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeVisible()
  await page.evaluate(() => (window as any).accountFixture.emit('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 38 } } }))
  await expectUsage(page, 62)
  await expect(page.locator('.runtime-menu [role="alert"]')).toHaveCount(0)
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(async () => {
      const bounds = await page.locator('.runtime-menu').boundingBox()
      return bounds && bounds.x >= 0 && bounds.x + bounds.width <= width
    }).toBe(true)
    const bounds = await page.locator('.runtime-menu').boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    expect(await page.locator('.runtime-menu').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`account-recovered-${width}.png`) })
  }
})

test('focus and account notifications refresh even after failure without reviving a previous account', async ({ page }) => {
  await installAccount(page)
  await page.evaluate(() => {
    const f = (window as any).accountFixture
    f.set({ ok: false, error: 'Could not check your Codex account. Try connecting again.' })
    window.dispatchEvent(new Event('focus'))
  })
  await expect(page.getByRole('button', { name: 'Reconnect agent', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const f = (window as any).accountFixture
    f.set({ ...f.result(2), account: { type: 'chatgpt', planType: 'plus' } })
    window.dispatchEvent(new Event('focus'))
  })
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^Model GPT/ }).click()
  await expectUsage(page, 98, 'Plus')
  await page.evaluate(() => (window as any).accountFixture.emit('account/updated', { authMode: null }))
  await expect(page.getByRole('meter', { name: 'Usage remaining', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign in with ChatGPT', exact: true })).toBeVisible()
})
