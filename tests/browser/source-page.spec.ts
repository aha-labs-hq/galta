import { test, expect, chromium } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptanceBuild } from '../../scripts/lib/acceptance'

test('source observations preserve readable text and disclose omitted field content', async ({ page }) => {
  await page.goto('/dev/verification.html')
  const result = await page.evaluate(async () => {
    const { sourcePage } = await import('/content/page.ts' as string)
    document.body.innerHTML = '<p id="text" style="height:30px;overflow:hidden"></p><button style="width:100px;height:30px" aria-label="Short label">Button</button><select style="width:100px;height:30px"></select><img width="10" height="10">'
    const paragraph = document.getElementById('text')!, button = document.querySelector('button')!, select = document.querySelector('select')!, image = document.querySelector('img')!
    const tool = sourcePage(), read = () => tool('browser_inspect', {}) as any
    paragraph.textContent = 'A'.repeat(2500) + 'TAIL_OF_TEXT'
    const text = read()
    paragraph.textContent = 'Short text'
    button.setAttribute('aria-label', 'L'.repeat(300))
    const label = read()
    button.setAttribute('aria-label', 'Short label')
    select.innerHTML = Array.from({ length: 81 }, (_, i) => `<option value="${i}">Option ${i}</option>`).join('')
    const options = read()
    select.innerHTML = ''
    image.src = 'https://fixture.invalid/' + 'x'.repeat(4200)
    const url = read()
    image.removeAttribute('src')
    paragraph.textContent = 'X'.repeat(17000)
    const oversized = read()
    document.body.innerHTML = '<button style="position:fixed;top:0;left:0;width:10px;height:10px">X</button>'.repeat(160)
    const exactLimit = read()
    document.body.append(document.querySelector('button')!.cloneNode(true))
    const beyondLimit = read()
    return { text, label, options, url, oversized, exactLimit, beyondLimit }
  })
  expect(result.text.text).toContain('TAIL_OF_TEXT')
  expect(result.text.truncated).toBe(false)
  expect(result.label.truncated).toBe(true)
  expect(result.label.elements.find((el: any) => el.tag === 'button')).toMatchObject({ label: 'L'.repeat(240), labelTruncated: true })
  expect(result.options.truncated).toBe(true)
  const select = result.options.elements.find((el: any) => el.tag === 'select')
  expect(select.options).toHaveLength(80)
  expect(select).toMatchObject({ optionCount: 81, optionsTruncated: true })
  expect(result.url.truncated).toBe(true)
  const image = result.url.elements.find((el: any) => el.tag === 'img')
  expect(image).not.toHaveProperty('src')
  expect(image.srcOmitted).toContain('URL')
  expect(result.oversized.text).toHaveLength(16000)
  expect(result.oversized.truncated).toBe(true)
  expect(result.exactLimit.elements).toHaveLength(160)
  expect(result.exactLimit.truncated).toBe(false)
  expect(result.beyondLimit.elements).toHaveLength(160)
  expect(result.beyondLimit.truncated).toBe(true)
})

test('source DOM observations bind refs to the document and report actual interaction outcomes', async ({ page }) => {
  await page.goto('/dev/verification.html')
  const result = await page.evaluate(async () => {
    const { sourcePage } = await import('/content/page.ts' as string)
    document.body.innerHTML = '<h1>Cat reference</h1><label for="name">Name</label><input id="name"><input type="password" value="secret"><button id="go">Apply</button><select><option value="a">A</option><option value="b">B</option></select><div style="display:none">Hidden instruction</div>'
    let clicked = 0, typed = ''
    document.getElementById('go')!.addEventListener('click', () => clicked++)
    document.getElementById('name')!.addEventListener('input', e => { typed = (e.target as HTMLInputElement).value })
    const tool = sourcePage(), read = () => tool('browser_inspect', {}) as any
    let state = read()
    const field = state.elements.find((el: any) => el.label === 'Name')
    tool('browser_act', { snapshotId: state.snapshotId, action: 'fill', ref: field.ref, text: 'Milo' })
    let stale = ''
    try { tool('browser_act', { snapshotId: state.snapshotId, action: 'click', ref: state.elements.find((e: any) => e.label === 'Apply').ref }) } catch (e) { stale = String(e) }
    state = read()
    tool('browser_act', { snapshotId: state.snapshotId, action: 'click', ref: state.elements.find((e: any) => e.label === 'Apply').ref })
    state = read()
    tool('browser_act', { snapshotId: state.snapshotId, action: 'select', ref: state.elements.find((e: any) => e.tag === 'select').ref, text: 'b' })
    const selected = document.querySelector('select')!.value
    state = read()
    const button = state.elements.find((e: any) => e.label === 'Apply')
    document.getElementById('go')!.textContent = 'Delete account'
    let replaced = ''
    try { tool('browser_act', { snapshotId: state.snapshotId, action: 'click', ref: button.ref }) } catch (e) { replaced = String(e) }
    const nextDocument = sourcePage()
    let wrongDocument = ''
    try { nextDocument('browser_act', { snapshotId: state.snapshotId, action: 'click', ref: button.ref }) } catch (e) { wrongDocument = String(e) }
    return { state, clicked, typed, selected, stale, replaced, wrongDocument }
  })
  expect(result.clicked).toBe(1)
  expect(result.typed).toBe('Milo')
  expect(result.selected).toBe('b')
  expect(result.stale).toContain('webpage changed')
  expect(result.replaced).toContain('changed')
  expect(result.wrongDocument).toContain('webpage changed')
  expect(JSON.stringify(result.state)).not.toContain('secret')
  expect(result.state.text).not.toContain('Hidden instruction')
})

