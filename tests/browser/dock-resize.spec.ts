import { test, expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'

for (const entry of ['sidepanel', 'canvas']) test(`${entry} composer outline and floating tools track each painted draft size`, async ({ page }, info) => {
  await installReturningAccount(page)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    const errors: string[] = []
    window.addEventListener('error', event => errors.push(event.message))
    ;(window as any).__layoutErrors = errors
  })
  await page.setViewportSize({ width: 440, height: 540 })
  await page.goto(`${acceptanceOrigin}/${entry}/index.html`)
  const input = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  await expect(input).toBeVisible()
  await expect(page.locator('.drawing-dock')).toHaveAttribute('data-overflow', 'false')
  await page.evaluate(() => {
    const samples: unknown[] = [], notifications: unknown[] = []
    const read = () => [...document.querySelectorAll<SVGSVGElement>('.dock-surface')].map(svg => {
        const rect = svg.getBoundingClientRect(), body = svg.getBBox()
        return { width: rect.width, height: rect.height, depth: body.height, length: body.width + body.x * 2 }
    })
    const observer = new ResizeObserver(() => notifications.push(...read()))
    document.querySelectorAll<SVGSVGElement>('.dock-surface').forEach(svg => observer.observe(svg))
    ;(window as any).__dockResize = { samples, notifications, read }
  })
  // A sibling can resize between resize-observer callbacks, followed by its
  // own deeper notification before paint. Await the whole rendering cycle and
  // hold the next mutation until this sample is read; arbitrary observer tasks
  // can instead run after the next viewport change but before its paint.
  const painted = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => {
    setTimeout(() => {
      const record = (window as any).__dockResize
      record.samples.push(...record.read())
      resolve()
    }, 0)
  })))
  await painted()
  await input.fill('第一行')
  await painted()
  for (let line = 0; line < 6; line++) { await input.press('Shift+Enter'); await painted() }
  await expect(page.locator('.drawing-dock')).toHaveAttribute('data-overflow', 'true')
  for (let line = 0; line < 6; line++) { await input.press('Backspace'); await painted() }
  await expect(page.locator('.drawing-dock')).toHaveAttribute('data-overflow', 'false')
  await input.fill('自动换行和手动换行都应让背景同步变化。'.repeat(12))
  await painted()
  for (const size of [{ width: 360, height: 450 }, { width: 620, height: 700 }, { width: 1000, height: 800 }, { width: 440, height: 540 }]) {
    await page.setViewportSize(size)
    await painted()
    await input.fill('第一行\n第二行\n第三行\n第四行')
    await painted()
    await expect.poll(() => page.evaluate(() => {
      const tools = document.querySelector('.drawing-dock')!.getBoundingClientRect()
      const composer = document.querySelector('.conversation-composer')!.getBoundingClientRect()
      return composer.top - tools.bottom
    })).toBeGreaterThanOrEqual(16)
  }
  await page.screenshot({ path: info.outputPath(`${entry}-multiline.png`) })
  await input.fill('')
  await painted()
  await expect(page.locator('.drawing-dock')).toHaveAttribute('data-overflow', 'false')
  const result = await page.evaluate(() => {
    const { samples, notifications } = (window as any).__dockResize
    const mismatches = samples.filter((sample: { width: number; height: number; depth: number; length: number }) => Math.abs(sample.depth - sample.height) > .05
      || Math.abs(sample.length - sample.width) > .05)
    return { samples, notifications, mismatches }
  })
  const report = info.outputPath(`${entry}-resize-notifications.json`)
  await writeFile(report, JSON.stringify(result, null, 2))
  await info.attach('resize-notifications', { path: report, contentType: 'application/json' })
  expect(result.samples.length).toBeGreaterThan(6)
  expect(result.mismatches).toEqual([])
  expect(await page.evaluate(() => (window as any).__layoutErrors)).toEqual([])
  expect(errors).toEqual([])
})
