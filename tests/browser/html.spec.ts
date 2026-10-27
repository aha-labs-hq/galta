import { test, expect, chromium } from '@playwright/test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptanceBuild } from '../../scripts/lib/acceptance'

const html = `<!doctype html><html><head><meta charset="utf-8"><base href="about:blank"><style>body{margin:0;padding:32px;font:20px system-ui;background:#f4eee5;color:#39332e}button{font:inherit;padding:12px}section{height:1100px}</style></head><body><h1>Interactive canvas</h1><button onclick="this.textContent='Clicked'">Try it</button><p><a href="#document%20end%20%E2%9C%93">Jump to end</a></p><section>Scrollable document</section><p id="document end ✓">Document end</p><a href="#">Back to top</a><script>document.body.dataset.ready='yes'</script></body></html>`
const create = { type: 'create_element', elementType: 'html', x: 260, y: 120, props: { htmlPath: '/tmp/galta-test/page.html', width: 720, height: 640 } }

async function setup(page: any) {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  await page.evaluate((html: string) => { (window as any).testArtifacts.readHtml = async () => ({ html }) }, html)
}

async function checkFragmentNavigation(content: any) {
  // An embed may be clipped by the outer canvas. Its own viewport is the
  // boundary for document scrolling, independent of the canvas camera.
  const inDocumentViewport = (locator: any) => locator.evaluate((element: HTMLElement) => {
    const bounds = element.getBoundingClientRect()
    return bounds.top >= 0 && bounds.bottom <= innerHeight
  })
  const before = await content.locator('body').evaluate(() => ({
    url: location.href, target: (document.querySelector('a') as HTMLAnchorElement).href
  }))
  expect(before.url).toBe('about:srcdoc')
  expect(before.target).toBe(`${before.url}#document%20end%20%E2%9C%93`)
  await content.getByRole('link', { name: 'Jump to end', exact: true }).click()
  await expect.poll(() => content.locator('body').evaluate(() => location.href)).toBe(before.target)
  await expect.poll(() => inDocumentViewport(content.getByText('Document end', { exact: true }))).toBe(true)
  expect(await content.locator('body').evaluate(() => window.scrollY)).toBeGreaterThan(0)
  await expect(content.getByRole('button')).toHaveText('Clicked')
  await content.getByRole('link', { name: 'Back to top', exact: true }).click()
  await expect.poll(() => inDocumentViewport(content.getByRole('heading'))).toBe(true)
  await expect.poll(() => content.locator('body').evaluate(() => location.href)).toBe(`${before.url}#`)
  await expect(content.getByRole('button')).toHaveText('Clicked')
  await content.locator('body').evaluate(() => {
    const link = document.createElement('a')
    link.href = '#document%20end%20%E2%9C%93'; link.textContent = 'Dynamic jump'
    document.body.prepend(link)
  })
  await content.getByRole('link', { name: 'Dynamic jump', exact: true }).click()
  await expect.poll(() => content.locator('body').evaluate(() => location.href)).toBe(before.target)
  await expect.poll(() => inDocumentViewport(content.getByText('Document end', { exact: true }))).toBe(true)
  await content.getByRole('link', { name: 'Back to top', exact: true }).click()
  await expect(content.getByRole('button')).toHaveText('Clicked')
}

