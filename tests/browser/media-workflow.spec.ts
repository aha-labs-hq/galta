import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
})

test('media, labels, replacement and layout commit together with reusable artifact reads and one undo', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, s = w.scene
    const c = document.createElement('canvas'); c.width = 200; c.height = 100
    c.getContext('2d')!.fillRect(0, 0, 200, 100)
    const reads: string[] = []
    w.testArtifacts.readImage = async (path: string) => { reads.push(path); return { dataUrl: c.toDataURL() } }
    let saves = 0; w.saveEntered = () => saves++
    const decode = (r: any) => JSON.parse(r.content[0].text)
    const call = (operations: any[]) => t.tool('canvas_edit', { revision: t.revision(), operations }).then(decode)
    const initial = await call([
      { type: 'create_element', elementType: 'image', id: 'a', x: 100, y: 100, props: { mediaPath: '/tmp/one.png', width: 300, groupIds: ['card'] } },
      { type: 'create_element', elementType: 'image', id: 'b', x: 500, y: 100, props: { mediaPath: '/tmp/one.png', height: 150 } },
      { type: 'create_text', id: 'label', text: 'Editable label', x: 100, y: 300, props: { groupIds: ['card'] } },
      { type: 'move', elementId: 'a', scope: 'group', x: 120, y: 140 }
    ])
    const before = structuredClone(s.elements), initialReads = [...reads]
    const update = await call([
      { type: 'update_element', elementId: 'a', props: { mediaPath: '/tmp/two.png' } },
      { type: 'update_element', elementId: 'b', props: { mediaPath: '/tmp/two.png' } },
      { type: 'update_element', elementId: 'label', props: { text: 'Updated label' } }
    ])
    w.__mediaBefore = before
    return { initial, update, before, after: structuredClone(s.elements), saves, initialReads, reads, savedCount: w.saved.document.elements.length }
  })
  expect(result.initialReads).toEqual(['/tmp/one.png'])
  expect(result.reads).toEqual(['/tmp/one.png', '/tmp/two.png'])
  expect(result.saves).toBe(2)
  expect(result.savedCount).toBe(3)
  expect(result.initial.elements.map((el: any) => el.change)).toEqual(['created', 'created', 'created'])
  expect(result.initial.elements[0]).toMatchObject({ id: 'a', x: 120, y: 140, width: 300, height: 150, groupIds: ['card'], generatedPath: '/tmp/one.png' })
  expect(result.update.elements.map((el: any) => el.change)).toEqual(['updated', 'updated', 'updated'])
  for (const i of [0, 1]) {
    expect(result.after[i].fileId).not.toBe(result.before[i].fileId)
    for (const key of ['id', 'x', 'y', 'width', 'height', 'angle', 'groupIds']) expect(result.after[i][key]).toEqual(result.before[i][key])
  }
  await page.locator('.excalidraw').focus()
  await page.keyboard.press('Meta+z')
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements.find((el: any) => el.id === 'label').text)).toBe('Editable label')
  expect(await page.evaluate(() => (window as any).scene.elements.filter((el: any) => el.type === 'image').map((el: any) => el.fileId))).toEqual(result.before.filter((el: any) => el.type === 'image').map((el: any) => el.fileId))
})

