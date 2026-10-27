import { test, expect, type Locator } from '@playwright/test'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'

test('CSS and curved SVG Graphite paint agree, stay readable and respect contrast preferences', async ({ page }, info) => {
  await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeVisible()
  await page.mouse.move(0, 0)
  const rail = page.getByRole('navigation', { name: 'Galta tools', exact: true })
  const composer = page.locator('.dock-surface-bottom')
  const sample = async (surface: Locator, side: 'left' | 'right') => {
    const bytes = await surface.screenshot({ animations: 'disabled' })
    return page.evaluate(async ({ data, side }) => {
      const bitmap = await createImageBitmap(await (await fetch(data)).blob())
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0)
      // The empty inset beside controls, away from text, icons and rounded corners.
      const x = side === 'left' ? 2 : canvas.width - 3
      return [.22, .78].map(y => [...context.getImageData(x, Math.round(canvas.height * y), 1, 1).data].slice(0, 3))
    }, { data: `data:image/png;base64,${bytes.toString('base64')}`, side })
  }
  const css = await sample(rail, 'left'), svg = await sample(composer, 'right')
  await info.attach('graphite-pixels', { body: JSON.stringify({ css, svg }), contentType: 'application/json' })
  expect(css[0]![0]! - css[1]![0]!, 'the face has a restrained, actually painted light-to-shade change').toBeGreaterThan(6)
  for (let i = 0; i < css.length; i++) {
    for (let c = 0; c < 3; c++) expect(Math.abs(css[i]![c]! - svg[i]![c]!), 'CSS and SVG share the same material across their different shapes').toBeLessThanOrEqual(2)
  }
  const muted = await rail.getByRole('button', { name: 'Hand — H', exact: true }).evaluate(el => getComputedStyle(el).color.match(/[\d.]+/g)!.slice(0,3).map(Number))
  const luminance = (rgb: number[]) => rgb.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum,c,i) => sum + c * [.2126,.7152,.0722][i]!, 0)
  for (const background of [...css, ...svg]) expect((luminance(muted) + .05) / (luminance(background) + .05), 'supporting ink stays readable on the rendered face').toBeGreaterThanOrEqual(4.5)
  await page.screenshot({ path: info.outputPath('graphite-normal.png'), animations: 'disabled' })
  await rail.getByRole('button', { name: 'Select — V', exact: true }).press('Tab')
  const focused = rail.getByRole('button', { name: 'Hand — H', exact: true })
  await expect(focused).toBeFocused()
  // The screenshot completes finite transitions before pairing paint and ink.
  const focusPixels = await sample(focused, 'left')
  const ink = await focused.evaluate(el => getComputedStyle(el).color.match(/[\d.]+/g)!.slice(0,3).map(Number))
  await info.attach('graphite-focus-pixels', { body: JSON.stringify({ ink, focusPixels }), contentType: 'application/json' })
  for (const background of focusPixels) expect((luminance(ink) + .05) / (luminance(background) + .05), `keyboard ink ${ink} stays readable on the focused face ${background}`).toBeGreaterThanOrEqual(4.5)
  await page.screenshot({ path: info.outputPath('graphite-focus.png'), animations: 'disabled' })
  await page.emulateMedia({ contrast: 'more', reducedMotion: 'reduce' })
  await expect(rail).toHaveCSS('background-image', 'none')
  await expect(page.locator('.dock-surface-wash')).toHaveCSS('opacity', '0')
  const solid = await sample(composer, 'right')
  expect(solid[0]).toEqual(solid[1])
  await page.screenshot({ path: info.outputPath('graphite-contrast.png'), animations: 'disabled' })
  await page.emulateMedia({ contrast: 'no-preference', forcedColors: 'active' })
  await expect(rail).toHaveCSS('box-shadow', 'none')
  await expect(rail).toHaveCSS('outline-style', 'solid')
  await expect(page.locator('.dock-surface-wash')).toHaveCSS('opacity', '0')
  expect(await page.locator('.dock-surface-fill').evaluate(el => getComputedStyle(el).fill)).toBe(await rail.evaluate(el => getComputedStyle(el).backgroundColor))
  await page.screenshot({ path: info.outputPath('graphite-forced-colors.png'), animations: 'disabled' })
})

test('the open sheet meets the composer with no line and no gap between them', async ({ page }) => {
  await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await page.locator('.conversation-presence').evaluate(element => element.getAnimations().forEach(animation => animation.finish()))
  await page.mouse.move(0, 0)
  // The sheet draws its edge on its top and sides only; the seam is no edge.
  expect(await page.locator('.conversation-presence').evaluate(el => getComputedStyle(el).boxShadow)).not.toContain('inset')
  // The composer's body starts on the composer's own top edge, the line the
  // sheet ends on, so the two meet on the same device pixel.
  const [body, composer, sheet] = await Promise.all(['.dock-surface-bottom', '.conversation-composer', '.conversation-presence'].map(selector => page.locator(selector).evaluate(el => el.getBoundingClientRect().toJSON())))
  expect(Math.abs(body.top - composer.top)).toBeLessThan(.01)
  expect(Math.abs(sheet.bottom - composer.top)).toBeLessThan(.01)
  // The rim's crown has left the seam.
  await expect(page.locator('.dock-surface-crown')).toHaveCSS('opacity', '0')
  // Pixels: the last sheet row matches the sheet above it, and the first
  // composer row matches the composer below it.
  const rows = await page.screenshot({ clip: { x: composer.x + 24, y: composer.top - 3, width: 1, height: 6 }, animations: 'disabled' }).then(bytes => page.evaluate(async data => {
    const bitmap = await createImageBitmap(await (await fetch(data)).blob())
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0)
    return Array.from({ length: canvas.height }, (_, y) => [...context.getImageData(0, y, 1, 1).data].slice(0, 3).reduce((sum, c) => sum + c, 0) / 3)
  }, `data:image/png;base64,${bytes.toString('base64')}`))
  const half = rows.length / 2
  expect(Math.abs(rows[half - 1]! - rows[0]!), `no line closes the sheet: ${rows}`).toBeLessThanOrEqual(6)
  expect(Math.abs(rows[half]! - rows[rows.length - 1]!), `no line opens the composer: ${rows}`).toBeLessThanOrEqual(6)
})