test('HTML import is atomic through artifact failures, stale revisions, Stop and failed saving', async ({ page }) => {
  await setup(page)
  const result = await page.evaluate(async ({ html, create }) => {
    const w = window as any, t = w.engineTest, s = w.scene
    t.apply([{ type: 'create_text', text: 'Existing artwork', x: 30, y: 30 }])
    const before = JSON.stringify(s.snapshot().document), failures: string[] = []
    const run = () => t.tool('canvas_edit', { revision: t.revision(), operations: [create] })
    for (const readHtml of [async () => { throw Error('Unreadable artifact') }, async () => ({ html: 'invalid' })]) {
      w.testArtifacts.readHtml = readHtml
      try { await run() } catch (e) { failures.push(String(e)) }
    }
    w.testArtifacts.readHtml = async () => ({ html }); w.failSave = true
    try { await run() } catch (e) { failures.push(String(e)) }
    w.failSave = false
    const unchanged = before === JSON.stringify(s.snapshot().document)
    w.testArtifacts.readHtml = async () => { t.apply([{ type: 'move', elementId: s.elements[0].id, x: 50, y: 50 }]); return { html } }
    try { await run() } catch (e) { failures.push(String(e)) }
    const controller = new AbortController()
    w.testArtifacts.readHtml = async () => { controller.abort(Error('Stopped')); return { html } }
    try { await t.tool('canvas_edit', { revision: t.revision(), operations: [create] }, { signal: controller.signal }) } catch (e) { failures.push(String(e)) }
    w.testArtifacts.readHtml = async () => ({ html })
    try { await t.tool('canvas_edit', { revision: t.revision(), operations: [{ type: 'update_element', elementId: s.elements[0].id, props: create.props }] }) } catch (e) { failures.push(String(e)) }
    return { unchanged, failures, objects: s.elements.map((e: any) => e.type), x: s.elements[0].x }
  }, { html, create })
  expect(result.unchanged).toBe(true)
  expect(result.objects).toEqual(['text'])
  expect(result.x).toBe(50)
  expect(result.failures.join('\n')).toContain('Unreadable artifact')
  expect(result.failures.join('\n')).toContain('complete HTML')
  expect(result.failures.join('\n')).toContain('Storage unavailable')
  expect(result.failures.join('\n')).toContain('canvas changed')
  expect(result.failures.join('\n')).toContain('Stopped')
  expect(result.failures.join('\n')).toContain('existing HTML object')
})

