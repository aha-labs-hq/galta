import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
})

test('the submitted preview preserves readable pixel density across world scales', async ({ page }, info) => {
  const results = await page.evaluate(async () => {
    const { CanvasTool } = await import('/canvas/canvasTool.ts' as string)
    const { TaskScene } = await import('/canvas/toolScene.ts' as string)
    const { prepareCanvasMessage } = await import('/canvas/canvasMessage.ts' as string)
    const { scene, engineTest: t } = window as any
    const blank = scene.snapshot(), results = []
    for (const zoom of [.5, 1, 5]) {
      scene.restore(blank)
      t.apply([{ type: 'create_element', id: 'label', elementType: 'rectangle', x: 300 / zoom, y: 250 / zoom,
        props: { width: 100 / zoom, height: 60 / zoom, roughness: 0, strokeWidth: 1 / zoom, strokeColor: '#ff0000', backgroundColor: '#ff0000', fillStyle: 'solid' } }])
      const viewport = { x: 0, y: 0, width: 1200 / zoom, height: 900 / zoom, zoom }
      const submitted = { ...t.captureSubmittedContext(scene), selection: [], viewport }
      const task = new TaskScene(scene.snapshot(), [], { ...viewport, center: { x: viewport.width / 2, y: viewport.height / 2 } })
      try {
        const tool = new CanvasTool(task, {}, () => { throw Error('Read only') }, submitted)
        const scope = { executionId: 'pixels', cwd: '/tmp', signal: new AbortController().signal }
        const message = await prepareCanvasMessage(tool, submitted, 'commit', scope)
        const bitmap = await createImageBitmap(await (await fetch(message.image.dataUrl)).blob())
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
        const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close()
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let red = 0
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 200 && pixels[i + 1] < 50 && pixels[i + 2] < 50) red++
        const exact = await tool.execute('canvas_capture', { region: viewport }, scope)
        const block = exact.content.find((part: any) => part.type === 'image')
        const full = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${block.data}`)).blob())
        context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(full, 0, 0)
        const plain = context.getImageData(0, 0, canvas.width, canvas.height).data
        let exactRed = 0
        for (let i = 0; i < plain.length; i += 4) if (plain[i] > 200 && plain[i + 1] < 50 && plain[i + 2] < 50) exactRed++
        results.push({ zoom, width: canvas.width, height: canvas.height, red, exactRed, full: [full.width, full.height], region: exact.structuredContent.region })
        full.close()
      } finally { task.close() }
    }
    return results
  })
  await info.attach('world-scale-pixels', { body: JSON.stringify(results), contentType: 'application/json' })
  const expectedRedArea = 100 * 60 * (1400 / 1200) ** 2
  for (const result of results) {
    expect(result.width).toBe(1400)
    expect(Math.abs(result.exactRed - expectedRedArea) / expectedRedArea).toBeLessThan(.03)
    // The preview is that same render with the object's number and outline
    // drawn over it, a fixed raster footprint at every world scale.
    expect(result.red).toBeLessThanOrEqual(result.exactRed)
    expect(result.exactRed - result.red).toBeLessThan(700)
    expect(result.full).toEqual([1400, 1050])
    expect(result.region).toMatchObject({ x: 0, y: 0, width: 1200 / result.zoom, height: 900 / result.zoom })
  }
  expect(Math.max(...results.map(r => r.red)) / Math.min(...results.map(r => r.red))).toBeLessThan(1.01)
})

test('the preview keeps late visible objects, empty margins and the submitted boundary', async ({ page }, info) => {
  const result = await page.evaluate(async () => {
    const { CanvasTool } = await import('/canvas/canvasTool.ts' as string)
    const { prepareCanvasMessage } = await import('/canvas/canvasMessage.ts' as string)
    const { scene, engineTest: t } = window as any
    t.apply([
      { type: 'create_element', id: 'brush', elementType: 'freedraw', x: 120, y: 80, rotation: .4,
        props: { points: [[0, 0], [0, 60], [70, 100]], strokeColor: '#000000', strokeWidth: 8, simulatePressure: true, pressures: [] } },
      { type: 'create_element', id: 'arrow', elementType: 'arrow', x: 330, y: 110, props: { points: [[0, 0], [0, 100]], endArrowhead: 'triangle', strokeColor: '#000000', strokeWidth: 5, roughness: 0 } },
      ...Array.from({ length: 12 }, (_, i) => ({ type: 'create_element', id: `dot-${i}`, elementType: 'ellipse', x: 160 + i * 12, y: 250, props: { width: 7, height: 7, backgroundColor: '#000000', fillStyle: 'solid', roughness: 0 } })),
      { type: 'create_element', id: 'late', elementType: 'rectangle', x: 420, y: 220, props: { width: 30, height: 30, backgroundColor: '#00cc66', fillStyle: 'solid', roughness: 0 } },
      { type: 'create_element', id: 'outside', elementType: 'rectangle', x: 610, y: 50, props: { width: 100, height: 100, backgroundColor: '#ff00ff', fillStyle: 'solid', roughness: 0 } },
      { type: 'create_element', id: 'crossing', elementType: 'rectangle', x: -40, y: 140, props: { width: 60, height: 30, backgroundColor: '#2060e0', fillStyle: 'solid', roughness: 0 } }
    ])
    const before = JSON.stringify(scene.snapshot().document)
    const viewport = { x: 0, y: 0, width: 600, height: 400, zoom: 1 }
    const submitted = { ...t.captureSubmittedContext(scene), selection: [], viewport }
    const tool = new CanvasTool(scene, {}, () => { throw Error('Read only') }, submitted)
    const scope = { executionId: 'pixels', cwd: '/tmp', signal: new AbortController().signal }
    const message = await prepareCanvasMessage(tool, submitted, 'commit', scope)
    const decode = async (data: string) => {
      const bitmap = await createImageBitmap(await (await fetch(data)).blob())
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0); bitmap.close()
      return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
    }
    const pixels = (await decode(message.image.dataUrl)).data
    const summary = message.context.evidence.find((item: any) => item.type === 'pixels'), region = summary.region
    // The message carries a summary; canvas_report returns the full ledger record.
    const report = await tool.execute('canvas_report', { revision: message.context.revision, claims: [{ claim: 'The green square is visible.', category: 'appearance', basis: 'pixels', evidenceIds: [summary.id], certainty: 'uncertain' }] }, scope)
    const evidence = JSON.parse(report.content[0].text).evidence[0]
    let green = 0, magenta = 0, ink = 0
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] < 80 && pixels[i + 1] > 140 && pixels[i + 2] < 160) green++
      if (pixels[i] > 180 && pixels[i + 1] < 90 && pixels[i + 2] > 180) magenta++
      if (pixels[i] < 80 && pixels[i + 1] < 80 && pixels[i + 2] < 80) ink++
    }
    return { image: message.image.dataUrl, ink, green, magenta, region, evidence, summary, context: message.context, unchanged: before === JSON.stringify(scene.snapshot().document) }
  })
  expect(result.ink).toBeGreaterThan(2000)
  expect(result.green).toBeGreaterThan(1000)
  expect(result.magenta).toBe(0)
  expect(result.region).toEqual({ x: 0, y: 0, width: 600, height: 400 })
  expect(result.evidence.elementIds).toContain('late')
  expect(result.evidence.elementIds).not.toContain('outside')
  expect(result.summary).not.toHaveProperty('elementIds')
  expect(result.evidence).toMatchObject({ ...result.summary })
  expect(result.context.visible).toMatchObject({ total: 16, truncated: true })
  expect(result.unchanged).toBe(true)
  await info.attach('submitted-viewport.jpg', { body: Buffer.from(result.image.split(',')[1]!, 'base64'), contentType: 'image/jpeg' })
})

test('cooperative evidence export preserves native brush pixels and can be cancelled @serial', async ({ page }) => {
  const { brushStrokes } = await import('../helpers/brush-workload')
  const result = await page.evaluate(async operations => {
    const { scene, engineTest: t } = window as any
    const { cloneCanvasElement } = await import('/canvas/cloneSnapshot.ts' as string)
    const { themeColor } = await import('/design/theme.ts' as string)
    t.apply(operations)
    const snapshot = JSON.stringify(scene.snapshot().document)
    const reference = await t.exportToCanvas({ elements: scene.elements.map(cloneCanvasElement), files: scene.files,
      appState: { ...scene.api.getAppState(), exportBackground: true, viewBackgroundColor: themeColor('background'), exportWithDarkMode: false }, exportPadding: 20,
      getDimensions: (width: number, height: number) => { const scale = 1400 / Math.max(width, height); return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale } } })
    const original = await new Promise<Blob>(resolve => reference.toBlob(resolve, 'image/jpeg', .8))
    const cooperative = await scene.preview([], 'low')
    const a = new Uint8Array(await original.arrayBuffer()), b = new Uint8Array(await cooperative.arrayBuffer())
    const abort = new AbortController(), pending = scene.preview([], 'low', undefined, undefined, undefined, abort.signal)
    setTimeout(() => abort.abort(), 0)
    let cancelled = false
    try { await pending } catch (error) { cancelled = (error as Error).name === 'AbortError' }
    return { identical: a.length === b.length && a.every((v, i) => v === b[i]), cancelled, unchanged: snapshot === JSON.stringify(scene.snapshot().document) }
  }, brushStrokes)
  expect(result).toEqual({ identical: true, cancelled: true, unchanged: true })
})

test('recorded evidence reuses unchanged pixels and follows real edits and camera changes', async ({ page }) => {
  await page.evaluate(async () => {
    const w = window as any, { CanvasRecording } = await import('/recording/CanvasRecording.ts' as string)
    w.engineTest.apply([{ type: 'create_element', id: 'before', elementType: 'rectangle', x: 200, y: 200,
      props: { width: 120, height: 100, roughness: 0, backgroundColor: '#ff0000', fillStyle: 'solid' } }])
    w.scene.api.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } } })
    w.evidenceExports = 0
    const preview = w.scene.preview.bind(w.scene)
    w.scene.preview = (...args: any[]) => { w.evidenceExports++; return preview(...args) }
    w.evidenceRecording = new CanvasRecording(document.querySelector('.excalidraw'), w.scene, 'fixture', () => {})
    await w.evidenceRecording.start(false)
  })
  try {
    await expect.poll(() => page.evaluate(() => (window as any).evidenceRecording.packet.frames.length)).toBeGreaterThanOrEqual(2)
    const first = await page.evaluate(() => {
      const w = window as any, [a, b] = w.evidenceRecording.packet.frames
      return { exports: w.evidenceExports, samePixels: a.dataUrl === b.dataUrl, later: b.t > a.t, distinct: a.id !== b.id, pixels: a.dataUrl }
    })
    expect(first).toMatchObject({ exports: 1, samePixels: true, later: true, distinct: true })
    await page.evaluate(() => (window as any).engineTest.apply([{ type: 'create_element', id: 'after', elementType: 'rectangle', x: 400, y: 200,
      props: { width: 120, height: 100, roughness: 0, backgroundColor: '#00ff00', fillStyle: 'solid' } }]))
    await expect.poll(() => page.evaluate(() => (window as any).evidenceRecording.packet.frames.at(-1).objectIds.includes('after'))).toBe(true)
    const edited = await page.evaluate(() => (window as any).evidenceRecording.packet.frames.at(-1).dataUrl)
    expect(edited).not.toBe(first.pixels)
    await page.evaluate(() => (window as any).scene.api.updateScene({ appState: { scrollX: -120, zoom: { value: 1.5 } } }))
    await expect.poll(() => page.evaluate(() => (window as any).evidenceRecording.packet.frames.at(-1).view.zoom)).toBe(1.5)
    const moved = await page.evaluate(() => (window as any).evidenceRecording.packet.frames.at(-1).dataUrl)
    expect(moved).not.toBe(edited)
  } finally { await page.evaluate(() => (window as any).evidenceRecording.cancel()) }
})
