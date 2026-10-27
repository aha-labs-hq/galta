import { test, expect } from '@playwright/test'

test('background reads expose the submitted selection without claiming to observe current UI selection', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const { CanvasTool } = await import('/canvas/canvasTool.ts' as string)
    const { TaskScene } = await import('/canvas/toolScene.ts' as string)
    const w = window as any, scene = w.scene, t = w.engineTest
    t.apply([{ type: 'create_text', id: 'first', text: 'First', x: 0, y: 0 }, { type: 'create_text', id: 'second', text: 'Second', x: 200, y: 0 }])
    const select = async (id: string) => {
      scene.select([id])
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      if (scene.selectedIds.length !== 1 || scene.selectedIds[0] !== id) throw new Error('UI selection did not settle')
    }
    await select('first')
    const submitted = t.captureSubmittedContext(scene)
    const task = new TaskScene(scene.snapshot(), [...submitted.selection], scene.viewport)
    try {
      await select('second')
      const tool = new CanvasTool(task, {}, () => { throw new Error('Read must not write') }, submitted)
      const reply = await tool.execute('canvas_inspect', {}, { cwd: '/tmp/galta-test', signal: new AbortController().signal })
      const nextSubmission = t.captureSubmittedContext(scene)
      const nextTask = new TaskScene(scene.snapshot(), [...nextSubmission.selection], scene.viewport)
      try {
        const nextTool = new CanvasTool(nextTask, {}, () => { throw new Error('Read must not write') }, nextSubmission)
        const next = await nextTool.execute('canvas_inspect', { scope: 'selection' }, { cwd: '/tmp/galta-test', signal: new AbortController().signal })
        return { live: scene.selectedIds, status: JSON.parse(reply.content[0].text), next: JSON.parse(next.content[0].text) }
      } finally { nextTask.close() }
    } finally { task.close() }
  })
  expect(result.live).toEqual(['second'])
  expect(result.status.selectionCount).toBe(1)
  expect(result.status.elements.filter((el: any) => el.selectedAtSubmission).map((el: any) => el.id)).toEqual(['first'])
  expect(result.status).not.toHaveProperty('liveSelectionCount')
  expect(result.status.elements.every((el: any) => !('selected' in el))).toBe(true)
  // Equal counts and an unchanged document must never reuse the old targets.
  expect(result.next.revision).toBe(result.status.revision)
  expect(result.next.selectionCount).toBe(result.status.selectionCount)
  expect(result.next.elements.map((el: any) => el.id)).toEqual(['second'])
})

test('native selection has no source file requirement and explicit targets remain addressable', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, scene = w.scene
    t.apply([{ type: 'create_text', id: 'selected', text: 'Selected', x: 0, y: 0 }, { type: 'create_text', id: 'explicit', text: 'Explicit target', x: 200, y: 0 }])
    scene.select(['selected'])
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const submitted = t.captureSubmittedContext(scene)
    const tool = t.capturedTool(submitted), scope = { executionId: 'test-execution', cwd: '/tmp/galta-test', signal: new AbortController().signal }
    const call = async (name: string, args: any) => JSON.parse((await tool.execute(name, args, scope)).content[0].text)
    const selected = await call('canvas_extract', { scope: 'selection' })
    await call('canvas_edit', { revision: selected.revision, operations: [{ type: 'move', elementId: 'selected', x: 100, y: 0 }] })
    const explicit = await call('canvas_inspect', { ids: ['explicit'], detail: 'elements' })
    await call('canvas_edit', { revision: explicit.revision, operations: [{ type: 'move', elementId: 'explicit', x: 400, y: 0 }] })
    const after = await call('canvas_inspect', { ids: ['selected', 'explicit'] })
    return { selected, explicit, after }
  })
  expect(result.selected.elements).toHaveLength(1)
  expect(result.selected.elements[0]).toMatchObject({ id: 'selected', selectedAtSubmission: true })
  expect(result.selected.elements[0].file).toBeUndefined()
  expect(result.selected.elements[0].missing).toBeUndefined()
  expect(result.explicit.elements.map((element: any) => element.id)).toEqual(['explicit'])
  expect(result.after.elements.map((element: any) => [element.id, element.x])).toEqual([['selected', 100], ['explicit', 400]])
})