test('HTML creates, updates, undoes and reopens with its source preserved and shared across history', async ({ page }) => {
  await setup(page)
  const result = await page.evaluate(async ({ html, create }) => {
    const w = window as any, scene = w.scene
    const { CanvasTool, canvasRevision } = await import('/canvas/canvasTool.ts' as string)
    const { createInitialWorkspace, initializeWorkspaceSnapshot, stageAgentSnapshot, activateCanvasSnapshot, defaultRuntime } = await import('/canvas/workspace.ts' as string)
    const repo = w.engineTest.repository, initial = createInitialWorkspace()
    await repo.save(initializeWorkspaceSnapshot(initial, initial.project.headCommitId, scene.snapshot()))
    const tool = new CanvasTool(scene, { readHtml: async () => ({ html: w.htmlSource ?? html }) }, async (mutation: any) => {
      let candidate: any
      await repo.update(initial.project.id, (current: any) => {
        mutation.assertCurrent()
        const staged = stageAgentSnapshot(current, current.project.headCommitId, mutation.before, mutation.snapshot, defaultRuntime)
        candidate = staged.candidateId
        return staged.workspace
      })
      mutation.apply()
      await repo.update(initial.project.id, (current: any) => activateCanvasSnapshot(current, candidate, scene.snapshot().view))
    })
    const scope = { cwd: '/tmp/galta-test', executionId: 'html-test', signal: new AbortController().signal }
    const apply = (operations: any[]) => tool.execute('canvas_edit', { revision: canvasRevision(scene), operations }, scope)
    await apply([create]); const id = scene.elements[0].id
    await apply([{ type: 'move', elementId: id, x: 260, y: 140 }])
    w.htmlSource = html.replace('Interactive canvas', 'Updated canvas')
    await apply([{ type: 'update_element', elementId: id, props: { htmlPath: '/tmp/galta-test/page.html' } }])
    const saved = await repo.load(initial.project.id)
    const documents = Object.values(saved.snapshots).flatMap((snapshot: any) => snapshot.document.elements.map((e: any) => e.customData?.htmlDocument).filter(Boolean))
    w.htmlSavedProject = initial.project.id
    sessionStorage.setItem('html-project', initial.project.id)
    const read = await tool.execute('canvas_inspect', { detail: 'elements' }, scope)
    return { shared: documents[0] === documents[1], originals: documents.filter((d: any) => d.html === html).length,
      updated: documents.at(-1).html === w.htmlSource, read: JSON.parse(read.content[0].text), id }
  }, { html, create })
  expect(result).toMatchObject({ shared: true, originals: 2, updated: true })
  expect(result.read.elements[0]).toMatchObject({ id: result.id, kind: 'html', html: true, generatedPath: create.props.htmlPath })
  expect(await page.evaluate(async () => {
    const w = window as any, saved = await w.engineTest.repository.load(w.htmlSavedProject)
    const paths = Object.values(saved.snapshots).flatMap((snapshot: any) => snapshot.document.elements.map((element: any) => element.customData?.generatedPath).filter(Boolean))
    return { paths: [...new Set(paths)], containsMachineRoot: JSON.stringify(saved).includes('/tmp/galta-test') }
  })).toEqual({ paths: ['galta-workspace:/page.html'], containsMachineRoot: false })
  // The document bytes never enter the manifest.
  expect(JSON.stringify(result.read)).not.toContain('<!doctype')
  // The engine writes `--embeddable-radius: 0px` inline on every embeddable
  // container and never defines the variable itself, so its own radius
  // declaration was silently dropped and every preview rendered square. The
  // adapter overrides it with the control radius, squared at the top where the
  // page meets its browser bar, and the frame takes a Galta surface and border
  // so a document does not read as another artwork object.
  // This harness mounts the bare engine without Galta's canvas shell, and the
  // adapter is scoped to that shell (`.galta-canvas .excalidraw`), so the shell
  // is applied here for the measurement and removed afterwards.
  expect(await page.evaluate(() => {
    const frame = document.querySelector('iframe[title="HTML preview"]')!
    const shell = document.querySelector('.excalidraw')!.parentElement!
    shell.classList.add('galta-canvas')
    const inner = document.querySelector('.excalidraw__embeddable-container__inner')!
    const frameStyle = getComputedStyle(frame), innerStyle = getComputedStyle(inner)
    const result = { frameRadius: [frameStyle.borderTopLeftRadius, frameStyle.borderBottomLeftRadius], innerRadius: [innerStyle.borderTopRightRadius, innerStyle.borderBottomRightRadius], frameBorder: `${frameStyle.borderTopWidth} ${frameStyle.borderTopStyle}`, frameBackground: frameStyle.backgroundColor }
    shell.classList.remove('galta-canvas')
    return result
  })).toEqual({ frameRadius: ['0px', '8px'], innerRadius: ['0px', '8px'], frameBorder: '1px solid', frameBackground: 'rgb(255, 255, 255)' })
  const content = page.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML document"]')
  await expect(content.getByRole('heading')).toHaveText('Updated canvas')
  await page.locator('.excalidraw').focus(); await page.keyboard.press('Meta+z')
  await expect(content.getByRole('heading')).toHaveText('Interactive canvas')
  await page.keyboard.press('Meta+Shift+z')
  await expect(content.getByRole('heading')).toHaveText('Updated canvas')
  await page.reload(); await page.waitForFunction(() => Boolean((window as any).engineTest))
  await page.evaluate(async () => {
    const w = window as any, bundle = await w.engineTest.repository.load(sessionStorage.getItem('html-project'))
    w.scene.restore(bundle.snapshots[bundle.project.headCommitId])
  })
  await expect(content.getByRole('heading')).toHaveText('Updated canvas')
})

test('canvas_extract materializes embedded HTML as a reusable source file', async ({ page }) => {
  await setup(page)
  const result = await page.evaluate(async () => {
    const w = window as any, html = '<!doctype html><html><body><h1>Extract me</h1></body></html>', writes: any[] = []
    w.testArtifacts.readHtml = async () => ({ html })
    w.testArtifacts.writeArtifact = async (path: string, dataBase64: string, mimeType: string) => writes.push({ path, dataBase64, mimeType })
    const createdResult = await w.engineTest.tool('canvas_edit', { revision: w.engineTest.revision(), operations: [{ type: 'create_element', elementType: 'html', x: 10, y: 20, props: { htmlPath: '/tmp/galta-test/source.html', width: 320, height: 180 } }] })
    const created = JSON.parse(createdResult.content[0].text)
    const id = created.elements[0].id
    const extracted = JSON.parse((await w.engineTest.tool('canvas_extract', { element: id, source: 'current' })).content[0].text)
    const bytes = Uint8Array.from(atob(writes[0].dataBase64), c => c.charCodeAt(0))
    return { extracted, write: { path: writes[0].path, mimeType: writes[0].mimeType, html: new TextDecoder().decode(bytes) } }
  })
  expect(result.extracted).toMatchObject({ kind: 'html', mimeType: 'text/html', source: 'element', width: 320, height: 180 })
  expect(result.write).toMatchObject({ mimeType: 'text/html', html: '<!doctype html><html><body><h1>Extract me</h1></body></html>' })
  expect(result.write.path).toMatch(/\/sources\/[0-9a-f]{64}\.html$/)
})

