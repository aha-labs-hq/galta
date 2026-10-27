import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('imported image formats retain their exact original bytes when extracted', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const encoded = await Promise.all([
    ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/avif', 'avif'], ['image/bmp', 'bmp'], ['image/x-icon', 'ico']
  ].map(async ([mimeType, extension]) => ({ mimeType: mimeType!, extension: extension!, data: (await readFile(`tests/fixtures/source-image.${extension}`)).toString('base64') })))
  const result = await page.evaluate(async encoded => {
    const w = window as any, t = w.engineTest, scene = w.scene
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#2463ae"/></svg>'
    const fixtures = [
      { mimeType: 'image/gif', extension: 'gif', data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' },
      { mimeType: 'image/svg+xml', extension: 'svg', data: btoa(svg) },
      ...encoded
    ]
    const writes: Array<{ path: string; data: string; mimeType: string }> = []
    w.testArtifacts.writeArtifact = async (path: string, data: string, mimeType: string) => { writes.push({ path, data, mimeType }) }
    const outputs = []
    for (const fixture of fixtures) {
      const [id] = await t.import(`data:${fixture.mimeType};base64,${fixture.data}`, { x: 200, y: 200 })
      const tool = t.capturedTool(t.captureSubmittedContext(scene))
      scene.select([])
      const before = JSON.stringify(scene.snapshot().document)
      const output = await tool.execute('canvas_extract', { element: id }, { executionId: 'test', cwd: '/tmp/galta-test', signal: new AbortController().signal })
      const written = writes.at(-1)!
      outputs.push({ mimeType: output.structuredContent.mimeType, exact: written.data === fixture.data, extension: written.path.endsWith(`.${fixture.extension}`), unchanged: JSON.stringify(scene.snapshot().document) === before })
    }
    return outputs
  }, encoded)
  expect(result).toEqual([
    { mimeType: 'image/gif', exact: true, extension: true, unchanged: true },
    { mimeType: 'image/svg+xml', exact: true, extension: true, unchanged: true },
    ...encoded.map(({ mimeType }) => ({ mimeType, exact: true, extension: true, unchanged: true }))
  ])
})

test('an explicitly named unselected image extracts without claiming a captured selection source', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, scene = w.scene
    const c = document.createElement('canvas'); c.width = 80; c.height = 50
    c.getContext('2d')!.fillRect(0, 0, 80, 50)
    const original = c.toDataURL(), [id] = await t.import(original, { x: 200, y: 200 })
    scene.select([])
    const submitted = t.captureSubmittedContext(scene)
    const tool = t.capturedTool(submitted), writes: string[] = []
    w.testArtifacts.writeImage = async (_path: string, bytes: string) => { writes.push(bytes) }
    const scope = { executionId: 'test', cwd: '/tmp/galta-test', signal: new AbortController().signal }
    let error = ''
    try { await tool.execute('canvas_extract', { element: id, source: 'submitted' }, scope) }
    catch (value) { error = String(value) }
    const writesAfterRejection = writes.length
    const result = await tool.execute('canvas_extract', { element: id }, scope)
    return { id, error, writesAfterRejection, meta: result.structuredContent, exact: writes[0] === original.split(',')[1] }
  })
  expect(result.error).toContain(result.id)
  expect(result.error).toContain('source: "current"')
  expect(result.writesAfterRejection).toBe(0)
  expect(result.meta).toMatchObject({ elementId: result.id, source: 'element' })
  expect(result.exact).toBe(true)
})

