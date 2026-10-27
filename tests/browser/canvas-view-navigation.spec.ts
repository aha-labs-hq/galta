import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { storedWorkspace } from '../helpers/stored-workspace'
import { installReturningAccount, installCanvasPort } from '../helpers/canvas-port'

// Chrome owns window/tab delivery. These fixtures exercise the real save and
// receipt boundaries; native-multi-canvas verifies delivery in installed Chrome.
async function native(page: Page, source: 'present' | 'closed' | 'unavailable' = 'present') {
  await page.evaluate(source => {
    const host = window as any, storage: Record<string, unknown> = {}
    host.__viewCalls = []; host.__viewError = ''; host.__holdReady = false; host.__session = storage
    const record = (method: string, value: any) => host.__viewCalls.push({ method, value })
    const channel = new BroadcastChannel('galta-canvas-presentation')
    channel.onmessage = ({data}) => {
      if (data.type === 'present') {
        host.__readyView = () => channel.postMessage({ token: data.token })
        if (!host.__holdReady) host.__readyView()
      }
    }
    const receipt = (url: string) => {
      const token = new URLSearchParams(new URL(url, location.origin).hash.slice(1)).get('handoff')
      host.__readyView = () => channel.postMessage({ token })
      if (!host.__holdReady) host.__readyView()
    }
    Object.assign(host.chrome, {
      runtime: { ...host.chrome.runtime, id: 'host-fixture', ContextType: { TAB: 'TAB', SIDE_PANEL: 'SIDE_PANEL' }, getContexts: async () => [], getURL: (path: string) => `chrome-extension://host-fixture/${path}` },
      storage: { ...host.chrome.storage, session: { get: async (key: string) => ({ [key]: storage[key] }), set: async (values: any) => Object.assign(storage, values), remove: async (key: string) => { delete storage[key] } } },
      tabs: {
        getCurrent: async () => ({ id: 43, windowId: 1 }),
        query: async () => [{ id: 42, windowId: 1 }],
        get: async (id: number) => {
          if (source === 'unavailable') throw new Error('Chrome tab service unavailable')
          if (source === 'closed') throw new Error(`No tab with id: ${id}`)
          return { id, windowId: 1 }
        },
        onRemoved: { addListener() {}, removeListener() {} },
        create: async (value: any) => { record('create', value); if (host.__viewError) throw new Error(host.__viewError); receipt(value.url); return { id: 43, windowId: 1 } },
        update: async (id: number, value: any) => { record('activate', { id, ...value }) },
        remove: async (id: number) => { record('remove', { id }) },
      },
      sidePanel: {
        setOptions: async (value: any) => { record('configure', value); if (value.path) host.__panelPath = value.path },
        getOptions: async () => ({}),
        close: async (value: any) => record('close', value),
        open: async (value: any) => { record('open', value); if (host.__viewError) throw new Error(host.__viewError) },
      },
      windows: { update: async (id: number, value: any) => record('window', { id, ...value }) },
    })
  }, source)
}

