import { test, expect, chromium } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { acceptanceBuild } from '../../scripts/lib/acceptance'
import { COLLECTION_STORAGE_KEY } from '../../apps/extension/src/shared/collection'

test('packaged collector stops when its extension context expires and recovers with a fresh source page', async () => {
  const executablePath = process.env.GALTA_EXTENSION_CHROME_PATH ?? chromium.executablePath()
  const profile = await mkdtemp(join(tmpdir(), 'galta-collector-context-'))
  const extension = acceptanceBuild
  const browser = await chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: { width: 1000, height: 800 }, args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  try {
    const root = await browser.browser()!.newBrowserCDPSession()
    const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker')
    // Chrome requires developer mode to keep unpacked extensions enabled after
    // a reload. Set it only in this disposable test profile.
    const manager = await browser.newPage()
    await manager.goto('chrome://extensions')
    const developerMode = manager.getByLabel('Developer mode', { exact: true })
    await developerMode.click()
    await expect(developerMode).toHaveJSProperty('checked', true)
    await manager.close()
    const source = await browser.newPage(), errors: string[] = [], logs: string[] = []
    source.on('console', message => {
      if (message.type() === 'error') errors.push(message.text())
      if (message.text().startsWith('[Galta]')) logs.push(message.text())
    })
    source.on('pageerror', error => errors.push(error.message))
    const pixels = await readFile(resolve('tests/fixtures/reference-glass.png'))
    await source.route('https://galta-collector.test/**', route => route.fulfill(route.request().resourceType() === 'image'
      ? { contentType: 'image/png', body: pixels }
      : { contentType: 'text/html', body: '<!doctype html><title>Collector lifecycle</title><style>body{margin:48px}img{display:block;width:240px;height:240px}</style><img alt="Reference" src="/reference.png"><button id="native">Native page action</button>' }))
    await source.goto('https://galta-collector.test/source')
    const image = source.getByRole('img', { name: 'Reference', exact: true })
    await image.hover()
    await expect(source.locator('[data-galta-collector]')).toHaveCount(1)
    const box = (await image.boundingBox())!
    // A plain image's 34px mark is inset 12px at its upper-right corner.
    await source.mouse.click(box.x + box.width - 29, box.y + 29)
    const read = (target: typeof worker) => target.evaluate(async key => (await chrome.storage.local.get(key))[key] ?? [], COLLECTION_STORAGE_KEY)
    await expect.poll(async () => (await read(worker)).length).toBe(1)
    const retained = await read(worker)
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).style.visibility)).toBe('')
    await source.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

    // Return from this evaluation before the worker reload tears it down.
    await worker.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 50) })
    await expect.poll(() => browser.serviceWorkers().includes(worker), { message: 'the original extension worker must be unloaded' }).toBe(false)
    await source.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2)
    await expect(source.locator('[data-galta-collector]')).toHaveCount(0)
    const drag = await image.evaluate(element => {
      const dataTransfer = new DataTransfer()
      element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
      return dataTransfer.getData('application/x-galta-reference')
    })
    expect(drag).toBe('')
    await source.locator('#native').evaluate(element => element.addEventListener('click', () => element.setAttribute('data-clicked', 'true')))
    await source.locator('#native').click()
    await expect(source.locator('#native')).toHaveAttribute('data-clicked', 'true')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('Refresh this page')
    expect(errors).toEqual([])

    const expired = await root.send('Extensions.getExtensions')
    const extensionId = new URL(worker.url()).host
    await expect.poll(async () => (await root.send('Extensions.getExtensions')).extensions.find(item => item.id === extensionId)?.enabled, { message: 'the reloaded extension must be enabled before refreshing the source' }).toBe(true)
    const active = await root.send('Extensions.getExtensions')
    // Wake and verify the reloaded extension through a script-free document,
    // before navigating a source page that needs its new content script.
    const ready = await browser.newPage()
    await ready.goto(`chrome-extension://${new URL(worker.url()).host}/manifest.json`)
    const response = await ready.evaluate(() => chrome.runtime.sendMessage({ type: 'collection-list' }))
    expect(response).toEqual({ ok: true, items: retained })
    const replacement = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker', { timeout: 10000 })
    await ready.close()
    await source.reload()
    await image.evaluate(element => { (element as HTMLImageElement).src = '/fresh-reference.png' })
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true)
    await image.hover()
    await expect(source.locator('[data-galta-collector]')).toHaveCount(1)
    await source.mouse.click(box.x + box.width - 29, box.y + 29)
    await expect.poll(async () => (await read(replacement)).length).toBe(2)
    expect(await read(replacement)).toContainEqual(retained[0])
    expect((await read(replacement)).map((item: any) => item.mediaUrl)).toContain('https://galta-collector.test/fresh-reference.png')
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).style.visibility)).toBe('')
    expect(errors).toEqual([])
    const receipt = test.info().outputPath('extension-context-lifecycle.json')
    await writeFile(receipt, JSON.stringify({ expired, active, retained, saved: await read(replacement), logs, errors }, null, 2))
    await test.info().attach('extension-context-lifecycle', { contentType: 'application/json', path: receipt })
  } finally {
    await browser.close()
    await rm(profile, { recursive: true, force: true })
  }
})
