import { test, expect } from '@playwright/test'

test('managed artifact Markdown stays actionable while machine paths stay inert', async ({ page }) => {
  await page.goto('/dev/conversation-test.html?artifact=1')
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()

  const artifact = page.getByRole('button', { name: 'Download selected.png', exact: true })
  await expect(artifact).toBeVisible()
  await expect(artifact).toHaveAttribute('data-artifact-uri', 'galta-workspace:/sources/selected.png')
  await expect(page.getByRole('link', { name: 'Reference', exact: true })).toHaveAttribute('href', 'https://example.com/reference')
  await expect(page.locator('.conversation-assistant a[href^="/tmp"], .conversation-assistant a[href^="file:"]')).toHaveCount(0)
  await expect(page.locator('.conversation-assistant button[data-artifact-uri]')).toHaveCount(1)

  await artifact.click()
  await expect.poll(() => page.evaluate(() => (window as any).__conversationArtifactDownloads)).toEqual(['galta-workspace:/sources/selected.png'])
})

test('a validated final-message path is projected to its receipt download', async ({ page }) => {
  await page.goto('/dev/conversation-test.html?artifact-delivery=1')
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  const artifact = page.getByRole('button', { name: 'Download selected image.png', exact: true })
  await expect(artifact).toBeVisible()
  await expect(artifact).toHaveAttribute('data-artifact-uri', 'galta-workspace:/deliveries/00000000-0000-4000-8000-000000000002/selected%20image.png')
  await expect(page.locator('.conversation-assistant a[href^="/tmp"], .conversation-assistant a[href^="file:"]')).toHaveCount(0)
  await artifact.click()
  await expect.poll(() => page.evaluate(() => (window as any).__conversationArtifactDownloads)).toEqual(['galta-workspace:/deliveries/00000000-0000-4000-8000-000000000002/selected%20image.png'])
})

test('a managed final-message alias is projected to one receipt download', async ({ page }) => {
  await page.goto('/dev/conversation-test.html?artifact-delivery-managed=1')
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  const artifact = page.getByRole('button', { name: 'Download selected image.png', exact: true })
  await expect(artifact).toBeVisible()
  await expect(artifact).toHaveAttribute('data-artifact-uri', 'galta-workspace:/deliveries/00000000-0000-4000-8000-000000000003/selected%20image.png')
  await expect(page.locator('[data-artifact-delivery] button[data-artifact-uri]')).toHaveCount(0)
  await expect(page.locator('.conversation-assistant button[data-artifact-uri]')).toHaveCount(1)
  await artifact.click()
  await expect.poll(() => page.evaluate(() => (window as any).__conversationArtifactDownloads)).toEqual(['galta-workspace:/deliveries/00000000-0000-4000-8000-000000000003/selected%20image.png'])
  await expect.poll(() => page.evaluate(() => (window as any).__conversationArtifactDownloadGrants)).toEqual([{
    receiptId: '00000000-0000-4000-8000-000000000003',
    projectId: 'fixture',
    threadId: '00000000-0000-4000-8000-000000000000',
    turnId: '00000000-0000-4000-8000-000000000001',
    messageId: 'managed-delivery-answer',
    href: '/tmp/creative/outputs/selected image.png',
    uri: 'galta-workspace:/deliveries/00000000-0000-4000-8000-000000000003/selected%20image.png'
  }])
})