async function prepare(page: Page, mode: 'panel' | 'return' | 'standalone' = 'panel') {
  await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/${mode === 'panel' ? 'sidepanel' : 'canvas'}/index.html${mode === 'return' ? '#returnTab=42' : ''}`)
  await expect(page.locator('.conversation-composer textarea')).toBeEnabled()
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference.svg')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+a')
  await native(page)
  await page.locator('.conversation-composer textarea').fill('Keep this composition and its draft.')
}

const calls = (page: Page) => page.evaluate(() => (window as any).__viewCalls)

test('a pending account reconnect preserves the submitted camera when the composer appears', async ({ page }) => {
  await installReturningAccount(page)
  await page.addInitScript(() => {
    const host = window as any, send = host.chrome.runtime.sendMessage
    host.chrome.runtime.sendMessage = (message: any) => message.type === 'codex-connect' ? new Promise(resolve => {
      host.__finishAccountConnect = async () => resolve(await send(message))
    }) : send(message)
  })
  const intended = { center: { x: 240, y: 360 }, span: 600 }
  await page.goto(`/canvas/index.html#viewport=${encodeURIComponent(JSON.stringify(intended))}`)
  await expect(page.getByRole('button', { name: 'Connecting…', exact: true })).toBeVisible()
  const measured = async () => {
    const saved: any = await storedWorkspace(page)
    return page.evaluate(view => {
      if (!view) return null
      const root = document.querySelector('.galta-workspace')!.getBoundingClientRect(), tools = document.querySelector('.drawing-dock')!.getBoundingClientRect(), header = document.querySelector('.galta-topbar')!.getBoundingClientRect(), composer = document.querySelector('.conversation-composer')!.getBoundingClientRect()
      const inset = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-4')), left = tools.right - root.left + inset, top = header.height + inset
      const width = root.width - left - inset, height = root.height - composer.height - inset * 3 - top
      return { x: (left + width / 2) / view.zoom - view.scrollX, y: (top + height / 2) / view.zoom - view.scrollY, span: Math.min(width, height) / view.zoom }
    }, saved.canvasView)
  }
  const preserved = async () => {
    const actual = await measured()
    expect(actual).not.toBeNull()
    expect(actual!.x).toBeCloseTo(intended.center.x, 2)
    expect(actual!.y).toBeCloseTo(intended.center.y, 2)
    expect(actual!.span).toBeCloseTo(intended.span, 2)
  }
  await expect(preserved).toPass({ timeout: 5000 })
  await page.evaluate(() => (window as any).__finishAccountConnect())
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeVisible()
  await expect(preserved).toPass({ timeout: 5000 })
})

test('a saved camera survives reload while its account connection is pending', async ({ page }) => {
  await installReturningAccount(page)
  await page.goto('/canvas/index.html')
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeEnabled()
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference.svg')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await page.locator('.pending-image').waitFor({ state: 'hidden' })
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Keep this saved view.\nContinue after reconnecting.')
  const before = (await storedWorkspace(page) as any).canvasView
  const beforeZoom = await page.getByRole('button', { name: 'Canvas zoom', exact: true }).innerText()
  expect(before).toBeTruthy()
  await page.addInitScript(() => {
    const host = window as any, send = host.chrome.runtime.sendMessage
    host.chrome.runtime.sendMessage = (message: any) => message.type === 'codex-connect' ? new Promise(resolve => {
      host.__finishAccountConnect = async () => resolve(await send(message))
    }) : send(message)
  })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Connecting…', exact: true })).toBeVisible()
  await page.evaluate(() => (window as any).__finishAccountConnect())
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('Keep this saved view.\nContinue after reconnecting.')
  await page.screenshot() // Flush reconnect's layout and paint before observing its live zoom.
  await expect(page.getByRole('button', { name: 'Canvas zoom', exact: true })).toHaveText(beforeZoom)
  await expect.poll(async () => (await storedWorkspace(page) as any).canvasView).toEqual(before)
})