test('paged reads preserve all frozen targets without returning whole collections', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const { CanvasTool } = await import('/canvas/canvasTool.ts' as string)
    const ids = Array.from({ length: 1000 }, (_, i) => `target-${String(i).padStart(6, '0')}`)
    const elements = ids.map((id, i) => ({ id, type: 'text', x: i, y: 0, width: 100, height: 20, angle: 0, groupIds: [], text: '正文'.repeat(500) }))
    const document = { elements: elements.slice(1) }
    const scene = { document, get elements() { return document.elements }, selectedIds: [ids[500]], viewport: { x: 0, y: 0, width: 100, height: 100, zoom: 1 } }
    const submitted = { selection: ids, images: [] }
    const tool = new CanvasTool(scene, {}, () => { throw new Error('Read must not write') }, submitted)
    const call = async (args: any) => JSON.parse((await tool.execute('canvas_inspect', args, { cwd: '/tmp/galta-test', signal: new AbortController().signal })).content[0].text)
    const pages: any[] = [], found: string[] = []
    let offset = 0, revision: string | undefined
    do {
      const page = await call({ scope: 'selection', offset, revision })
      revision = page.revision; pages.push(page)
      found.push(...page.elements.map((el: any) => el.id))
      offset = page.coverage.nextOffset
    } while (offset !== null)
    const first = pages[0], missing = first.elements[0]
    const defaults = await call({}), exact = await call({ ids: [ids[700]], detail: 'elements' })
    const failures: string[] = []
    for (const args of [{ offset: 1 }, { offset: -1 }, { offset: 1001, revision: first.revision }, { limit: 0 }, { limit: 65 }, { scope: 'unknown' }, { scope: 'selection', ids: [ids[1]] }, { scope: 'references' }, { ids: [ids[1], ids[1]] }, { ids: [ids[0]] }]) {
      try { await call(args) } catch (error) { failures.push(String(error)) }
    }
    // Selection changes never retarget a frozen request or invalidate its page.
    scene.selectedIds = []
    const afterReselect = await call({ scope: 'selection', offset: first.coverage.nextOffset, revision: first.revision })
    document.elements = document.elements.slice(1)
    try { await call({ scope: 'selection', offset: first.coverage.nextOffset, revision: first.revision }) } catch (error) { failures.push(String(error)) }
    const serialized = pages.map(page => JSON.stringify(page))
    return { complete: JSON.stringify(found) === JSON.stringify(ids),
      missing, pages: pages.length, firstCoverage: first.coverage, defaultCoverage: defaults.coverage, exactText: exact.elements[0].text,
      maxCharacters: Math.max(...serialized.map(text => text.length)),
      wholeSelectionRepeated: pages.some(page => 'selection' in page || 'liveSelection' in page), afterReselect: afterReselect.selectionCount, failures }
  })
  expect(result.complete).toBe(true)
  expect(result.missing).toEqual({ id: 'target-000000', missing: true })
  expect(result.firstCoverage).toMatchObject({ scope: 'selection', total: 1000, offset: 0 })
  expect(result.firstCoverage.nextOffset).toBeLessThan(32)
  expect(result.defaultCoverage).toMatchObject({ scope: 'canvas', total: 999, offset: 0 })
  expect(result.maxCharacters).toBeLessThan(13_000)
  expect(result.wholeSelectionRepeated).toBe(false)
  expect(result.exactText).toBe('正文'.repeat(500))
  expect(result.afterReselect).toBe(1000)
  expect(result.failures).toHaveLength(11)
  expect(result.failures.at(-1)).toContain('canvas changed')
})

test('paged reads terminate for empty sets and preserve requested order around oversized records', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const { CanvasTool } = await import('/canvas/canvasTool.ts' as string)
    const document = { elements: [] as any[] }
    const scene = { document, get elements() { return document.elements }, selectedIds: [], viewport: { x: 0, y: 0, width: 100, height: 100, zoom: 1 } }
    const tool = new CanvasTool(scene, {}, () => { throw new Error('Read must not write') }, { selection: [], images: [], canvas: {} })
    const call = async (args: any) => JSON.parse((await tool.execute('canvas_inspect', args, { cwd: '/tmp/galta-test', signal: new AbortController().signal })).content[0].text)
    const empty = await Promise.all(['canvas', 'selection'].map(scope => call({ scope })))
    document.elements = Array.from({ length: 64 }, (_, i) => ({ id: `element-${i}`, type: 'text', x: i, y: 0, width: 100, height: 20, angle: 0, groupIds: [], text: '文字'.repeat(250) }))
    const ids = document.elements.map(el => el.id).reverse()
    // One exact record exceeds the page budget. It must remain intact and must
    // not strand either its preceding or following records behind nextOffset.
    const large = document.elements[32]!
    large.text = '完整正文'.repeat(8000)
    let offset = 0, revision: string | undefined
    const found: any[] = [], coverage: any[] = []
    do {
      const page = await call({ ids, detail: 'elements', limit: 64, offset, revision })
      if (!page.coverage.returned || page.coverage.nextOffset !== null && page.coverage.nextOffset <= offset) throw new Error('Pagination did not advance')
      revision ??= page.revision
      if (page.revision !== revision) throw new Error('Read changed the document')
      found.push(...page.elements); coverage.push(page.coverage)
      offset = page.coverage.nextOffset
    } while (offset !== null)
    const terminal = await call({ ids, detail: 'elements', offset: ids.length, revision })
    const summary = await call({ ids: [large.id] })
    let pastEnd: string | undefined
    try { await call({ ids, offset: ids.length + 1, revision }) } catch (error) { pastEnd = String(error) }
    return {
      empty: empty.map(page => ({ coverage: page.coverage, records: page.elements })),
      requested: ids, found: found.map(el => el.id), coverage,
      largeIntact: found.find(el => el.id === large.id)?.text === large.text,
      summary: summary.elements[0], terminal, pastEnd
    }
  })
  for (const { coverage, records } of result.empty) {
    expect(coverage).toMatchObject({ total: 0, offset: 0, returned: 0, nextOffset: null })
    expect(records).toEqual([])
  }
  expect(result.found).toEqual(result.requested)
  expect(result.coverage.length).toBeGreaterThan(1)
  expect(result.coverage.every((page: any) => page.scope === 'ids' && page.total === 64)).toBe(true)
  expect(result.largeIntact).toBe(true)
  expect(result.summary.textTruncated).toBe(true)
  expect(result.summary.text).toBe('完整正文'.repeat(100))
  expect(result.terminal.coverage).toEqual({ scope: 'ids', total: 64, offset: 64, returned: 0, nextOffset: null })
  expect(result.terminal.elements).toEqual([])
  expect(result.pastEnd).toContain('offset exceeds the result count')
})