test('empty and unselected native canvases produce bounded, truthful message observations', async ({ page }, info) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const { CanvasTool } = await import('/canvas/canvasTool.ts' as string)
    const { TaskScene } = await import('/canvas/toolScene.ts' as string)
    const { prepareCanvasMessage } = await import('/canvas/canvasMessage.ts' as string)
    const w = window as any, scene = w.scene, t = w.engineTest
    const viewport = { x: 0, y: 0, width: 600, height: 400, zoom: 1, center: { x: 300, y: 200 } }
    const scope = { executionId: 'test', cwd: '/tmp/galta-test', signal: new AbortController().signal }
    const observe = async (unchangedPreview?: string) => {
      const submitted = t.captureSubmittedContext(scene)
      submitted.viewport = { x: 0, y: 0, width: 600, height: 400, zoom: 1 }
      const task = new TaskScene(scene.snapshot(), [], viewport)
      try { return await prepareCanvasMessage(new CanvasTool(task, {}, () => { throw Error('Observation cannot write') }, submitted), submitted, 'commit', scope, unchangedPreview) }
      finally { task.close() }
    }
    const empty = await observe()
    t.apply([
      { type: 'create_element', id: 'unselected-stroke', elementType: 'freedraw', x: 40, y: 50, props: { points: [[0, 0], [100, 60], [180, 0]], strokeWidth: 8, strokeColor: '#ff00ff' } },
      { type: 'create_element', id: 'unselected-box', elementType: 'rectangle', x: 300, y: 100, props: { width: 150, height: 120, backgroundColor: '#00cc66', fillStyle: 'solid', roughness: 0 } }
    ])
    scene.select([])
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const message = await observe()
    const blob = await (await fetch(message.image.dataUrl)).blob(), bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close()
    let magenta = 0, green = 0
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i]! > 180 && pixels[i + 1]! < 90 && pixels[i + 2]! > 180) magenta++
      if (pixels[i]! < 80 && pixels[i + 1]! > 140 && pixels[i + 2]! < 160) green++
    }
    const unchanged = await observe(message.context.preview.evidenceId)
    return { empty, unchanged, context: message.context, image: message.image.dataUrl, pixels: { magenta, green, width: canvas.width, height: canvas.height, bytes: blob.size } }
  })
  expect(result.empty.context.preview.status).toBe('empty')
  expect(result.empty.image).toBeUndefined()
  expect(result.context.selection).toEqual({ total: 0, items: [], truncated: false })
  expect(result.context.visible.items.map((item: any) => [item.id, item.kind])).toEqual([['unselected-stroke', 'draw'], ['unselected-box', 'geo']])
  expect(result.context.preview).toMatchObject({ status: 'attached', unrenderedCount: 0, evidenceId: expect.any(String) })
  expect(result.context.evidence).toHaveLength(2)
  expect(result.context.evidence.map((item: any) => item.type)).toEqual(['structure', 'pixels'])
  expect(result.context.evidence[0]).toMatchObject({ revision: result.context.revision, capabilities: ['identity', 'bounds'], complete: true })
  expect(result.context.evidence[1]).toMatchObject({ revision: result.context.revision, capabilities: ['identity', 'pixels'], focus: 'region', mimeType: 'image/jpeg', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
  // Identities stay in the tool's evidence ledger; the message carries counts.
  expect(result.context.evidence.some((item: any) => 'elementIds' in item || 'missingElementIds' in item)).toBe(false)
  expect(result.unchanged.context.preview).toEqual({ status: 'unchanged', evidenceId: result.context.preview.evidenceId })
  expect(result.unchanged.image).toBeUndefined()
  expect(result.unchanged.context.visible).toEqual(result.context.visible)
  expect(result.pixels.magenta).toBeGreaterThan(100)
  expect(result.pixels.green).toBeGreaterThan(10_000)
  expect(Math.max(result.pixels.width, result.pixels.height)).toBeLessThanOrEqual(1400)
  expect(result.pixels.bytes).toBeLessThanOrEqual(600_000)
  await info.attach('submitted-viewport.jpg', { body: Buffer.from(result.image.split(',')[1]!, 'base64'), contentType: 'image/jpeg' })
})

