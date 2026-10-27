import { test, expect, chromium, type CDPSession, type Worker } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptanceBuild, devOrigin } from '../../scripts/lib/acceptance'

// Chrome exposes its real side panel as a CDP target outside Playwright's tabs.
async function sidePanel(root: CDPSession, origin: string, worker: Worker) {
  const path = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    return (await chrome.sidePanel.getOptions({ tabId: tab!.id! })).path!
  })
  expect(new URL(path, origin).pathname).toBe('/sidepanel/index.html')
  let panel: Awaited<ReturnType<typeof attachPanel>> | undefined
  await expect.poll(async () => {
    const targets = await root.send('Target.getTargets')
    for (const target of targets.targetInfos.filter(target => target.url.startsWith(`${origin}/sidepanel/`))) {
      const candidate = await attachPanel(root, target.targetId)
      if (await candidate.evaluate(() => document.visibilityState === 'visible')) { panel = candidate; return true }
      await candidate.close()
    }
    return false
  }).toBe(true)
  return panel!
}

async function attachPanel(root: CDPSession, targetId: string) {
  const { sessionId } = await root.send('Target.attachToTarget', { targetId, flatten: false })
  let sequence = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  const receive = (event: { sessionId: string; message: string }) => {
    if (event.sessionId !== sessionId) return
    const message = JSON.parse(event.message), request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  }
  root.on('Target.receivedMessageFromTarget', receive)
  const send = (method: string, params = {}): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    void root.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => { pending.delete(id); reject(error) })
  })
  const evaluate = async <T>(fn: () => T): Promise<T> => {
    const result = await send('Runtime.evaluate', { expression: `(${fn.toString()})()`, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  const click = async (label: string) => {
    // Read the referenced label independently of descriptive text, and wait
    // for React's render without repeating the native input action.
    const expression = `(() => { const name = el => el.getAttribute('aria-labelledby')?.split(/\\s+/).map(id => document.getElementById(id)?.textContent?.trim() ?? '').join(' ') || el.getAttribute('aria-label') || el.textContent.trim(); const button = [...document.querySelectorAll('button')].find(el => name(el) === ${JSON.stringify(label)}); if (!button || button.disabled) return null; button.scrollIntoView({block:'nearest'}); const r=button.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2; return r.width > 0 && r.height > 0 && button.contains(document.elementFromPoint(x,y)) ? {x,y} : null; })()`
    let point: { x: number; y: number } | undefined
    await expect.poll(async () => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
      point = result.result.value ?? undefined
      return Boolean(point)
    }, { message: `Waiting for native panel button: ${label}` }).toBe(true)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  return { evaluate, click, screenshot: async (path: string) => {
    await evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))) })
    const result = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(path, Buffer.from(result.data, 'base64'))
  }, close: async () => { root.off('Target.receivedMessageFromTarget', receive); await root.send('Target.detachFromTarget', { sessionId }).catch(error => { if (!String(error).includes('No session with given id')) throw error }) } }
}

async function savedViewport() {
  const id = document.querySelector('.galta-shell')!.getAttribute('data-project-id')!
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('galta-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  return new Promise<{ centerX: number; centerY: number; span: number }>((resolve, reject) => {
    const request = db.transaction('canvas-views').objectStore('canvas-views').get(id)
    request.onsuccess = () => {
      db.close()
      const view = request.result
      const root = document.querySelector<HTMLElement>('.galta-shell')!, bounds = root.querySelector('.galta-workspace')!.getBoundingClientRect()
      const inset = Number.parseFloat(getComputedStyle(root).getPropertyValue('--space-4'))
      const tools = root.querySelector('.drawing-dock')!.getBoundingClientRect()
      const left = tools.right - bounds.left + inset, right = inset
      const top = document.querySelector('.galta-topbar')!.getBoundingClientRect().height + inset
      const width = bounds.width - left - right
      const height = bounds.height - document.querySelector('.conversation-composer')!.getBoundingClientRect().height - inset * 3 - top
      resolve({ centerX: (left + width / 2) / view.zoom - view.scrollX, centerY: (top + height / 2) / view.zoom - view.scrollY, span: Math.min(width, height) / view.zoom })
    }
    request.onerror = () => { db.close(); reject(request.error) }
  })
}

