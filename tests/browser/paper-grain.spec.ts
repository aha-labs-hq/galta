import { test, expect } from '@playwright/test'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'

/* The canvas paper is printed with a still grain (tokens.css `--paper-grain`). It lies under the
   artwork: the engine draws on a transparent scene, and the paper is the stylesheet's beneath it,
   so neither an export nor an agent's preview carries it. Contrast preferences take it away (the
   browser cannot emulate reduced transparency, which tokens.css treats the same). */
test('the paper grain lies under the artwork, and gives way to contrast preferences', async ({ page }, info) => {
  await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect(page.locator('.galta-canvas .excalidraw')).toBeVisible()
  const seen = () => page.evaluate(() => {
    const paper = getComputedStyle(document.querySelector('.galta-canvas .excalidraw')!)
    const scene = document.querySelector<HTMLCanvasElement>('.galta-canvas canvas.excalidraw__canvas.static')!
    return { grain: paper.backgroundImage, paper: paper.backgroundColor, sceneAlpha: scene.getContext('2d')!.getImageData(2, 2, 1, 1).data[3] }
  })
  const normal = await seen()
  expect(normal.grain, 'the paper wears the grain').toContain('data:image/svg+xml')
  expect(normal.paper, 'the paper keeps its colour beneath the grain').toBe('rgb(247, 247, 247)')
  expect(normal.sceneAlpha, 'the engine draws the artwork on a transparent scene').toBe(0)
  // the grain is visible on screen: an empty stretch of paper is not one flat colour
  const bytes = await page.locator('.galta-canvas .excalidraw').screenshot({ animations: 'disabled' })
  const spread = await page.evaluate(async data => {
    const bitmap = await createImageBitmap(await (await fetch(data)).blob())
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0)
    const row = context.getImageData(Math.round(bitmap.width * .45), Math.round(bitmap.height * .4), 120, 1).data
    const values = [...row].filter((_, i) => i % 4 === 0)
    return Math.max(...values) - Math.min(...values)
  }, `data:image/png;base64,${bytes.toString('base64')}`)
  await info.attach('paper-spread', { body: String(spread), contentType: 'text/plain' })
  expect(spread, 'the grain is a breath, not a texture that competes with the artwork').toBeGreaterThan(2)
  expect(spread).toBeLessThan(40)
  for (const media of [{ forcedColors: 'active' as const }, { contrast: 'more' as const }]) {
    await page.emulateMedia(media)
    expect((await seen()).grain, `no grain with ${JSON.stringify(media)}`).not.toContain('url(')
    await page.emulateMedia({ forcedColors: null, contrast: null })
  }
})