test('visual claims name evidence and reject geometry or composite pixels', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const { CanvasTool } = await import('/canvas/canvasTool.ts' as string)
    const w = window as any, scene = w.scene, t = w.engineTest
    t.apply([{ type: 'create_element', id: 'shape', elementType: 'rectangle', x: 100, y: 100, props: { width: 240, height: 140, backgroundColor: '#ff0000', fillStyle: 'solid', roughness: 0 } }])
    const submitted = t.captureSubmittedContext(scene); submitted.viewport = { x: 0, y: 0, width: 600, height: 400, zoom: 1 }
    const tool = new CanvasTool(scene, {}, () => { throw Error('Observation cannot write') }, submitted)
    const scope = { executionId: 'test', cwd: '/tmp/galta-test', signal: new AbortController().signal }
    const read = await tool.execute('canvas_inspect', { ids: ['shape'], detail: 'elements' }, scope)
    const structure = (read.structuredContent as any).evidence
    const overview = (await tool.execute('canvas_capture', { region: { x: 0, y: 0, width: 600, height: 400 }, detail: 'low' }, scope)).structuredContent as any
    const exact = (await tool.execute('canvas_capture', { element: 'shape', include: 'exact', detail: 'high' }, scope)).structuredContent as any
    const evaluate = async (basis: string, evidenceIds: string[]) => (await tool.execute('canvas_report', { revision: structure.revision, claims: [{ claim: 'The object is red.', category: 'appearance', basis, evidenceIds, certainty: 'certain', targetIds: ['shape'] }] }, scope)).structuredContent
    const reports = { wrongMedium: await evaluate('bounds', [structure.id]), composite: await evaluate('pixels', [overview.evidence.id]), grounded: await evaluate('pixels', [exact.evidence.id]) }
    t.apply([{ type: 'create_element', id: 'revision-change', elementType: 'rectangle', x: 10, y: 10, props: { width: 20, height: 20 } }])
    let stale = ''
    try { await tool.execute('canvas_report', { revision: structure.revision, claims: [{ claim: 'The object is red.', category: 'appearance', basis: 'pixels', evidenceIds: [exact.evidence.id], certainty: 'certain', targetIds: ['shape'] }] }, scope) } catch (error) { stale = String(error) }
    return { structure, overview: overview.evidence, exact: exact.evidence, ...reports, stale }
  })
  expect(result.wrongMedium.assessments[0].status).toBe('unverified')
  expect(result.composite.assessments[0].status).toBe('insufficient-evidence')
  expect(result.grounded.assessments[0]).toMatchObject({ status: 'evidence-sufficient', certainty: 'certain', targetIds: ['shape'] })
  expect(result.exact.focus).toBe('exact')
  expect(result.exact.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(result.grounded.evidence.map((item: any) => item.id)).toEqual([result.exact.id])
  expect(result.stale).toContain('canvas changed')
})

test('selection, submitted viewport and change history remain separate and fully pageable', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const { CanvasTool } = await import('/canvas/canvasTool.ts' as string)
    const { prepareCanvasMessage } = await import('/canvas/canvasMessage.ts' as string)
    const w = window as any, scene = w.scene, t = w.engineTest
    const ids = Array.from({ length: 70 }, (_, i) => `item-${i}`)
    t.apply(ids.map((id, i) => ({ type: 'create_element', id, elementType: 'rectangle', x: (i % 10) * 50, y: Math.floor(i / 10) * 40, props: { width: 30, height: 20 } })))
    t.apply([{ type: 'create_text', id: 'offscreen', text: 'Offscreen selection', x: 5000, y: 5000 }])
    scene.select(['offscreen'])
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const submitted = t.captureSubmittedContext(scene)
    submitted.viewport = { x: 0, y: 0, width: 600, height: 400, zoom: 1 }
    submitted.changes = { since: 'previous', status: 'compared', elements: [
      ...ids.map(id => ({ id, change: 'created', sources: ['user'] })), { id: 'deleted', change: 'deleted', sources: ['agent'] }
    ] }
    const tool = new CanvasTool(scene, {}, () => { throw Error('Observation cannot write') }, submitted)
    const scope = { executionId: 'test', cwd: '/tmp/galta-test', signal: new AbortController().signal }
    const message = await prepareCanvasMessage(tool, submitted, 'commit', scope)
    const read = async (args: any) => (await tool.execute('canvas_inspect', args, scope)).structuredContent
    const selection = await read({ scope: 'selection' })
    const changes: any[] = [], view: any[] = []
    let changeEvidence: any
    for (const kind of ['changes', 'viewport']) {
      let args: any = { scope: kind, limit: 17 }
      do { const page = await read(args); if (kind === 'changes') changeEvidence = page.evidence; (kind === 'changes' ? changes : view).push(...page.elements); args = page.next } while (args)
    }
    scene.select([])
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const after = await read({ scope: 'selection' })
    const withoutHistory = new CanvasTool(scene, {}, () => {}, t.captureSubmittedContext(scene))
    let missingHistory = ''
    try { await withoutHistory.execute('canvas_inspect', { scope: 'changes' }, scope) } catch (error) { missingHistory = String(error) }
    return { context: message.context, selection, changes, view, after, missingHistory, changeEvidence }
  })
  expect(result.context.selection.items).toEqual(['offscreen'])
  expect(result.context.visible).toMatchObject({ total: 70, truncated: true })
  expect(result.context.visible.items).toHaveLength(12)
  expect(result.context.changes).toMatchObject({ since: 'previous', status: 'compared', total: 71, truncated: true })
  expect(result.context.evidence?.[0]).toMatchObject({ totalElementCount: 70, coveredElementCount: 12, complete: false })
  expect(result.context.evidence?.[1]).toMatchObject({ totalElementCount: 70, coveredElementCount: 64, complete: false })
  expect(result.selection.elements[0]).toMatchObject({ id: 'offscreen', selectedAtSubmission: true })
  expect(result.after.elements).toEqual(result.selection.elements)
  expect(result.changes).toHaveLength(71)
  expect(result.changes.at(-1)).toEqual({ id: 'deleted', missing: true, change: 'deleted', sources: ['agent'] })
  expect(result.changeEvidence.missingElementIds).toEqual(['deleted'])
  expect(result.view.map((item: any) => item.id)).toEqual(Array.from({ length: 70 }, (_, i) => `item-${i}`))
  expect(result.missingHistory).toContain('No submitted change history')
})

