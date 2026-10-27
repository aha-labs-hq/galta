import { test, expect, type Page } from '@playwright/test'

const VALID = 'sk-valid-provider-key'

/** Stands in for the background and the companion: installation status and provider keys. */
async function fixture(page: Page, options: { unavailable?: boolean } = {}) {
  await page.addInitScript(({ valid, unavailable }) => {
    const connected: Record<string, boolean> = { byteplus: false, openrouter: false, fal: false, higgsfield: false }
    const names: Record<string, string> = { byteplus: 'BytePlus', openrouter: 'OpenRouter', fal: 'fal', higgsfield: 'Higgsfield' }
    const providers = () => Object.entries(connected).map(([id, value]) => ({ id, connected: value }))
    const requests: unknown[] = []
    Object.assign(window, { generationRequests: requests, chrome: { runtime: {
      id: 'galta-test', getURL: (path: string) => new URL(`/${path}`, location.origin).href,
      onMessage: { addListener() {}, removeListener() {} },
      connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} }),
      async sendMessage(message: any) {
        if (message.type === 'setup-status') return { state: 'ready', health: { protocol: 1, version: '0.1.1', releaseId: 'test', channel: 'development', capabilities: ['canvas/1', 'codex/1', 'mcp/1'], runtime: { available: true }, mcpCommand: '/Applications/Galta.app/galta-mcp' } }
        if (message.type !== 'media-settings') return { ok: true }
        requests.push(message.request)
        if (unavailable) return { ok: false, error: 'Open Galta for Mac to connect a provider.' }
        const { action, provider, key } = message.request
        await new Promise(resolve => setTimeout(resolve, 120))
        if (action === 'connect') {
          if (key.trim() !== valid) return { ok: false, error: `${names[provider]} didn’t accept this key.`, providers: providers() }
          connected[provider] = true
        }
        if (action === 'disconnect') connected[provider] = false
        return { ok: true, providers: providers() }
      }
    } } })
  }, { valid: VALID, unavailable: options.unavailable ?? false })
}
const open = async (page: Page) => {
  await page.goto('/canvas/index.html')
  await page.locator('.settings-corner').getByRole('button', { name: 'Settings', exact: true }).click()
  return page.getByRole('dialog')
}
const provider = (page: Page, name: string) => page.getByRole('dialog').locator('.generation-provider').filter({ hasText: name })

test('generation providers connect inside Settings, with keys checked first and never shown again', async ({ page }, info) => {
  await fixture(page)
  const dialog = await open(page)
  const row = dialog.getByRole('button', { name: /^Generation/ })
  await expect(row).toContainText('Not connected')
  await dialog.screenshot({ path: info.outputPath('connections.png'), animations: 'disabled' })
  await row.click()
  await expect(dialog).toHaveAccessibleName('Generation')
  const byteplus = provider(page, 'BytePlus'), openrouter = provider(page, 'OpenRouter')
  await expect(byteplus).toContainText('Images · Video')
  await expect(openrouter).toContainText('Images · Video · Speech')
  await expect(provider(page, 'fal')).toContainText('Images · Video · Speech')
  await expect(provider(page, 'Higgsfield')).toContainText('Images · Video')
  await expect(byteplus.locator('.generation-connect')).toBeEnabled()
  await dialog.screenshot({ path: info.outputPath('generation.png'), animations: 'disabled' })

  await byteplus.locator('.generation-connect').click()
  const key = byteplus.getByLabel('BytePlus API key', { exact: true })
  await expect(key).toBeFocused()
  await expect(key).toHaveAttribute('type', 'password')
  await expect(byteplus.getByRole('link', { name: 'Get a key' })).toHaveAttribute('href', /byteplus/)
  await key.fill('sk-wrong')
  await key.press('Enter')
  await expect(byteplus.getByRole('alert')).toHaveText('BytePlus didn’t accept this key.')
  await expect(key).toBeFocused()
  await dialog.screenshot({ path: info.outputPath('generation-refused.png'), animations: 'disabled' })
  // Escape folds the field away before it would close the dialog.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(byteplus.locator('.generation-connect')).toBeFocused()

  await byteplus.locator('.generation-connect').click()
  await key.fill(VALID)
  await key.press('Enter')
  await expect(byteplus.getByText('Connected', { exact: true })).toBeVisible()
  expect(await page.locator('body').innerText()).not.toContain(VALID)
  await dialog.screenshot({ path: info.outputPath('generation-connected.png'), animations: 'disabled' })

  await dialog.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(dialog).toHaveAccessibleName('Settings')
  await expect(dialog.getByRole('button', { name: /^Generation/ })).toContainText('BytePlus')
  await dialog.getByRole('button', { name: /^Generation/ }).click()
  await byteplus.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(byteplus.locator('.generation-connect')).toBeVisible()
  const changes = await page.evaluate(() => (window as any).generationRequests.map((request: any) => request.action).filter((action: string) => action !== 'status'))
  expect(changes).toEqual(['connect', 'connect', 'disconnect'])
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('the generation view fits a narrow panel', async ({ page }, info) => {
  await fixture(page)
  await page.setViewportSize({ width: 360, height: 640 })
  const dialog = await open(page)
  await dialog.getByRole('button', { name: /^Generation/ }).click()
  const openrouter = provider(page, 'OpenRouter')
  await openrouter.locator('.generation-connect').click()
  await expect(openrouter.getByLabel('OpenRouter API key', { exact: true })).toBeFocused()
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  // Higgsfield shows its key in two parts; the field says how to paste them.
  const higgsfield = provider(page, 'Higgsfield')
  await higgsfield.locator('.generation-connect').click()
  const key = higgsfield.getByLabel('Higgsfield API key', { exact: true })
  await expect(key).toBeFocused()
  await expect(key).toHaveAttribute('placeholder', 'Paste key ID:secret')
  await expect(higgsfield.getByRole('link', { name: 'Get a key' })).toHaveAttribute('href', 'https://open.higgsfield.ai/api-keys')
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('generation-narrow.png'), animations: 'disabled' })
})

test('without the Mac app the view says what to do and offers no dead controls', async ({ page }) => {
  await fixture(page, { unavailable: true })
  const dialog = await open(page)
  await expect(dialog.getByRole('button', { name: /^Generation/ })).toContainText('Unavailable')
  await dialog.getByRole('button', { name: /^Generation/ }).click()
  await expect(dialog.getByText('Open Galta for Mac to connect a provider.')).toBeVisible()
  await expect(dialog.locator('.generation-connect')).toHaveCount(0)
})