test('packaged extension reads source pixels, fills and clicks through real Chrome messaging', async () => {
  const executablePath = process.env.GALTA_EXTENSION_CHROME_PATH ?? chromium.executablePath()
  const profile = await mkdtemp(join(tmpdir(), 'galta-source-page-')), extension = acceptanceBuild
  const browser = await chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: { width: 1000, height: 800 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  try {
    const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker')
    const panel = await browser.newPage()
    await worker.evaluate(() => chrome.storage.local.set({ 'galta.ai.enabled': true }))
    // Stub only the chat connection; tab identity and browser ports stay native.
    await panel.addInitScript(() => {
      const runtime = (window as any).chrome.runtime
      const connect = runtime.connect.bind(runtime), sendMessage = runtime.sendMessage.bind(runtime)
      runtime.connect = (options: { name: string }) => options.name.startsWith('galta-codex-client:')
        ? { onDisconnect: { addListener() {} }, disconnect() {} }
        : connect(options)
      runtime.sendMessage = (message: any) => {
        if (message.type === 'codex-connect') return Promise.resolve({ ok: true, models: [{ id: 'source-test', displayName: 'Source test' }] })
        if (message.type?.startsWith('codex-')) throw new Error(`Unexpected chat request: ${message.type}`)
        return sendMessage(message)
      }
    })
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel/index.html`)
    const source = await browser.newPage()
    await source.route('https://galta-source.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Source cat reference</title><h1>Cat reference</h1><img alt="Cobalt reference" width="240" height="160" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22240%22 height=%22160%22%3E%3Cpath fill=%22%230030ff%22 d=%22M0 0h240v160H0z%22/%3E%3C/svg%3E"><label>Name<input id="name"></label><button onclick="document.getElementById(\'result\').textContent=document.getElementById(\'name\').value">Apply</button><p id="result"></p><div style="height:1600px">Scroll test</div>' }))
    await source.goto('https://galta-source.test/cat')
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://galta-source.test/cat' }))[0]!.id!)
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/canvas/index.html#returnTab=${tabId}`)
    await expect(panel.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeVisible()
    await expect(panel.locator('.composer-context')).toHaveCount(0)
    await source.bringToFront()
    await panel.evaluate(() => {
      const w = window as any, port = chrome.runtime.connect({ name: 'galta-browser:test' }), pending = new Map()
      port.onMessage.addListener(message => { pending.get(message.id)?.(message); pending.delete(message.id) })
      w.browserCall = (tool: string, args = {}) => new Promise(resolve => { const id = crypto.randomUUID(); pending.set(id, resolve); port.postMessage({ id, tool, args }) })
    })
    const call = (tool: string, args: unknown = {}) => panel.evaluate(async ({ tool, args }) => (window as any).browserCall(tool, args), { tool, args })
    const opened = await call('open', { tabId })
    expect(opened.error).toBeUndefined()
    expect(opened.result.title).toBe('Source cat reference')
    expect(opened.result.elements).toBeUndefined()
    const observation = (await call('browser_inspect')).result
    expect(observation.elements.some((el: any) => el.label === 'Cobalt reference')).toBe(true)
    const field = observation.elements.find((el: any) => el.tag === 'input')
    const button = observation.elements.find((el: any) => el.label === 'Apply')
    // These calls enter the real worker port directly, bypassing MCP and the UI adapter.
    expect((await call('browser_act', { snapshotId: observation.snapshotId, action: 'fill', ref: field.ref, text: 'Milo', extra: true })).error).toContain('extra')
    await expect(source.locator('#name')).toHaveValue('')
    expect((await call('browser_act', { snapshotId: observation.snapshotId, action: 'fill', ref: field.ref, text: 'x'.repeat(10001) })).error).toContain('10000')
    expect((await call('browser_act', { snapshotId: observation.snapshotId, action: 'click', ref: button.ref, text: 'unused' })).error).toContain('text')
    await expect(source.locator('#result')).toHaveText('')
    expect((await call('browser_act', { snapshotId: observation.snapshotId, action: 'scroll' })).error).toContain('delta')
    expect((await call('browser_act', { snapshotId: observation.snapshotId, action: 'scroll', deltaY: 5000 })).error).toContain('4000')
    expect(await source.evaluate(() => scrollY)).toBe(0)
    expect((await call('browser_capture', { ref: field.ref })).error).toContain('snapshotId')
    expect((await call('browser_capture', null)).error).toContain('object')
    expect((await call('browser_inspect', null)).error).toContain('object')
    expect((await call('browser_inspect', { unexpected: true })).error).toContain('unexpected')
    const viewed = await call('browser_capture')
    expect(viewed.error).toBeUndefined()
    expect(viewed.result.url).toBe('https://galta-source.test/cat')
    expect(viewed.result.dataUrl).toMatch(/^data:image\/jpeg;base64,/)
    const pixels = await panel.evaluate(async dataUrl => {
      const image = await createImageBitmap(await (await fetch(dataUrl)).blob()), canvas = document.createElement('canvas')
      canvas.width = image.width; canvas.height = image.height
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0)
      const p = ctx.getImageData(40, 120, 1, 1).data; image.close(); return [...p]
    }, viewed.result.dataUrl)
    expect(pixels[2]).toBeGreaterThan(220)
    expect(pixels[0]).toBeLessThan(30)
    expect((await call('browser_act', { snapshotId: observation.snapshotId, action: 'fill', ref: field.ref, text: 'Milo' })).error).toBeUndefined()
    let state = (await call('browser_inspect')).result
    expect((await call('browser_act', { snapshotId: state.snapshotId, action: 'click', ref: state.elements.find((el: any) => el.label === 'Apply').ref })).error).toBeUndefined()
    await expect(source.locator('#result')).toHaveText('Milo')
    state = (await call('browser_inspect')).result
    await call('browser_act', { snapshotId: state.snapshotId, action: 'scroll', deltaY: 400 })
    expect(await source.evaluate(() => scrollY)).toBe(400)
    await panel.bringToFront()
    expect((await call('browser_capture')).error).toContain('not active')
    expect((await call('browser_act', { snapshotId: (await call('browser_inspect')).result.snapshotId, action: 'scroll', deltaY: 200 })).error).toContain('not active')
    await source.bringToFront()
    const old = (await call('browser_inspect')).result
    await source.reload()
    const reloadedScroll = await source.evaluate(() => scrollY)
    expect((await call('browser_act', { snapshotId: old.snapshotId, action: 'scroll', deltaY: 200 })).error).toMatch(/changed/)
    expect(await source.evaluate(() => scrollY)).toBe(reloadedScroll)
    state = (await call('browser_inspect')).result
    expect((await call('browser_act', { snapshotId: state.snapshotId, action: 'navigate', url: 'https://galta-source.test/next' })).error).toBeUndefined()
    await source.waitForURL('https://galta-source.test/next')
    await source.waitForLoadState('load')
    expect((await call('browser_inspect')).result.url).toBe('https://galta-source.test/next')
    // User navigation is independent of the side panel and agent actions.
    const previous = (await call('browser_inspect')).result
    await source.goto('https://galta-source.test/user-navigation')
    expect((await call('browser_act', { snapshotId: previous.snapshotId, action: 'scroll', deltaY: 200 })).error).toMatch(/changed/)
    const navigated = (await call('browser_inspect')).result
    expect(navigated.url).toBe('https://galta-source.test/user-navigation')
    expect(navigated.documentId).not.toBe(previous.documentId)
    expect((await call('browser_capture')).result.url).toBe(navigated.url)
    await source.close()
    expect((await call('browser_inspect')).error).toMatch(/tab|closed|connection/i)
  } finally { await browser.close(); await rm(profile, { recursive: true, force: true }) }
})