test('preview failures, unsupported HTML and cancellation are explicit', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const { CanvasTool } = await import('/canvas/canvasTool.ts' as string)
    const { TaskScene } = await import('/canvas/toolScene.ts' as string)
    const { prepareCanvasMessage } = await import('/canvas/canvasMessage.ts' as string)
    const w = window as any, scene = w.scene, t = w.engineTest
    // A page that sabotages its own poster is drawn as its title and counted as unrendered.
    w.testArtifacts.readHtml = async () => ({ html: `<!doctype html><html><head><script>XMLSerializer.prototype.serializeToString = () => '<broken'</script></head><body>Fixture</body></html>` })
    await t.tool('canvas_edit', { revision: t.revision(), operations: [{ type: 'create_element', id: 'html', elementType: 'html', x: 10, y: 20, props: { htmlPath: '/tmp/galta-test/fixture.html', width: 200, height: 150 } }] })
    const submitted = t.captureSubmittedContext(scene)
    submitted.viewport = { x: 0, y: 0, width: 600, height: 400, zoom: 1 }
    const task = new TaskScene(scene.snapshot(), [], { ...submitted.viewport, center: { x: 300, y: 200 } })
    const tool = new CanvasTool(task, {}, () => {}, submitted), controller = new AbortController()
    const scope = { executionId: 'test', cwd: '/tmp/galta-test', signal: controller.signal }
    try {
      const html = await prepareCanvasMessage(tool, submitted, 'commit', scope)
      task.preview = async () => { throw new Error('Renderer unavailable') }
      const failure = await prepareCanvasMessage(tool, submitted, 'commit', scope)
      task.preview = async () => { controller.abort(new Error('User stopped')); throw new Error('Rendering interrupted') }
      let stopped = ''
      try { await prepareCanvasMessage(tool, submitted, 'commit', scope) } catch (error) { stopped = String(error) }
      return { html: html.context, failure, stopped }
    } finally { task.close() }
  })
  expect(result.html.preview).toMatchObject({ status: 'attached', unrenderedCount: 1, evidenceId: expect.any(String) })
  expect(result.failure.context.preview).toEqual({ status: 'unavailable', unrenderedCount: 0, reason: 'Renderer unavailable' })
  expect(result.failure.image).toBeUndefined()
  expect(result.stopped).toContain('User stopped')
})

test('long identities cannot overflow the observation budget or hide truncation', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const { CanvasTool } = await import('/canvas/canvasTool.ts' as string)
    const { prepareCanvasMessage } = await import('/canvas/canvasMessage.ts' as string)
    const w = window as any, scene = w.scene, t = w.engineTest
    const ids = Array.from({ length: 1000 }, (_, i) => `historical-${i}-${'x'.repeat(3000)}`)
    const submitted = { ...t.captureSubmittedContext(scene), selection: ids,
      changes: { since: 'prior', status: 'compared', elements: ids.map(id => ({ id, change: 'deleted', sources: ['user'] })) } }
    const tool = new CanvasTool(scene, {}, () => {}, submitted)
    const message = await prepareCanvasMessage(tool, submitted, 'commit', { executionId: 'test', cwd: '/tmp/galta-test', signal: new AbortController().signal })
    return { context: message.context, characters: JSON.stringify(message.context).length }
  })
  expect(result.characters).toBeLessThanOrEqual(12_000)
  expect(result.context.selection).toMatchObject({ total: 1000, truncated: true })
  expect(result.context.changes).toMatchObject({ total: 1000, truncated: true })
})