// Share a session mailbox across real documents. Native storage change events
// are modeled with the browser's cross-document storage event, independently of
// the presentation channel so dropping that channel tests both request/receipt.
async function sharedPresentationSession(context: BrowserContext) {
  await context.addInitScript(() => {
    const host = window as any, prefix = 'presentation-session:', listeners = new Set<(changes: any, area: string) => void>()
    const notify = (key: string, oldValue: unknown, newValue: unknown) => {
      const repeats = key.startsWith('galta-canvas-presentation:') ? host.__duplicatePresentationChanges ?? 1 : 1
      for (let i = 0; i < repeats; i++) listeners.forEach(listener => listener({ [key]: { oldValue, newValue } }, 'session'))
    }
    window.addEventListener('storage', event => {
      if (event.key?.startsWith(prefix)) notify(event.key.slice(prefix.length), event.oldValue ? JSON.parse(event.oldValue) : undefined, event.newValue ? JSON.parse(event.newValue) : undefined)
    })
    host.__installPresentationSession = () => {
      host.chrome.storage.onChanged = { addListener: (listener: any) => listeners.add(listener), removeListener: (listener: any) => listeners.delete(listener) }
      host.chrome.storage.session = {
        get: async (key: string) => ({ [key]: JSON.parse(localStorage.getItem(prefix + key) ?? 'null') ?? undefined }),
        set: async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) {
            const old = localStorage.getItem(prefix + key)
            localStorage.setItem(prefix + key, JSON.stringify(value)); notify(key, old ? JSON.parse(old) : undefined, value)
          }
        },
        remove: async (key: string) => { const old = localStorage.getItem(prefix + key); localStorage.removeItem(prefix + key); notify(key, old ? JSON.parse(old) : undefined, undefined) },
      }
    }
    // Install after the account fixture has created chrome.storage.
    window.addEventListener('DOMContentLoaded', () => host.__installPresentationSession(), { once: true })
    const NativeChannel = BroadcastChannel
    host.__presentationMessages = []
    window.BroadcastChannel = class extends NativeChannel {
      postMessage(value: any) {
        if (this.name === 'galta-canvas-presentation') { host.__presentationMessages.push(value); return }
        super.postMessage(value)
      }
    }
  })
}

for (const reused of [false, true]) test(`a ${reused ? 'reused' : 'new'} canvas recovers its pending view before mounting, with every channel message dropped`, async ({ page, context }) => {
  await installReturningAccount(context)
  await sharedPresentationSession(context)
  await prepare(page)
  await page.evaluate(reused => {
    const host = window as any
    host.__installPresentationSession()
    host.__holdReady = true
    if (reused) {
      void host.chrome.storage.session.set({ 'galta-canvas-view:1:default-project': { tabId: 43, viewId: 'late-view' } })
      host.chrome.runtime.getContexts = async () => [{ documentUrl: 'chrome-extension://host-fixture/canvas/index.html?project=default-project#view=late-view' }]
    }
  }, reused)
  const before = await storedWorkspace(page)
  await page.getByRole('button', { name: 'Expand canvas', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__presentationMessages.some((value: any) => value.type === 'present'))).toBe(true)
  await expect(page.locator('.conversation-composer textarea')).toBeDisabled()
  expect((await calls(page)).some((call: any) => call.method === 'activate')).toBe(false)
  const url = reused ? `${acceptanceOrigin}/canvas/index.html?project=default-project#view=late-view` : (await calls(page)).find((call: any) => call.method === 'create').value.url.replace('chrome-extension://host-fixture', acceptanceOrigin)
  const receiver = await context.newPage()
  await receiver.addInitScript(() => {
    const host = window as any
    host.chrome.runtime.id = 'host-fixture'
    host.chrome.tabs = { getCurrent: async () => ({ id: 43, windowId: 1 }), get: async (id: number) => ({ id, windowId: 1 }), onRemoved: { addListener() {}, removeListener() {} } }
    host.__presented = 0
    host.__duplicatePresentationChanges = 5
    window.addEventListener('galta-presentation-change', () => host.__presented++)
  })
  await receiver.goto(url)
  await expect.poll(async () => (await calls(page)).at(-1)?.method).toBe('close')
  await expect(receiver.locator('.conversation-composer textarea')).toHaveValue('Keep this composition and its draft.')
  await expect(receiver.getByLabel('1 selected object', { exact: true })).toBeVisible()
  expect(await receiver.evaluate(() => (window as any).__presented)).toBe(1)
  expect((await storedWorkspace(receiver)).snapshots).toEqual(before.snapshots)
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('presentation-session:galta-canvas-presentation:') || key.startsWith('presentation-session:galta-presentation-receipt:')))).toEqual([])
})