// A page lives only where the canvas shows it; every bitmap of the canvas
// shows a poster of the loaded page instead. Here the page's content exists
// only after its script runs, and a red square is drawn on its own canvas.
// A page that sabotages its own capture is drawn as its title and named as
// unrendered, never as an empty box with the renderer's internal address.
test('canvas bitmaps show a page as a poster of the loaded page, or its title when it cannot be drawn', async ({ page }) => {
  await setup(page)
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest
    const sources: Record<string, string> = {
      '/tmp/galta-test/built.html': `<!doctype html><html><head><title>Built page</title></head><body style="margin:0;background:#0e1b26"><script>document.body.insertAdjacentHTML('beforeend', '<canvas id="mark" width="80" height="80" style="position:absolute;left:40px;top:40px;width:80px;height:80px"></canvas>'); const mark = document.getElementById('mark').getContext('2d'); mark.fillStyle = '#ff0000'; mark.fillRect(0, 0, 80, 80)</script></body></html>`,
      '/tmp/galta-test/broken.html': `<!doctype html><html><head><title>Broken page</title><script>XMLSerializer.prototype.serializeToString = () => '<broken'</script></head><body>Never drawn</body></html>`,
    }
    w.testArtifacts.readHtml = async (path: string) => ({ html: sources[path] })
    await t.tool('canvas_edit', { revision: t.revision(), operations: [
      { type: 'create_element', id: 'built', elementType: 'html', x: 0, y: 0, props: { htmlPath: '/tmp/galta-test/built.html', width: 400, height: 300 } },
      { type: 'create_element', id: 'broken', elementType: 'html', x: 600, y: 0, props: { htmlPath: '/tmp/galta-test/broken.html', width: 400, height: 300 } },
    ] })
    const read = async (blob: Blob) => {
      const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas')
      canvas.width = bitmap.width; canvas.height = bitmap.height
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0)
      return { width: bitmap.width, at: (x: number, y: number) => Array.from(context.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)) }
    }
    // The agent's view: 20 units of padding around the one element.
    const capture = async (id: string) => {
      const view = await t.tool('canvas_capture', { ids: [id] }), image = view.content.find((part: any) => part.type === 'image')
      const pixels = await read(await (await fetch(`data:${image.mimeType};base64,${image.data}`)).blob()), scale = pixels.width / 440
      return { meta: view.structuredContent, background: pixels.at((20 + 300) * scale, (20 + 250) * scale), mark: pixels.at((20 + 80) * scale, (20 + 80) * scale), corner: pixels.at((20 + 12) * scale, (20 + 12) * scale) }
    }
    const built = await capture('built'), broken = await capture('broken')
    w.scene.api.updateScene({ appState: { selectedElementIds: { built: true } } })
    const { exportSelection } = await import('/canvas/selectionExport.ts' as string)
    const exported = await read(await exportSelection(w.scene)), scale = exported.width / 400
    const { themeColor } = await import('/design/theme.ts' as string)
    const card = document.createElement('canvas').getContext('2d')!
    card.fillStyle = themeColor('surface-hover'); card.fillRect(0, 0, 1, 1)
    return { built, broken, exported: { background: exported.at(300 * scale, 250 * scale), mark: exported.at(80 * scale, 80 * scale) }, card: Array.from(card.getImageData(0, 0, 1, 1).data.slice(0, 3)) }
  })
  const near = (actual: number[], expected: number[], tolerance = 24) => actual.every((value, i) => Math.abs(value - expected[i]!) <= tolerance)
  const dark = [14, 27, 38], red = [255, 0, 0]
  expect(result.built.meta).toMatchObject({ htmlPosterIds: ['built'], unrenderedElementIds: [], complete: false })
  expect(result.built.meta.limitation).toContain('poster of its page')
  expect(near(result.built.background, dark), `capture background ${result.built.background}`).toBe(true)
  expect(near(result.built.mark, red, 48), `capture mark ${result.built.mark}`).toBe(true)
  expect(near(result.exported.background, dark), `export background ${result.exported.background}`).toBe(true)
  expect(near(result.exported.mark, red, 48), `export mark ${result.exported.mark}`).toBe(true)
  expect(result.broken.meta).toMatchObject({ htmlPosterIds: [], unrenderedElementIds: ['broken'], complete: false })
  expect(near(result.broken.corner, result.card, 12), `title card ${result.broken.corner} vs ${result.card}`).toBe(true)
})