test('submitted edit targets retain original pixels while canvas reads inspect replacements', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const w = window as any, s = w.scene, t = w.engineTest
    const c = document.createElement('canvas'); c.width = 160; c.height = 240
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#e03131'; ctx.fillRect(0, 0, c.width, c.height); const original = c.toDataURL()
    const [id] = await t.import(original, { x: 350, y: 320 })
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const submitted = t.captureSubmittedContext(s)
    ctx.fillStyle = '#2f9e44'; ctx.fillRect(0, 0, c.width, c.height); const replacement = c.toDataURL()
    const writes: string[] = []
    w.testArtifacts.readImage = async () => ({ dataUrl: replacement })
    w.testArtifacts.writeImage = async (_path: string, dataBase64: string) => { writes.push(dataBase64) }
    const tool = t.capturedTool(submitted), scope = { executionId: 'test-execution', cwd: '/tmp/galta-test', signal: new AbortController().signal }
    await tool.execute('canvas_place', { revision: t.revision(), path: '/tmp/galta-test/green.png', replace: id }, scope)
    t.apply([{ type: 'move', elementId: id, x: 650, y: 400 }]); s.select([])
    const exportImage = (args: any) => tool.execute('canvas_extract', { ...args }, scope)
    const frozen = await exportImage({ element: id }), current = await tool.execute('canvas_inspect', { detail: 'elements' }, scope)
    const currentState = JSON.parse(current.content[0].text)
    // Pixels come from canvas_capture, not from the manifest, so the render path
    // is exercised exactly as the model would use it.
    const viewed = await tool.execute('canvas_capture', { element: id }, scope)
    const bitmap = await createImageBitmap(await (await fetch(`data:${viewed.content[0].mimeType};base64,${viewed.content[0].data}`)).blob())
    const preview = document.createElement('canvas'); preview.width = bitmap.width; preview.height = bitmap.height
    const pixels = preview.getContext('2d')!; pixels.drawImage(bitmap, 0, 0); bitmap.close()
    const currentPixel = [...pixels.getImageData(preview.width / 2, preview.height / 2, 1, 1).data].slice(0, 3)
    t.apply([{ type: 'delete', elementId: id }])
    // A submitted target keeps its captured bytes even after the live element
    // is gone, because the export reads the snapshot taken at submission.
    const removed = await exportImage({ element: id })
    const failures: string[] = []
    try { await exportImage({ element: 'never-existed' }) } catch (error) { failures.push(String(error)) }
    try { await tool.execute('canvas_place', { revision: t.revision(), path: '/tmp/galta-test/green.png', replace: id }, scope) } catch (error) { failures.push(String(error)) }
    return {
      original: writes[0] === original.split(',')[1],
      currentPixel, currentPosition: currentState.elements.map((el: any) => [el.x, el.y]), currentRevision: currentState.revision,
      removed: writes[1] === original.split(',')[1],
      sources: [frozen, removed].map(result => JSON.parse(result.content[0].text).source),
      writes: writes.map(bytes => bytes === original.split(',')[1] ? 'original' : bytes === replacement.split(',')[1] ? 'replacement' : 'unexpected'),
      remaining: s.elements.length, failures
    }
  })
  expect(result).toMatchObject({ original: true, removed: true, sources: ['submitted', 'submitted'], writes: ['original', 'original'], currentPosition: [[650, 400]], remaining: 0 })
  result.currentPixel.forEach((value: number, i: number) => expect(Math.abs(value - [47, 158, 68][i]!)).toBeLessThanOrEqual(3))
  expect(result.currentRevision).toBeTruthy()
  expect(result.failures).toHaveLength(2)
  expect(result.failures[0]).toContain('no extractable source')
  expect(result.failures[1]).toContain('no longer exists')
})

test('submitted exports keep their captured pixels while a concurrent canvas edit does not disturb them', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const w = window as any, s = w.scene, t = w.engineTest
    const c = document.createElement('canvas'); c.width = 100; c.height = 150
    c.getContext('2d')!.fillRect(0, 0, c.width, c.height)
    const data = c.toDataURL(), [id] = await t.import(data, { x: 300, y: 300 })
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const submitted = t.captureSubmittedContext(s)
    const tool = t.capturedTool(submitted)
    const written: string[] = []
    const outcomes: any[] = []
    for (const mode of ['submitted', 'current', 'stop']) {
      let release!: () => void, started!: () => void
      const gate = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { started = resolve })
      w.testArtifacts.writeImage = async (_path: string, dataBase64: string) => {
        started(); await gate; written.push(dataBase64)
      }
      const abort = new AbortController()
      const scope = { executionId: 'test-execution', cwd: '/tmp/galta-test', signal: abort.signal }
      // The submitted copy is frozen at request time; the current element is
      // the only one that can race a later edit.
      const args = { element: id }
      const call = () => (mode === 'current' ? t.tool('canvas_extract', args, scope) : tool.execute('canvas_extract', args, scope))
      const pending = call().then(
        (result: any) => ({ meta: JSON.parse(result.content[0].text) }),
        (error: unknown) => ({ error: String(error) })
      )
      await entered
      if (mode === 'stop') abort.abort(new Error('Stopped by acceptance'))
      else t.apply([{ type: 'move', elementId: id, x: mode === 'submitted' ? 400 : 600, y: 400 }])
      const afterEdit = JSON.stringify(s.snapshot().document)
      release()
      const outcome = await pending
      outcomes.push({ ...outcome, preserved: JSON.stringify(s.snapshot().document) === afterEdit })
    }
    return { outcomes, original: data, written }
  })
  expect(result.outcomes[0]).toMatchObject({ meta: { source: 'submitted' }, preserved: true })
  expect(result.outcomes[0].meta).not.toHaveProperty('revision')
  expect(result.outcomes[1]).toMatchObject({ error: expect.stringContaining('canvas changed'), preserved: true })
  expect(result.outcomes[2]).toMatchObject({ error: expect.stringContaining('Stopped by acceptance'), preserved: true })
  expect(result.written[0]).toBe(result.original.split(',')[1])
})
