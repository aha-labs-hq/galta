import { test, expect } from '@playwright/test'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'

test('shape palette honors advertised keys and reopens on the current tool', async ({ page }) => {
  await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  const trigger = page.getByRole('button', { name: 'Shapes and more tools', exact: true })
  const palette = page.getByRole('dialog', { name: 'Shapes and more tools', exact: true })
  await trigger.press('Enter')
  await page.getByRole('button', { name: 'Rectangle', exact: true }).press('o')
  await expect(palette).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(trigger).toHaveAttribute('aria-pressed', 'true')
  await trigger.press('Enter')
  const ellipse = page.getByRole('button', { name: 'Ellipse', exact: true })
  await expect(ellipse).toHaveAttribute('aria-pressed', 'true')
  await expect(ellipse).toBeFocused()
  await ellipse.press('Tab')
  const diamond = page.getByRole('button', { name: 'Diamond', exact: true })
  await expect(diamond).toBeFocused()
  await diamond.press('Space')
  await expect(palette).toHaveCount(0)
  await trigger.press('Enter')
  await expect(diamond).toHaveAttribute('aria-pressed', 'true')
  await expect(diamond).toBeFocused()
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })
  await expect(diamond).toHaveCSS('outline-style', 'solid')
  await expect(diamond).toHaveCSS('outline-width', '2px')
  await expect(palette).toHaveCSS('animation-duration', '0s')
  const wrap = page.getByRole('button', { name: 'Box selection Wrap', exact: true })
  await wrap.click()
  await expect(page.getByRole('group', { name: 'Box selection', exact: true }).locator('.style-choice-indicator')).toHaveCSS('transition-duration', /^0s(?:, 0s)*$/)
  await wrap.press('Space')
  await expect(wrap).toHaveAttribute('aria-pressed', 'true')
  await expect(wrap).toHaveCSS('outline-style', 'solid')
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

for (const touch of [false, true]) test.describe(touch ? 'Touch drawing palette' : 'Mouse drawing palette', () => {
  test.use({ hasTouch: touch })
  test('all shape and selection choices remain reachable in narrow and short editors', async ({ page }, info) => {
    await installReturningAccount(page)
    await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
    for (const width of [320, 480, 980]) {
      await page.setViewportSize({ width, height: 540 })
      await page.getByRole('button', { name: 'Shapes and more tools', exact: true }).click()
      const palette = page.getByRole('dialog', { name: 'Shapes and more tools', exact: true })
      const bounds = (await palette.boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(8)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8)
      expect(bounds.y).toBeGreaterThanOrEqual(8)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(532)
      expect(await palette.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      for (const name of ['Rectangle', 'Ellipse', 'Diamond', 'Line', 'Frame', 'Arrow', 'Box selection Overlap', 'Box selection Wrap']) {
        const button = palette.getByRole('button', { name, exact: true })
        await button.scrollIntoViewIfNeeded()
        const rect = (await button.boundingBox())!
        expect(rect.width).toBeGreaterThanOrEqual(touch ? 44 : 32)
        expect(rect.height).toBeGreaterThanOrEqual(touch ? 44 : 32)
        expect(await button.evaluate(el => {
          const r = el.getBoundingClientRect()
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        }), `${name} receives pointer input at ${width}px`).toBe(true)
      }
      await palette.getByRole('button', { name: 'Box selection Wrap', exact: true }).click()
      await expect(palette.getByRole('button', { name: 'Box selection Wrap', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(palette.getByRole('button', { name: 'Box selection Wrap', exact: true })).toHaveAccessibleDescription('Include fully enclosed objects.')
      await page.mouse.move(width - 8, 100)
      await page.screenshot({ path: info.outputPath(`palette-${width}.png`), animations: 'disabled' })
      await page.keyboard.press('Escape')
      await expect(palette).toHaveCount(0)
    }
  })
})

test('desktop text size presets retain full compact targets after the wider labels', async ({ page }) => {
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.getByRole('button', { name: 'Text — T', exact: true }).click()
  await page.getByRole('button', { name: 'Drawing style', exact: true }).click()
  const sizes = page.getByRole('group', { name: 'Text size', exact: true })
  for (const button of await sizes.getByRole('button').all()) {
    const bounds = (await button.boundingBox())!
    expect(bounds.width).toBeGreaterThanOrEqual(32)
    expect(bounds.height).toBeGreaterThanOrEqual(32)
  }
  await sizes.getByRole('button', { name: 'Text size 36', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue('36')
})
