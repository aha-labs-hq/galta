import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
test('the exact production bundle imports, draws, reloads and serves fonts locally', async ({ page }) => {
  const errors: string[] = [], external: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('request', r => { if (/^https?:/.test(r.url()) && !r.url().startsWith(`${acceptanceOrigin}/`)) external.push(r.url()) })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference.svg')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Text — T', exact: true }).click()
  await page.mouse.click(850, 320)
  await page.keyboard.type('Made with Galta'); await page.keyboard.press('Escape')
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  // A real export is also an explicit durability boundary before reloading.
  await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
  await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export canvas', exact: true }).click(); await (await downloaded).saveAs(test.info().outputPath('before-reopen.galta'))
  await page.reload()
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  const measured = await page.evaluate(() => { const c = document.createElement('canvas').getContext('2d')!; c.font = '20px "Liberation Sans"'; return c.measureText('Made with Galta').width })
  await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
  await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
  const reopenedDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export canvas', exact: true }).click()
  const exportPath = test.info().outputPath('reopened.galta')
  await (await reopenedDownload).saveAs(exportPath)
  const exported = JSON.parse(readFileSync(exportPath, 'utf8')).workspace
  const text = exported.snapshots[exported.project.headCommitId].document.elements.find((el: any) => el.type === 'text')
  expect(text.text).toBe('Made with Galta')
  expect(text.fontFamily).toBe(9)
  expect(text.width).toBeCloseTo(measured, 1)

  await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Draw — P', exact: true }).click()
  await page.mouse.move(400, 250); await page.mouse.down(); await page.mouse.move(500, 350, { steps: 12 }); await page.mouse.up()
  await expect(page.getByRole('region', { name: 'Galta canvas, 3 objects', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
  await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
  const picker = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import canvas', exact: true }).click()
  await (await picker).setFiles(exportPath)
  await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()

  expect(errors).toEqual([]); expect(external).toEqual([])
})