test('failed preparation, invalid targets, cancellation and restoration never publish a partial media batch', async ({ page }) => {
  const outcomes = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, s = w.scene
    const c = document.createElement('canvas'); c.width = c.height = 20; c.getContext('2d')!.fillRect(0, 0, 20, 20)
    const original = JSON.stringify(s.snapshot().document), outcomes = []
    let saves = 0; w.saveEntered = () => saves++
    for (const mode of ['decode', 'target', 'stop', 'restore', 'save']) {
      const controller = new AbortController()
      w.testArtifacts.readImage = async (path: string) => {
        if (mode === 'decode' && path.endsWith('two.png')) throw new Error('Unreadable second artifact')
        if (mode === 'stop') controller.abort(new Error('Stopped during media preparation'))
        if (mode === 'restore') s.restore(s.snapshot())
        return { dataUrl: c.toDataURL() }
      }
      w.failSave = mode === 'save'
      const ops: any[] = [
        { type: 'create_element', elementType: 'image', id: 'a', props: { mediaPath: '/tmp/one.png' } },
        { type: 'create_element', elementType: 'image', id: 'b', props: { mediaPath: '/tmp/two.png' } }
      ]
      if (mode === 'target') ops.push({ type: 'update_element', elementId: 'absent', props: { mediaPath: '/tmp/one.png' } })
      let error = ''
      try { await t.tool('canvas_edit', { revision: t.revision(), operations: ops }, { signal: controller.signal }) } catch (e) { error = String(e) }
      outcomes.push({ mode, error, unchanged: JSON.stringify(s.snapshot().document) === original, saves })
    }
    return outcomes
  })
  for (const outcome of outcomes) { expect(outcome.error).toBeTruthy(); expect(outcome.unchanged).toBe(true) }
  expect(outcomes.slice(0, 4).every(outcome => outcome.saves === 0)).toBe(true)
  expect(outcomes.at(-1)!.saves).toBe(1)
})

test('paged source preparation returns target metadata, stable original paths and a fenced revision without a status round trip', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, s = w.scene
    const c = document.createElement('canvas'); c.width = 200; c.height = 100
    const ctx = c.getContext('2d')!; ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 200, 100)
    const original = c.toDataURL(), [id] = await t.import(original, { x: 200, y: 200 })
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const submitted = t.captureSubmittedContext(s)
    submitted.selection.push('deleted-target')
    const tool = t.capturedTool(submitted), scope = { cwd: '/tmp/sources-test', executionId: 'sources', signal: new AbortController().signal }
    const decode = (r: any) => JSON.parse(r.content[0].text)
    const call = (args: any) => tool.execute('canvas_extract', args, scope).then(decode)
    const writes: Record<string, string> = {}
    w.testArtifacts.writeImage = async (path: string, bytes: string) => { writes[path] = bytes }
    const targets = await call({ scope: 'selection', limit: 1 })
    const rest = await call({ scope: 'selection', limit: 1, offset: targets.coverage.nextOffset, revision: targets.revision })
    ctx.fillStyle = 'green'; ctx.fillRect(0, 0, 200, 100)
    w.testArtifacts.readImage = async () => ({ dataUrl: c.toDataURL() })
    const changed = decode(await tool.execute('canvas_edit', { revision: targets.revision, operations: [{ type: 'update_element', elementId: id, props: { mediaPath: '/tmp/green.png' } }] }, scope))
    const again = await call({ scope: 'selection' }), current = await call({ element: id, source: 'current' })
    let conflict = ''
    try { await call({ scope: 'selection', offset: 1, revision: targets.revision }) } catch (e) { conflict = String(e) }
    w.testArtifacts.writeImage = async () => t.apply([{ type: 'move', elementId: id, x: 300, y: 300 }])
    let duringExport = ''
    try { await call({ scope: 'selection' }) } catch (e) { duringExport = String(e) }
    return { targets, rest, changed, again, current, paths: Object.keys(writes), original: writes[targets.elements[0].file.path] === original.split(',')[1], conflict, duringExport }
  })
  expect(result.targets.coverage.nextOffset).toBe(1)
  expect(result.rest.elements).toEqual([{ id: 'deleted-target', missing: true }])
  const path = result.targets.elements[0].file.path
  expect(result.again.elements[0].file.path).toBe(path)
  expect(result.current.path).not.toBe(path)
  expect(result.paths).toHaveLength(2)
  expect(result.original).toBe(true)
  expect(result.current.revision).toBe(result.changed.revision)
  expect(result.conflict).toContain('canvas changed')
  expect(result.duringExport).toContain('canvas changed')
})