test('a mounted canvas consumes a storage change once despite repeated wakeups for the same token', async ({ page, context }) => {
  await installReturningAccount(context)
  await sharedPresentationSession(context)
  await prepare(page)
  await page.evaluate(() => (window as any).__installPresentationSession())
  const receiver = await context.newPage()
  await receiver.addInitScript(() => {
    const host = window as any
    host.chrome.runtime.id = 'host-fixture'
    host.chrome.tabs = { getCurrent: async () => ({ id: 43, windowId: 1 }), get: async (id: number) => ({ id, windowId: 1 }), onRemoved: { addListener() {}, removeListener() {} } }
    host.__presented = 0
    window.addEventListener('galta-presentation-change', () => host.__presented++)
  })
  await receiver.goto(`${acceptanceOrigin}/canvas/index.html?project=default-project#view=mounted-view`)
  await expect(receiver.locator('.conversation-composer textarea')).toBeEnabled()
  await expect.poll(() => page.evaluate(async () => (await (window as any).chrome.storage.session.get('galta-canvas-view:1:default-project'))['galta-canvas-view:1:default-project']?.viewId)).toBe('mounted-view')
  await page.evaluate(() => {
    const host = window as any
    host.__holdReady = true
    host.chrome.runtime.getContexts = async () => [{ documentUrl: 'chrome-extension://host-fixture/canvas/index.html?project=default-project#view=mounted-view' }]
  })
  await page.locator('.conversation-composer textarea').fill('Latest draft after receiver has mounted')
  await page.getByRole('button', { name: 'Expand canvas', exact: true }).click()
  await expect.poll(async () => (await calls(page)).at(-1)?.method).toBe('close')
  const envelope = await page.evaluate(() => (window as any).__presentationMessages.find((value: any) => value.type === 'present'))
  await receiver.evaluate(envelope => {
    // Repeat the storage notification itself, including after completion. The
    // channel is still dropped, so this also validates durable receipt delivery.
    const event = new StorageEvent('storage', { key: 'presentation-session:galta-canvas-presentation:default-project:mounted-view', newValue: JSON.stringify(envelope) })
    for (let i = 0; i < 5; i++) window.dispatchEvent(event)
  }, envelope)
  await expect(receiver.locator('.conversation-composer textarea')).toHaveValue('Latest draft after receiver has mounted')
  expect(await receiver.evaluate(() => (window as any).__presented)).toBe(1)
  await expect(receiver.getByRole('alert')).toHaveCount(0)
})

