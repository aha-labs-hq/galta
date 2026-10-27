import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'
import { storedHeadMediaHashes, storedWorkspaces } from '../helpers/stored-workspace'

test.beforeEach(async ({ context }) => { await installReturningAccount(context) })
const url = `${acceptanceOrigin}/sidepanel/index.html`
async function ready(page: Page) { await expect(page.locator('.conversation-composer textarea')).toBeEnabled() }
async function actions(page: Page) {
  if (!await page.getByRole('dialog', { name: 'Canvases', exact: true }).isVisible()) await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
  await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
}
async function upload(page: Page, contents: unknown) {
  await page.getByLabel('Import canvas file', { exact: true }).setInputFiles({ name: 'canvas.galta', mimeType: 'application/json', buffer: Buffer.from(typeof contents === 'string' ? contents : JSON.stringify(contents)) })
}
async function rename(page: Page, title: string) {
  await actions(page); await page.getByRole('button', { name: 'Rename canvas', exact: true }).click()
  await page.getByRole('textbox', { name: 'Canvas name', exact: true }).fill(title)
  await page.getByRole('button', { name: 'Save canvas name', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toHaveCount(0)
  await ready(page)
}

for (const width of [1440, 360]) test(`export scope is visible and described at ${width}px without hovering`, async ({ page }) => {
  await page.setViewportSize({ width, height: 720 })
  await page.goto(url); await ready(page); await actions(page)
  const button = page.getByRole('button', { name: 'Export canvas', exact: true })
  await expect(button).toHaveAccessibleDescription('Artwork, history and conversations. Unsent drafts stay on this device.')
  await expect(button.getByText('Unsent drafts stay on this device.', { exact: false })).toBeVisible()
  const bounds = await button.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
  await page.screenshot({ path: test.info().outputPath(`scope-${width}.png`), animations: 'disabled' })
})

test('export owns navigation and keeps its status visible until the real worker finishes', async ({ page }) => {
  await page.goto(url); await ready(page)
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference.svg')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await page.locator('.conversation-composer textarea').fill('A draft that must stay on this device')
  const source = (await storedWorkspaces(page))[0]
  await page.evaluate(() => {
    const WorkerType = window.Worker
    window.Worker = class extends WorkerType {
      postMessage(value: any, ...args: any[]) {
        if (value.kind === 'workspace') (window as any).releaseExport = () => super.postMessage(value, ...args as [any])
        else super.postMessage(value, ...args as [any])
      }
    } as any
  })
  await actions(page)
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export canvas', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Canvas actions', exact: true })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Canvases', exact: true }).getByRole('status')).toHaveText('Exporting canvas…')
  await expect(page.getByRole('button', { name: 'New canvas', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Current canvas actions', exact: true })).toBeDisabled()
  await expect(page.getByLabel('Import canvas file', { exact: true })).toBeDisabled()
  expect(await storedWorkspaces(page)).toHaveLength(1)
  await page.screenshot({ path: test.info().outputPath('export-in-progress.png'), animations: 'disabled' })
  await page.evaluate(() => (window as any).releaseExport())
  const exported = await downloaded, path = test.info().outputPath('exported.galta')
  await exported.saveAs(path)
  const envelope = JSON.parse(await readFile(path, 'utf8'))
  expect(envelope.workspace.project.id).toBe(source.project.id)
  expect(JSON.stringify(envelope)).not.toContain('A draft that must stay on this device')
  await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toHaveCount(0)
  await ready(page)
  await expect(page.locator('.conversation-composer textarea')).toHaveValue('A draft that must stay on this device')
})

test('unreadable, unsupported and damaged files preserve the project and give a recovery path', async ({ page }) => {
  await page.goto(url); await ready(page)
  const source = (await storedWorkspaces(page))[0]
  const invalid = structuredClone(source); invalid.project.headCommitId = 'missing-head'
  for (const [input, text] of [
    ['{private canvas content', 'can’t be read as a Galta canvas'],
    [null, 'isn’t a Galta canvas export'],
    [{ format: 'galta-workspace', schemaVersion: 99 }, 'unsupported version'],
    [{ format: 'galta-workspace', schemaVersion: 1, workspace: invalid }, 'incomplete or damaged']
  ] as const) {
    await upload(page, input)
    await expect(page.getByRole('alert')).toContainText(text)
    await expect(page.getByRole('alert')).toContainText('Your current canvas is unchanged.')
    await expect(page.getByRole('alert')).not.toContainText('private canvas content')
    expect(await storedWorkspaces(page)).toHaveLength(1)
    await expect(page.locator('.galta-shell')).toHaveAttribute('data-project-id', source.project.id)
    await ready(page)
  }
  await page.screenshot({ path: test.info().outputPath('damaged-file.png'), animations: 'disabled' })
})

test('a failed worker is an operation failure, releases navigation and preserves the draft', async ({ page }) => {
  await page.goto(url); await ready(page)
  await page.locator('.conversation-composer textarea').fill('Keep the original draft')
  await page.evaluate(() => {
    const WorkerType = window.Worker
    ;(window as any).restoreWorker = () => { window.Worker = WorkerType }
    window.Worker = class { constructor() { throw new Error('Controlled worker startup failure') } } as any
  })
  await upload(page, '{}')
  await expect(page.getByRole('alert')).toContainText('Galta couldn’t open this canvas file. Try again.')
  await expect(page.getByRole('alert')).not.toContainText('damaged')
  await expect(page.getByRole('alert')).not.toContainText('Controlled')
  expect(await storedWorkspaces(page)).toHaveLength(1)
  await ready(page)
  await expect(page.locator('.conversation-composer textarea')).toHaveValue('Keep the original draft')
  await page.evaluate(() => (window as any).restoreWorker())
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toHaveCount(0)
  await actions(page)
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export canvas', exact: true }).click(); await downloaded
  await ready(page)
})

test('export failure leaves the same canvas usable and does not clear its draft', async ({ page }) => {
  await page.goto(url); await ready(page)
  await page.locator('.conversation-composer textarea').fill('Keep this while export fails')
  const source = (await storedWorkspaces(page))[0]
  await page.evaluate(() => { window.Worker = class { constructor() { throw new Error('Controlled export worker failure') } } as any })
  await actions(page); await page.getByRole('button', { name: 'Export canvas', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Your saved work is preserved.')
  await expect(page.getByRole('alert')).not.toContainText('Controlled')
  await ready(page)
  await expect(page.locator('.galta-shell')).toHaveAttribute('data-project-id', source.project.id)
  await expect(page.locator('.conversation-composer textarea')).toHaveValue('Keep this while export fails')
  expect(await storedWorkspaces(page)).toHaveLength(1)
})

test('large real media survives export, repeated import and independent duplication', { tag: '@serial' }, async ({ page }) => {
  const media = process.env.GALTA_LARGE_MEDIA
  test.skip(!media, 'Opt-in with a real large media file; the run records its byte hash and UI frame timings.')
  test.setTimeout(180_000)
  const bytes = await readFile(media!), expectedHash = createHash('sha256').update(bytes).digest('hex')
  expect(bytes.length).toBeGreaterThanOrEqual(32 * 1024 * 1024)
  await page.goto(url); await ready(page); await rename(page, 'Large media source')
  await page.locator('nav input[type=file]').setInputFiles(media!)
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect(page.locator('.pending-image')).toHaveCount(0)
  const sourceId = (await page.locator('.galta-shell').getAttribute('data-project-id'))!
  await page.evaluate(() => {
    const frames: number[] = [], longTasks: number[] = []
    let previous = performance.now(), active = true
    const sample = (now: number) => { frames.push(now - previous); previous = now; if (active) requestAnimationFrame(sample) }
    const observer = new PerformanceObserver(list => list.getEntries().forEach(entry => longTasks.push(entry.duration)))
    observer.observe({ type: 'longtask', buffered: false }); requestAnimationFrame(sample)
    ;(window as any).finishFileTiming = () => { active = false; observer.disconnect(); return { frames, longTasks } }
  })
  await actions(page); const downloaded = page.waitForEvent('download')
  const started = Date.now()
  await page.getByRole('button', { name: 'Export canvas', exact: true }).click()
  const exported = await downloaded, path = test.info().outputPath('large.galta'); await exported.saveAs(path)
  const exportMs = Date.now() - started
  const envelope = JSON.parse(await readFile(path, 'utf8'))
  const asset = (Object.values(envelope.assets) as Array<{ mimeType: string; dataURL: string }>).find(file => file.mimeType.startsWith('video/'))!
  expect(createHash('sha256').update(Buffer.from(asset.dataURL.split(',')[1]!, 'base64')).digest('hex')).toBe(expectedHash)
  const imported: string[] = []
  for (let index = 0; index < 2; index++) {
    await page.getByLabel('Import canvas file', { exact: true }).setInputFiles(path)
    await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toHaveCount(0)
    await ready(page)
    const id = await page.locator('.galta-shell').getAttribute('data-project-id')
    expect(id).not.toBe(sourceId); expect(imported).not.toContain(id)
    imported.push(id!)
    await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
    await rename(page, `Large media import ${index + 1}`)
  }
  await actions(page); await page.getByRole('button', { name: 'Duplicate canvas', exact: true }).click(); await ready(page)
  await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toHaveCount(0)
  const timing = await page.evaluate(() => (window as any).finishFileTiming())
  const persisted = await storedHeadMediaHashes(page)
  expect(Object.keys(persisted)).toHaveLength(4)
  for (const sources of Object.values(persisted)) expect(sources.find(file => file.mimeType.startsWith('video/'))).toMatchObject({ bytes: bytes.length, sha256: expectedHash })
  await page.locator('.excalidraw').focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace')
  await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
  await page.getByRole('button', { name: 'Open Large media source', exact: true }).click(); await ready(page)
  await expect(page.locator('.galta-shell')).toHaveAttribute('data-project-id', sourceId)
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  expect((await storedHeadMediaHashes(page))[sourceId]!.find(file => file.mimeType.startsWith('video/'))).toMatchObject({ sha256: expectedHash })
  await page.locator('.excalidraw').focus(); await page.keyboard.press('ControlOrMeta+a')
  await page.getByRole('button', { name: 'Play video', exact: true }).click()
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0)
  await page.keyboard.press('Escape'); await expect(page.locator('video')).toHaveCount(0)
  const sorted = timing.frames.sort((a: number, b: number) => a - b), p95 = sorted[Math.floor(sorted.length * .95)] ?? 0
  expect(sorted.length).toBeGreaterThan(15)
  expect(p95).toBeLessThan(50)
  const record = { bytes: bytes.length, sha256: expectedHash, exportMs, persisted, copyEditPreservesOriginal: true, videoPlaybackVerified: true, frameSamples: sorted.length, frameP95Ms: p95, longestTaskMs: Math.max(0, ...timing.longTasks), bound: '32 MiB or larger real media; no active video playback during file-operation timing' }
  await writeFile(test.info().outputPath('large-media-verification.json'), JSON.stringify(record, null, 2))
  await page.screenshot({ path: test.info().outputPath('large-media.png'), animations: 'disabled' })
  console.log('Large media canvas operations:', JSON.stringify(record))
})