for (const width of [720, 390]) test(`packaged MV3 extension preserves HTML navigation, isolation, export and reload at ${width}px`, async ({ page }) => {
  test.skip(!process.env.GALTA_EXTENSION_CHROME_PATH, 'Set GALTA_EXTENSION_CHROME_PATH to an extension-capable Chromium executable')
  await setup(page)
  const envelope = await page.evaluate(async ({ create, width }) => {
    const w = window as any
    await w.engineTest.tool('canvas_edit', { revision: w.engineTest.revision(), operations: [{ ...create, props: { ...create.props, width } }] })
    const { createInitialWorkspace, initializeWorkspaceSnapshot } = await import('/canvas/workspace.ts' as string)
    const bundle = createInitialWorkspace()
    return { format: 'galta-workspace', schemaVersion: 1, exportedAt: Date.now(), workspace: initializeWorkspaceSnapshot(bundle, bundle.project.headCommitId, w.scene.snapshot()) }
  }, { create, width })
  const profile = await mkdtemp(join(tmpdir(), 'galta-html-extension-')), extension = acceptanceBuild
  const browser = await chromium.launchPersistentContext(profile, { executablePath: process.env.GALTA_EXTENSION_CHROME_PATH!, headless: true, viewport: { width: 1440, height: 1000 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  try {
    const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker')
    const live = await browser.newPage(), errors: string[] = []
    live.on('console', message => {
      if (message.type() === 'error' && /Content Security Policy|Blocked script/i.test(message.text()) && !message.text().includes('galta-html-csp-probe')) errors.push(message.text())
    })
    await live.goto(`chrome-extension://${new URL(worker.url()).host}/canvas/index.html`)
    await expect(live.getByRole('button', { name: 'Canvas menu', exact: true })).toBeVisible()
    await expect(live.getByRole('button', { name: 'Canvas zoom', exact: true })).toBeVisible()
    await expect(live.getByText('Opening canvas…', { exact: true })).not.toBeVisible()
    await live.locator('input[aria-label="Import canvas file"]').setInputFiles({ name: 'html.galta', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(envelope)) })
    const content = live.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML document"]')
    await expect(content.getByRole('heading')).toHaveText('Interactive canvas')
    await expect.poll(() => content.locator('body').evaluate(() => window.innerWidth)).toBeLessThanOrEqual(width)
    await expect(content.locator('body')).toHaveAttribute('data-ready', 'yes')
    await expect.poll(() => content.locator('body').evaluate(() => document.readyState)).toBe('complete')
    const bounds = await live.locator('iframe[title="HTML preview"]').boundingBox()
    await live.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
    await expect(live.locator('.excalidraw__embeddable-container__inner')).toHaveCSS('pointer-events', 'all')
    await content.getByRole('button', { name: 'Try it' }).click()
    await expect(content.getByRole('button')).toHaveText('Clicked')
    await live.mouse.click(1100, 120)
    await live.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
    await expect(live.locator('.excalidraw__embeddable-container__inner')).toHaveCSS('pointer-events', 'all')
    await expect(content.getByRole('button')).toHaveText('Clicked')
    const isolation = await content.locator('body').evaluate(() => {
      let parentBlocked = false, storageBlocked = false
      try { void window.top!.document } catch { parentBlocked = true }
      try { localStorage.setItem('probe', 'x') } catch { storageBlocked = true }
      return { parentBlocked, storageBlocked, extensionApi: Boolean((window as any).chrome?.runtime?.id) }
    })
    expect(isolation).toEqual({ parentBlocked: true, storageBlocked: true, extensionApi: false })
    const csp = await content.locator('body').evaluate(() => new Promise<{ directive: string; blocked: string }>(resolve => {
      addEventListener('securitypolicyviolation', event => resolve({ directive: event.effectiveDirective, blocked: event.blockedURI }), { once: true })
      void fetch('http://127.0.0.1/galta-html-csp-probe').catch(() => {})
    }))
    expect(csp.directive).toBe('connect-src')
    expect(csp.blocked).toContain('http://127.0.0.1')
    await checkFragmentNavigation(content)
    // Repeated owner messages preserve the document, while messages from the
    // generated document cannot replace it even with the expected message type.
    await live.locator('iframe[title="HTML preview"]').evaluate((frame, html) => {
      (frame as HTMLIFrameElement).contentWindow!.postMessage({ type: 'galta-html-preview', html }, '*')
    }, html)
    await content.locator('body').evaluate(() => {
      parent.postMessage({ type: 'galta-html-preview', html: '<!doctype html><html><body>Untrusted replacement</body></html>' }, '*')
    })
    await expect(content.getByRole('heading')).toHaveText('Interactive canvas')
    await expect(content.getByRole('button')).toHaveText('Clicked')
    await live.mouse.click(1100, 120)
    await live.locator('.excalidraw').focus(); await live.keyboard.press('Meta+a')
    await expect(live.locator('.excalidraw-hyperlinkContainer')).toHaveCount(0)
    await live.keyboard.press('Meta+k')
    await expect(live.locator('.excalidraw-hyperlinkContainer')).toHaveCount(0)
    await live.getByRole('button', { name: 'Export selection', exact: true }).click()
    const sourceDownload = live.waitForEvent('download')
    await live.getByRole('button', { name: /^HTML webpage/ }).click()
    const sourcePath = test.info().outputPath(`page-${width}.html`)
    await (await sourceDownload).saveAs(sourcePath)
    expect(await readFile(sourcePath, 'utf8')).toBe(html)
    await live.getByRole('button', { name: 'Back to selection actions', exact: true }).click()
    const opened = browser.waitForEvent('page')
    await live.getByRole('button', { name: 'Open', exact: true }).click()
    const preview = await opened
    await expect(preview).toHaveURL(/\/page\/index\.html\?project=.+&version=.+&element=.+/)
    expect(await preview.evaluate(() => window.opener)).toBeNull()
    const previewContent = preview.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML document"]')
    await expect(previewContent.getByRole('heading')).toHaveText('Interactive canvas')
    await expect(previewContent.locator('body')).toHaveAttribute('data-ready', 'yes')
    await expect.poll(() => previewContent.locator('body').evaluate(() => document.readyState)).toBe('complete')
    await previewContent.getByRole('button', { name: 'Try it' }).click()
    await expect(previewContent.getByRole('button')).toHaveText('Clicked')
    expect(await previewContent.locator('body').evaluate(() => {
      try { void window.top!.document; return false } catch { return !Boolean((window as any).chrome?.runtime?.id) }
    })).toBe(true)
    await preview.reload()
    await expect(previewContent.getByRole('heading')).toHaveText('Interactive canvas')
    await expect(previewContent.getByRole('button')).toHaveText('Try it')
    const previewDownload = preview.waitForEvent('download')
    await preview.getByRole('button', { name: 'Download HTML', exact: true }).click()
    const previewPath = test.info().outputPath(`preview-${width}.html`)
    await (await previewDownload).saveAs(previewPath)
    expect(await readFile(previewPath, 'utf8')).toBe(html)
    const unavailable = new URL(preview.url()); unavailable.searchParams.set('version', 'removed-version')
    await preview.goto(unavailable.href)
    await expect(preview.getByRole('alert')).toHaveText('This saved page is no longer available. Open the current version from your canvas.')
    await expect(preview.locator('iframe')).toHaveCount(0)
    await preview.close()
    if (width === 720) {
      // A preview must never navigate to a version that failed to save.
      await live.evaluate(() => {
        const put = IDBObjectStore.prototype.put
        ;(window as any).restorePreviewSave = () => { IDBObjectStore.prototype.put = put }
        IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
          if (this.name === 'workspaces') throw new DOMException('Preview save test', 'QuotaExceededError')
          return put.apply(this, args)
        }
      })
      await live.locator('.excalidraw').focus(); await live.keyboard.press('ArrowRight')
      const failedOpen = browser.waitForEvent('page')
      await live.getByRole('button', { name: 'Open', exact: true }).click()
      const failedPreview = await failedOpen
      await expect(live.getByRole('alert')).toContainText('Preview save test')
      await expect.poll(() => failedPreview.isClosed()).toBe(true)
      await live.evaluate(() => { (window as any).restorePreviewSave(); delete (window as any).restorePreviewSave })
      const resumedOpen = browser.waitForEvent('page')
      await live.getByRole('button', { name: 'Open', exact: true }).click()
      const resumedPreview = await resumedOpen
      await expect(resumedPreview.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML document"]').getByRole('heading')).toHaveText('Interactive canvas')
      await resumedPreview.close()
    }
    await live.getByRole('button', { name: 'Canvas menu', exact: true }).click()
    // The canvas list shows the page itself, on its own background, where it
    // once showed an empty box with the renderer's internal address.
    const thumbnail = live.locator('.workspace-canvas-preview img').first()
    await expect.poll(() => thumbnail.evaluate(async (image: HTMLImageElement) => {
      await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
      const pixel = Array.from(context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data.slice(0, 3))
      return pixel.every((value, i) => Math.abs(value - [244, 238, 229][i]!) <= 8) ? 'page background' : `pixel ${pixel}`
    }).catch(error => String(error)), { timeout: 15_000 }).toBe('page background')
    await live.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
    const download = live.waitForEvent('download')
    await live.getByRole('button', { name: 'Export canvas', exact: true }).click()
    const stream = await (await download).createReadStream(), chunks: Buffer[] = []
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
    const exported = JSON.parse(Buffer.concat(chunks).toString())
    expect(exported.workspace.snapshots[exported.workspace.project.headCommitId].document.elements[0].customData.htmlDocument.html).toBe(html)
    await live.reload()
    await expect(content.getByRole('heading')).toHaveText('Interactive canvas')
    await expect(content.getByRole('button')).toHaveText('Try it')
    await live.screenshot({ path: test.info().outputPath(`html-extension-${width}.png`) })
    if (process.env.GALTA_HTML_FIXTURE) {
      const source = await readFile(process.env.GALTA_HTML_FIXTURE, 'utf8')
      const snapshot = (envelope.workspace.snapshots as any)[envelope.workspace.project.headCommitId]
      snapshot.document.elements[0].width = 720
      snapshot.document.elements[0].customData.htmlDocument.html = source
      await live.locator('input[aria-label="Import canvas file"]').setInputFiles({ name: 'actual-html.galta', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(envelope)) })
      await expect(content.locator('body')).toBeVisible()
      await expect.poll(() => content.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true)
      await live.screenshot({ path: test.info().outputPath('actual-html-extension.png') })
      await live.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
      await expect(live.locator('.excalidraw__embeddable-container__inner')).toHaveCSS('pointer-events', 'all')
      await content.locator('#palette-open').click()
      await expect(content.locator('dialog#detail')).toBeVisible()
      await content.getByRole('button', { name: 'Close details', exact: true }).click()
      await expect(content.locator('dialog#detail')).not.toBeVisible()
    }
    expect(errors).toEqual([])
  } catch (error) {
    console.error('HTML extension diagnostics', { frames: browser.pages().flatMap(page => page.frames().map(frame => frame.url())) })
    throw error
  } finally { await browser.close(); await rm(profile, { recursive: true, force: true }) }
})