test('a late canvas ignores an expired handoff instead of changing its current view', async ({ page, context }) => {
  await installReturningAccount(context)
  await sharedPresentationSession(context)
  await page.addInitScript(() => {
    const host = window as any
    host.chrome.runtime.id = 'host-fixture'
    host.chrome.tabs = { getCurrent: async () => ({ id: 43, windowId: 1 }), get: async (id: number) => ({ id, windowId: 1 }), onRemoved: { addListener() {}, removeListener() {} } }
    host.__presented = 0
    window.addEventListener('galta-presentation-change', () => host.__presented++)
    localStorage.setItem('presentation-session:galta-canvas-presentation:default-project:late-view', JSON.stringify({
      type: 'present', projectId: 'default-project', target: 'late-view', token: 'expired-token', sourceTab: 42,
      expiresAt: Date.now() - 1, view: { selection: [], viewport: { center: { x: 1000, y: 1000 }, span: 600 } },
    }))
  })
  await page.goto(`${acceptanceOrigin}/canvas/index.html?project=default-project#view=late-view`)
  await expect(page.locator('.conversation-composer textarea')).toBeEnabled()
  await expect.poll(() => page.evaluate(async () => (await (window as any).chrome.storage.session.get('galta-canvas-view:1:default-project'))['galta-canvas-view:1:default-project']?.viewId)).toBe('late-view')
  expect(await page.evaluate(() => (window as any).__presented)).toBe(0)
  expect(await page.evaluate(() => (window as any).__presentationMessages.filter((value: any) => value.token === 'expired-token'))).toEqual([])
  await expect(page.getByRole('button', { name: 'Back to page', exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a runtime-only host keeps the panel usable without optional handoff APIs', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await installReturningAccount(page)
  await page.addInitScript(() => {
    const browser = (window as any).chrome
    browser.runtime.id = 'runtime-only'
    delete browser.windows
    delete browser.tabs
    delete browser.storage.session
  })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('expand waits for a hydrated receiver and holds edits without opening the project-switch dialog', async ({ page }) => {
  await prepare(page)
  await page.evaluate(() => { (window as any).__holdReady = true })
  const before = await storedWorkspace(page)
  await page.getByRole('button', { name: 'Expand canvas', exact: true }).click()
  await expect.poll(async () => (await calls(page)).length).toBe(1)
  expect((await calls(page))[0].value.active).toBe(false)
  await expect(page.locator('.galta-canvas')).toHaveAttribute('inert', '')
  await expect(page.locator('.conversation-composer textarea')).toBeDisabled()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await page.evaluate(() => (window as any).__readyView())
  await expect.poll(async () => (await calls(page)).at(-1).method).toBe('close')
  expect((await calls(page)).map((c: any) => c.method)).toEqual(['create', 'configure', 'activate', 'window', 'close'])
  const state = new URLSearchParams(new URL((await calls(page))[0].value.url).hash.slice(1))
  expect(state.get('returnTab')).toBe('42')
  expect(JSON.parse(state.get('selection')!)).toHaveLength(1)
  expect(JSON.parse(state.get('viewport')!).span).toBeGreaterThan(0)
  expect((await storedWorkspace(page)).snapshots).toEqual(before.snapshots)
  await expect(page.locator('.conversation-composer textarea')).toHaveValue('Keep this composition and its draft.')
})

test('reuse verifies the extension context without needing access to browser tab URLs', async ({ page }) => {
  await prepare(page)
  await page.evaluate(async () => {
    const chrome = (window as any).chrome
    await chrome.storage.session.set({ 'galta-canvas-view:1:default-project': { tabId:43,viewId:'existing-view' } })
    chrome.runtime.ContextType = { TAB: 'TAB', SIDE_PANEL: 'SIDE_PANEL' }
    chrome.runtime.getContexts = async () => [{ documentUrl: 'chrome-extension://host-fixture/canvas/index.html?project=default-project#view=existing-view' }]
  })
  await page.getByRole('button', { name: 'Expand canvas', exact: true }).click()
  await expect.poll(async () => (await calls(page)).at(-1)?.method).toBe('close')
  expect((await calls(page)).map((c: any) => c.method)).toEqual(['configure', 'activate', 'window', 'close'])
  expect((await calls(page)).find((c: any) => c.method === 'activate').value.id).toBe(43)
})

test('failed expansion restores editing and keeps the source open', async ({ page }) => {
  await prepare(page)
  await page.evaluate(() => { (window as any).__viewError = 'Controlled tab creation failure' })
  await page.getByRole('button', { name: 'Expand canvas', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Controlled tab creation failure')
  expect((await calls(page)).map((c: any) => c.method)).toEqual(['create'])
  await expect(page.locator('.galta-canvas')).not.toHaveAttribute('inert', '')
  await expect(page.locator('.conversation-composer textarea')).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Expand canvas', exact: true })).toBeEnabled()
})

test('return closes the full canvas after the original page receives its state', async ({ page }) => {
  await prepare(page, 'return')
  const before = await storedWorkspace(page)
  await page.getByRole('button', { name: 'Back to page', exact: true }).click()
  await expect.poll(async () => (await calls(page)).some((call: any) => call.method === 'remove')).toBe(true)
  await expect(page.getByRole('button', { name: 'Back to page', exact: true })).toBeEnabled()
  expect((await calls(page)).map((c: any) => c.method)).toEqual(['open', 'activate', 'window', 'remove'])
  expect((await calls(page)).at(-1).value.id).toBe(43)
  const options = (await calls(page))[0].value
  expect(options.windowId).toBe(1)
  expect((await storedWorkspace(page)).snapshots).toEqual(before.snapshots)
})

test('return keeps the full canvas open until the receiving panel acknowledges hydration', async ({ page }) => {
  await prepare(page, 'return')
  await page.evaluate(() => { (window as any).__holdReady = true })
  await page.getByRole('button', { name: 'Back to page', exact: true }).click()
  await expect.poll(() => page.evaluate(() => typeof (window as any).__readyView)).toBe('function')
  await expect.poll(async () => (await calls(page)).some((call: any) => call.method === 'activate' && call.value.id === 42)).toBe(true)
  expect((await calls(page)).some((call: any) => call.method === 'remove')).toBe(false)
  await page.evaluate(() => (window as any).__readyView())
  await expect.poll(async () => (await calls(page)).filter((call: any) => call.method === 'remove').map((call: any) => call.value.id)).toEqual([43])
})

test('failed return preserves the workbench and retries the same source without creating tabs', async ({ page }) => {
  await prepare(page, 'return')
  await page.evaluate(() => { (window as any).__viewError = 'Chrome could not open the side panel' })
  await page.getByRole('button', { name: 'Back to page', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Chrome could not open the side panel')
  expect((await calls(page)).map((c: any) => c.method)).toEqual(['open'])
  await page.evaluate(() => { (window as any).__viewError = '' })
  await page.getByRole('button', { name: 'Back to page', exact: true }).click()
  await expect.poll(async () => (await calls(page)).some((call: any) => call.method === 'remove')).toBe(true)
  expect((await calls(page)).filter((c: any) => c.method === 'open').map((c: any) => c.value.windowId)).toEqual([1, 1])
})

test('an unresponsive panel returns focus to the usable workbench without turning navigation into a canvas error', async ({ page }) => {
  await prepare(page, 'return')
  await page.evaluate(() => { (window as any).__holdReady = true })
  await page.getByRole('button', { name: 'Back to page', exact: true }).click()
  await expect.poll(async () => (await calls(page)).at(-1)?.method, { timeout: 15_000 }).toBe('window')
  await expect(page.getByRole('status')).toContainText('Your canvas is still here', { timeout: 15_000 })
  expect((await calls(page)).filter((c: any) => c.method === 'activate').map((c: any) => c.value.id)).toEqual([42, 43])
  expect((await calls(page)).some((c: any) => c.method === 'remove')).toBe(false)
  await expect(page.locator('.conversation-composer textarea')).toBeEnabled()
  await expect(page.getByRole('status')).toHaveCount(0, { timeout: 6_000 })
  expect(await page.evaluate(() => Object.keys((window as any).__session).filter(key => key.startsWith('galta-panel-presentation:') || key.startsWith('galta-presentation-receipt:')))).toEqual([])
})

test('an external agent keeps working and view switching never offers to terminate it', async ({ page }) => {
  await installReturningAccount(page)
  await installCanvasPort(page)
  await page.addInitScript(() => {
    const host = window as any
    host.chrome.windows = { getCurrent: async () => ({ id: 1 }) }
    host.chrome.storage.session = { get: async () => ({}) }
  })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect(page.getByRole('button', { name: 'Expand canvas', exact: true })).toBeEnabled()
  await expect.poll(() => page.evaluate(() => typeof (window as any).__beginExternalAgent)).toBe('function')
  await page.evaluate(() => (window as any).__beginExternalAgent('Claude Code'))
  await expect(page.getByRole('button', { name: 'Expand canvas', exact: true })).toBeDisabled()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  const refusal = await page.evaluate(() => new Promise<string>((resolve, reject) => {
    const channel = new BroadcastChannel('galta-canvas-presentation'), token = crypto.randomUUID()
    const timer = setTimeout(()=>{channel.close();reject(new Error('No presentation receipt'))},5000)
    channel.onmessage = ({data}) => {
      if (data.token !== token) return
      clearTimeout(timer); channel.close(); resolve(data.error ?? '')
    }
    channel.postMessage({type:'present',token,projectId:'default-project',windowId:1,sourceTab:42,view:{selection:[],viewport:{center:{x:0,y:0},span:600}}})
  }))
  expect(refusal).toContain('Finish the current canvas change')
  const result = await page.evaluate(() => (window as any).__canvasToolCall('canvas_inspect', {}))
  expect(result.isError).not.toBe(true)
})

test('a standalone canvas with no other page in its window has no return or fullscreen action', async ({ page }) => {
  await prepare(page, 'standalone')
  await page.evaluate(() => {
    (window as any).chrome.tabs.query = async () => [{ id: 43, windowId: 1, url: 'chrome-extension://host-fixture/canvas/index.html' }]
    window.dispatchEvent(new Event('focus'))
  })
  await expect(page.locator('.canvas-presentation-control')).toHaveCount(0)
  expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false)
})

for (const missing of ['sidePanel.open', 'runtime.ContextType']) test(`a browser without extension side panels (no ${missing}) offers no return for a canvas opened on its own`, async ({ page }) => {
  await prepare(page, 'standalone')
  await page.evaluate(missing => {
    const host = window as any
    host.chrome.tabs.query = async () => [{ id: 42, windowId: 1, url: 'https://example.com/', title: 'Reading', lastAccessed: 2000 }, { id: 43, windowId: 1, url: 'chrome-extension://host-fixture/canvas/index.html', lastAccessed: 4000 }]
    // A Chromium host can expose part of the side panel API without showing extension side panels.
    if (missing === 'sidePanel.open') delete host.chrome.sidePanel.open
    else delete host.chrome.runtime.ContextType
    window.dispatchEvent(new Event('focus'))
  }, missing)
  await expect(page.locator('.canvas-presentation-control')).toHaveCount(0)
})

test('a canvas opened on its own returns beside the page last used in its window', async ({ page }) => {
  await prepare(page, 'standalone')
  await page.evaluate(() => {
    (window as any).chrome.tabs.query = async () => [
      { id: 41, windowId: 1, url: 'https://example.com/', title: 'Earlier page', lastAccessed: 1000 },
      { id: 42, windowId: 1, url: 'https://diabrowser.com/changelog', title: 'Dia Browser | Update 1.53.0', lastAccessed: 2000 },
      { id: 43, windowId: 1, url: 'chrome-extension://host-fixture/canvas/index.html', lastAccessed: 4000 },
      { id: 44, windowId: 1, url: 'chrome-extension://host-fixture/canvas/index.html?project=other', lastAccessed: 3000 },
    ]
    window.dispatchEvent(new Event('focus'))
  })
  const action = page.getByRole('button', { name: 'Back to page', exact: true })
  await expect(action).toHaveAttribute('aria-description', 'Back to Dia Browser | Update 1.53.0')
  const before = await storedWorkspace(page)
  await action.click()
  await expect.poll(async () => (await calls(page)).some((call: any) => call.method === 'remove')).toBe(true)
  expect((await calls(page)).map((c: any) => c.method)).toEqual(['open', 'activate', 'window', 'remove'])
  expect((await calls(page))[1].value.id).toBe(42)
  expect((await calls(page)).at(-1).value.id).toBe(43)
  expect((await storedWorkspace(page)).snapshots).toEqual(before.snapshots)
})

test('a closed source is explained without inventing a new browsing tab', async ({ page }) => {
  await prepare(page, 'return')
  await native(page, 'closed')
  const action = page.getByRole('button', { name: 'Back to page', exact: true })
  await expect(action).toBeDisabled()
  await expect(action).toHaveAttribute('aria-description', 'The original page was closed')
  expect(await calls(page)).toEqual([])
})

test('unexpected Chrome errors leave both views alone', async ({ page }) => {
  await prepare(page, 'return')
  await native(page, 'unavailable')
  await page.getByRole('button', { name: 'Back to page', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Chrome tab service unavailable')
  expect(await calls(page)).toEqual([])
})

for (const width of [360, 480, 1440]) {
  test(`the action stays at the right edge and the title truncates at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
    const action = page.getByRole('button', { name: 'Expand canvas', exact: true })
    await expect(action).toBeEnabled()
    await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
    await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
    await page.getByRole('button', { name: 'Rename canvas', exact: true }).click()
    await page.getByRole('textbox', { name: 'Canvas name' }).fill('A deliberately long canvas name that must never displace the view action')
    await page.getByRole('button', { name: 'Save canvas name', exact: true }).click()
    await page.keyboard.press('Escape')
    const a = (await action.boundingBox())!, title = (await page.locator('.galta-document').boundingBox())!
    const application = (await page.locator('.galta-application').boundingBox())!
    expect(a.x + a.width).toBeCloseTo(width - 16, 0)
    expect(title.x, 'document context follows the application region').toBeGreaterThanOrEqual(application.x + application.width)
    expect(title.x + title.width).toBeLessThanOrEqual(width - 16)
    if (a.y < title.y + title.height) expect(title.x + title.width).toBeLessThan(a.x)
    else expect(a.y, 'wrapped view controls stay below document context').toBeGreaterThanOrEqual(title.y + title.height)
    expect(a.width).toBeGreaterThanOrEqual(40)
    await expect(page.locator('.workspace-menu')).toHaveCount(0)
    await action.focus()
    await expect(page.getByRole('tooltip')).toHaveText('Expand canvas')
    await page.screenshot({ path: test.info().outputPath(`view-action-${width}.png`) })
  })
}

test('the reused document receives the latest draft and selection without a reload', async ({ page, context }) => {
  await installReturningAccount(context)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.locator('nav input[type=file]').setInputFiles('tests/fixtures/reference.svg')
  await expect(page.getByRole('region', {name:'Galta canvas, 1 objects',exact:true})).toBeVisible()
  await page.locator('.conversation-composer textarea').fill('The first draft')
  const receiver = await context.newPage()
  await receiver.addInitScript(() => {
    const host = window as any
    host.chrome.runtime.id = 'host-fixture'
    host.chrome.tabs = { getCurrent: async () => ({id:43,windowId:1}), get: async (id:number) => ({id,windowId:1}), onRemoved:{addListener(){},removeListener(){}} }
    host.chrome.storage.session = {set:async()=>{},get:async()=>({})}
    host.__documentIdentity = crypto.randomUUID()
  })
  await receiver.goto(`${acceptanceOrigin}/canvas/index.html?project=default-project#view=reusable-view`)
  await expect(receiver.locator('.conversation-composer textarea')).toHaveValue('The first draft')
  const identity = await receiver.evaluate(() => (window as any).__documentIdentity)
  await page.locator('.conversation-composer textarea').fill('Continue with the newer idea')
  // Draft writes are queued; export waits for the same production save boundary
  // used by the source's Expand action.
  await page.getByRole('button', {name:'Canvas menu',exact:true}).click()
  await page.getByRole('button', {name:'Current canvas actions',exact:true}).click()
  const exported = page.waitForEvent('download')
  await page.getByRole('button', {name:'Export canvas',exact:true}).click(); await exported
  const before = await storedWorkspace(page)
  const ids = before.snapshots[before.project.headCommitId].document.elements.map((e:any)=>e.id)
  await page.evaluate(selection => new Promise<void>((resolve,reject) => {
    const channel = new BroadcastChannel('galta-canvas-presentation'), token = crypto.randomUUID()
    const timer = setTimeout(()=>{channel.close();reject(new Error('No ready receipt'))},5000)
    channel.onmessage=({data})=>{if(data.token===token){clearTimeout(timer);channel.close();data.error?reject(new Error(data.error)):resolve()}}
    channel.postMessage({type:'present',target:'reusable-view',token,sourceTab:42,view:{selection,viewport:{center:{x:300,y:300},span:600}}})
  }), ids)
  await expect(receiver.locator('.conversation-composer textarea')).toHaveValue('Continue with the newer idea')
  await expect(receiver.getByLabel('1 selected object', {exact:true})).toBeVisible()
  await expect(receiver.getByRole('button',{name:'Back to page',exact:true})).toBeEnabled()
  expect(await receiver.evaluate(() => (window as any).__documentIdentity)).toBe(identity)
  expect((await storedWorkspace(receiver)).snapshots).toEqual(before.snapshots)
})
