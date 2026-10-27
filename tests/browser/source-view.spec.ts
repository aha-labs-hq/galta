import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { join } from 'node:path'
import { acceptanceBuild } from '../../scripts/lib/acceptance'

test('the installed page integration parses as a classic manifest script', () => {
  const manifest = JSON.parse(readFileSync(join(acceptanceBuild, 'manifest.json'), 'utf8'))
  for (const entry of manifest.content_scripts) for (const path of entry.js) {
    expect(() => new Script(readFileSync(join(acceptanceBuild, path), 'utf8'), { filename: path })).not.toThrow()
  }
})

test('receiver remount retains the source page view owned by its existing endpoint', async ({ page }) => {
  const saved = await page.evaluate(() => (window as any).__captureSourceView())
  await page.evaluate(async sourceView => {
    history.replaceState(null, '', '/canvas/index.html#view=existing-view&returnTab=42')
    const host = window as any
    host.__registeredAddress = { tabId: 43, viewId: 'existing-view', sourceView }
    host.__registrationRead = false
    host.chrome = { runtime: { id: 'host-fixture' }, tabs: { getCurrent: async () => ({ id: 43, windowId: 1 }) }, storage: { session: {
      get: async (key: string) => { host.__registrationRead = true; return { [key]: host.__registeredAddress } },
      set: async (values: any) => { host.__registeredAddress = Object.values(values)[0] },
    } } }
    const { receivePresentation } = await import('/canvas/canvasViewNavigation.ts')
    host.__closeReceiver = receivePresentation('default-project', async () => {}, () => {})
  }, saved)
  await expect.poll(() => page.evaluate(() => (window as any).__registrationRead)).toBe(true)
  expect(await page.evaluate(() => (window as any).__registeredAddress)).toEqual({ tabId: 43, viewId: 'existing-view', sourceView: saved })
  await page.evaluate(() => (window as any).__closeReceiver())
})

test.beforeEach(async ({ page }) => {
  await page.goto('/dev/collector.html')
  await page.setContent('<html><body style="margin:0;width:2000px;height:3000px">Source page reading position</body></html>')
  await page.evaluate(async () => {
    const { sourcePage } = await import('/content/page.ts')
    const source = sourcePage(), host = window as any
    host.__captureSourceView = () => { const { documentId, url, viewport } = source('browser_check', {}); return { documentId, url, viewport, windowWidth: outerWidth } }
    host.__restoreSourceView = (await import('/shared/sourceView.ts')).restoreSourceView
  })
  await page.evaluate(() => window.scrollTo(350, 800))
})

test('return restores both scroll axes after the wider focus viewport clamps the source', async ({ page }) => {
  const saved = await page.evaluate(() => (window as any).__captureSourceView())
  expect(saved.viewport.scrollX).toBe(350)
  expect(saved.viewport.scrollY).toBe(800)
  await page.setViewportSize({ width: 2300, height: 1000 })
  await expect.poll(() => page.evaluate(() => scrollX)).toBe(0)
  // Native open() resolves before the sidebar's animated width reaches its
  // endpoint. Start restoration while the source is still wider.
  await page.evaluate(view => { const host = window as any; host.__restoredSource = host.__restoreSourceView(view, host.__captureSourceView) }, saved)
  expect(await page.evaluate(() => scrollX)).toBe(0)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const receipt = await page.evaluate(() => (window as any).__restoredSource)
  expect(receipt.status).toBe('restored')
  expect(receipt.viewport.scrollX).toBe(350)
  expect(receipt.viewport.scrollY).toBe(800)
})

test('a changed page keeps its new reading position and invalid coordinates fail before scrolling', async ({ page }) => {
  const saved = await page.evaluate(() => (window as any).__captureSourceView())
  await page.evaluate(() => { history.replaceState(null, '', '#another-page'); window.scrollTo(100, 200) })
  const receipt = await page.evaluate(view => (window as any).__restoreSourceView(view, (window as any).__captureSourceView), saved)
  expect(receipt.status).toBe('changed')
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual({ x: 100, y: 200 })
  const invalid = await page.evaluate(async view => {
    try { await (window as any).__restoreSourceView({ ...view, viewport: { ...view.viewport, scrollX: Infinity } }, (window as any).__captureSourceView); return false }
    catch { return true }
  }, saved)
  expect(invalid).toBe(true)
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual({ x: 100, y: 200 })
})