test('real native sidebar preserves independent canvases across browsing and full-view handoff', { tag: '@serial' }, async () => {
  test.skip(!process.env.GALTA_EXTENSION_CHROME_PATH, 'Requires extension-capable Chrome')
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'galta-native-canvas-')), extension = acceptanceBuild
  const browser = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.GALTA_EXTENSION_CHROME_PATH!, headless: false,
    viewport: null, args: ['--window-size=1420,1000', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  })
  try {
    const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker')
    const origin = `chrome-extension://${new URL(worker.url()).host}`
    const fixture = `${devOrigin}/dev/verification.html`
    const source = await browser.newPage(); await source.goto(fixture)
    const sourceId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, fixture)
    const full = await browser.newPage()
    await (await browser.newCDPSession(full)).send('Emulation.setFocusEmulationEnabled', { enabled: false })
    await full.goto(`${origin}/canvas/index.html#returnTab=${sourceId}&view=native-test-view`)
    await full.evaluate(() => {
      const post = BroadcastChannel.prototype.postMessage
      BroadcastChannel.prototype.postMessage = function(value) {
        if (this.name !== 'galta-canvas-presentation') post.call(this, value)
      }
    })
    const fullTabId = await full.evaluate(async () => (await chrome.tabs.getCurrent())!.id!)
    await expect(full.getByRole('button', { name: 'Canvas menu', exact: true })).toBeEnabled()
    const fullWidth = await full.evaluate(() => innerWidth)
    const build = await full.locator('.galta-shell').getAttribute('data-build')
    await full.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference-glass.png')
    await expect(full.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
    await full.getByRole('button', { name: 'Canvas menu', exact: true }).click()
    await full.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
    const exported = full.waitForEvent('download')
    await full.getByRole('button', { name: 'Export canvas', exact: true }).click(); await exported
    await full.locator('.excalidraw').focus(); await full.keyboard.press('Meta+a')
    const camera = await full.evaluate(savedViewport)
    await full.getByRole('button', { name: 'Back to page', exact: true }).click()
    await expect.poll(() => full.isClosed()).toBe(true)
    const root = await browser.browser()!.newBrowserCDPSession()
    let panel = await sidePanel(root, origin, worker)
    await panel.evaluate(() => {
      const post = BroadcastChannel.prototype.postMessage
      BroadcastChannel.prototype.postMessage = function(value) {
        if (this.name !== 'galta-canvas-presentation') post.call(this, value)
      }
    })
    const documentIdentity = await panel.evaluate(() => performance.timeOrigin)
    const expectSamePanel = async () => {
      expect(await panel.evaluate(() => performance.timeOrigin)).toBe(documentIdentity)
      expect(await panel.evaluate(() => document.visibilityState)).toBe('visible')
      expect(await panel.evaluate(() => location.href)).toBe(`${origin}/sidepanel/index.html`)
      const contexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.SIDE_PANEL] }))
      expect(contexts).toHaveLength(1)
      expect(await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        return chrome.sidePanel.getOptions({ tabId: tab!.id! })
      })).toEqual({ enabled: true, path: 'sidepanel/index.html' })
    }
    const state = () => panel.evaluate(() => ({
      project: document.querySelector('.galta-shell')?.getAttribute('data-project-id'),
      build: document.querySelector('.galta-shell')?.getAttribute('data-build'),
      draft: document.querySelector<HTMLTextAreaElement>('.conversation-composer textarea')?.value,
      scene: document.querySelector('[aria-label^="Galta canvas,"]')?.getAttribute('aria-label'),
      selected: document.querySelector('[aria-label="Selection actions"]') !== null
    }))
    await panel.screenshot(test.info().outputPath('native-return-panel.png'))
    await writeFile(test.info().outputPath('native-return-state.json'), JSON.stringify(await panel.evaluate(() => ({url:location.href, text:document.body.innerText}))))
    await expect.poll(state).toMatchObject({ project: 'default-project', build, scene: 'Galta canvas, 1 objects', selected: true })
    await panel.click('Canvas menu'); await panel.click('New canvas')
    await expect.poll(state).toMatchObject({ scene: 'Galta canvas, 0 objects' })
    const second = (await state()).project!
    expect(second).not.toBe('default-project')
    await expectSamePanel()
    await source.goto(fixture)
    const anotherSource = await browser.newPage(); await anotherSource.goto(`${fixture}?source=second`)
    await expectSamePanel()
    await panel.close(); panel = await sidePanel(root, origin, worker)
    await expect.poll(state).toMatchObject({ project: second, scene: 'Galta canvas, 0 objects' })
    await source.bringToFront()
    await expectSamePanel()
    await anotherSource.bringToFront()
    await anotherSource.close()
    await expectSamePanel()
    const backgroundTab = await browser.newPage(); await backgroundTab.goto(`${fixture}?source=background`)
    await source.bringToFront(); await backgroundTab.close()
    await expectSamePanel()
    await panel.close(); panel = await sidePanel(root, origin, worker)
    await expect.poll(state).toMatchObject({ project: second, scene: 'Galta canvas, 0 objects' })
    await panel.click('Canvas menu')
    // Same display names are allowed; identify the original by its first row's
    // current-state marker instead of assuming a generated title is unique.
    await panel.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Recent canvases"] button')]
      rows.find(button => !button.hasAttribute('aria-current'))?.click()
    })
    await expect.poll(state).toMatchObject({ project: 'default-project', scene: 'Galta canvas, 1 objects' })
    await panel.screenshot(test.info().outputPath('native-sidebar.png'))
    await panel.click('Canvas menu')
    await panel.screenshot(test.info().outputPath('native-picker.png'))
    await panel.click('Canvas menu')
    const focusedPage = browser.waitForEvent('page')
    await panel.click('Expand canvas')
    const focused = await focusedPage
    await (await browser.newCDPSession(focused)).send('Emulation.setFocusEmulationEnabled', { enabled: false })
    await expect.poll(() => worker.evaluate(async () => (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id)).toBe(await focused.evaluate(async () => (await chrome.tabs.getCurrent())!.id))
    expect(browser.pages().filter(page => page.url().startsWith(`${origin}/canvas/`))).toHaveLength(1)
    expect(full.isClosed()).toBe(true)
    expect(await focused.evaluate(async () => (await chrome.tabs.getCurrent())!.id!)).not.toBe(fullTabId)
    await expect(focused.locator('.galta-shell')).toHaveAttribute('data-project-id', 'default-project')
    // Selection is view-local, so the composer may have a different height
    // after switching projects. Compare the visible artwork frame, not scrollY.
    await expect.poll(async () => (await focused.evaluate(savedViewport)).span).toBeCloseTo(camera.span, 3)
    await expect.poll(async () => (await focused.evaluate(savedViewport)).centerX).toBeCloseTo(camera.centerX, 3)
    await expect.poll(async () => (await focused.evaluate(savedViewport)).centerY).toBeCloseTo(camera.centerY, 3)
    const restoredViewport = await focused.evaluate(savedViewport)
    await expect(focused.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
    await expect.poll(() => focused.evaluate(() => innerWidth)).toBe(fullWidth)
    await focused.screenshot({ path: test.info().outputPath('native-full-view.png') })
    const independent = await browser.newPage(); await independent.goto(`${origin}/canvas/index.html?project=${second}`)
    await expect(independent.locator('.galta-shell')).toHaveAttribute('data-project-id', second)
    await expect(focused.locator('.galta-shell')).toHaveAttribute('data-project-id', 'default-project')
    await independent.close(); await focused.bringToFront()
    await focused.getByRole('button', { name: 'Back to page', exact: true }).click()
    await expect.poll(() => focused.isClosed()).toBe(true)
    await panel.close(); panel = await sidePanel(root, origin, worker)
    await expect.poll(state).toMatchObject({ project: 'default-project', scene: 'Galta canvas, 1 objects' })
    // The previous Return closed its workbench. The next expansion creates and
    // hydrates one replacement before hiding the panel.
    await panel.evaluate(() => {
      const canvas = document.querySelector<HTMLElement>('.excalidraw')!
      canvas.focus()
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', metaKey: true, bubbles: true }))
    })
    await expect.poll(state).toMatchObject({ selected: true })
    const replacementPage = browser.waitForEvent('page')
    await panel.click('Expand canvas')
    const replacement = await replacementPage
    await (await browser.newCDPSession(replacement)).send('Emulation.setFocusEmulationEnabled', { enabled: false })
    await expect(replacement.getByRole('button', { name: 'Back to page', exact: true })).toBeEnabled()
    await expect(replacement.getByRole('group', { name: 'Selection actions', exact: true })).toBeVisible()
    await expect.poll(() => replacement.evaluate(() => innerWidth)).toBe(fullWidth)
    await replacement.getByRole('button', { name: 'Back to page', exact: true }).click()
    await expect.poll(() => replacement.isClosed()).toBe(true)
    await panel.close(); panel = await sidePanel(root, origin, worker)
    await expect.poll(state).toMatchObject({ project: 'default-project', scene: 'Galta canvas, 1 objects' })
    await writeFile(test.info().outputPath('native-handoff.json'), JSON.stringify({ build, panelDocumentIdentity: documentIdentity, originalViewport: camera, restoredViewport, initialProject: 'default-project', secondProject: second, returned: await state(), nativeContexts: await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.SIDE_PANEL] })) }, null, 2))
    await panel.close()
    await root.detach()
  } finally { await browser.close(); await rm(profile, { recursive: true, force: true }) }
})
