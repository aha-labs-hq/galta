import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
})

test('search finds authored phrases across native soft wraps and preserves explicit line breaks', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engineTest: t, scene } = window as any
    const call = async (tool: string, args: any = {}) => JSON.parse((await t.tool(tool, args)).content[0].text)
    const content = 'A longer editable sentence that wraps inside a narrow card.'
    await call('canvas_edit', { revision: t.revision(), operations: [
      { type: 'create_element', id: 'card', elementType: 'rectangle', x: 100, y: 100, props: { width: 140, height: 200 } },
      { type: 'create_text', id: 'label', x: 150, y: 150, text: content, props: { fontFamily: 2 } },
      { type: 'bind_text', elementId: 'label', containerId: 'card' },
      { type: 'create_text', id: 'multiline', x: 400, y: 100, text: 'Explicit\nline break' }
    ] })
    const label = scene.elements.find((el: any) => el.id === 'label')
    const found = await call('canvas_inspect', { query: content, kind: 'text' })
    const explicit = await call('canvas_inspect', { query: 'Explicit\nline break' })
    const flattened = await call('canvas_inspect', { query: 'Explicit line break' })
    return { content, text: label.text, originalText: label.originalText,
      found: found.elements.map((el: any) => el.id), explicit: explicit.elements.map((el: any) => el.id), flattened: flattened.elements }
  })
  expect(result.text).toContain('\n')
  expect(result.originalText).toBe(result.content)
  expect(result.found).toEqual(['label'])
  expect(result.explicit).toEqual(['multiline'])
  expect(result.flattened).toEqual([])
})

test('find, read, correct a failed patch and confirm a native edit using returned identities', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engineTest: t, scene } = window as any
    const call = async (tool: string, args: any = {}) => JSON.parse((await t.tool(tool, args)).content[0].text)
    const initial = await call('canvas_inspect')
    const created = await call('canvas_edit', { revision: initial.revision, operations: [
      { type: 'create_text', id: 'heading', text: 'Summer exhibition', x: 100, y: 100, props: { groupIds: ['card', 'board'] } },
      { type: 'create_text', id: 'body', text: 'Body text', x: 100, y: 150, props: { groupIds: ['card', 'board'] } },
      { type: 'create_text', id: 'unrelated', text: 'Other work', x: 500, y: 100 },
      { type: 'create_element', id: 'section', elementType: 'frame', x: 800, y: 800, props: { name: 'Reference Library', width: 200, height: 200 } }
    ] })
    const found = await call('canvas_inspect', { query: 'SUMMER', kind: 'text' })
    const target = found.elements[0]
    const details = await call('canvas_inspect', { ids: [target.id], detail: 'elements' })
    const frame = await call('canvas_inspect', { query: 'library', kind: 'frame' })
    const group = await call('canvas_inspect', { groupId: target.groupIds[0] })
    const before = JSON.stringify(scene.snapshot().document)
    let invalid = '', missing = ''
    try {
      await call('canvas_edit', { revision: found.revision, operations: [
        { type: 'move', elementId: 'unrelated', x: 900, y: 900 },
        { type: 'update_element', id: target.id, props: { text: 'Changed' } }
      ] })
    } catch (error) { invalid = String(error) }
    const invalidAtomic = before === JSON.stringify(scene.snapshot().document)
    try {
      await call('canvas_edit', { revision: found.revision, operations: [
        { type: 'move', elementId: 'unrelated', x: 900, y: 900 },
        { type: 'delete', elementId: 'not-on-this-canvas' }
      ] })
    } catch (error) { missing = String(error) }
    const missingAtomic = before === JSON.stringify(scene.snapshot().document)
    const saved = await call('canvas_edit', { revision: found.revision, operations: [
      { type: 'update_element', elementId: target.id, props: { text: 'Autumn exhibition' } },
      { type: 'move', elementId: target.id, scope: 'group', x: 150, y: 200 }
    ] })
    const after = await call('canvas_inspect', { ids: ['heading', 'body', 'unrelated'] })
    return { created: created.elements.length, found: found.elements.map((el: any) => el.id), details: details.elements[0], frame: frame.elements[0],
      group: group.elements.map((el: any) => el.id), invalid, invalidAtomic, missing, missingAtomic, saved, after }
  })
  expect(result.created).toBe(4)
  expect(result.found).toEqual(['heading'])
  expect(result.details.text).toBe('Summer exhibition')
  expect(result.frame).toMatchObject({ id: 'section', name: 'Reference Library' })
  expect(result.group).toEqual(['heading', 'body'])
  expect(result.invalid).toContain('operations[1] (update_element): Missing elementId')
  expect(result.missing).toContain('operations[1].elementId: Canvas object not-on-this-canvas no longer exists')
  expect(result.invalidAtomic && result.missingAtomic).toBe(true)
  expect(result.saved.elements.map((el: any) => el.id)).toEqual(['heading', 'body'])
  expect(result.saved.elements.every((el: any) => el.change === 'updated')).toBe(true)
  expect(result.after.revision).toBe(result.saved.revision)
  expect(result.after.elements).toMatchObject([
    { id: 'heading', text: 'Autumn exhibition', x: 150, y: 200, groupIds: ['card', 'board'] },
    { id: 'body', x: 150, y: 250 }, { id: 'unrelated', x: 500, y: 100 }
  ])
})

test('continuations preserve the query and revision, search full content and keep export source intent', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { CanvasTool } = await import('/canvas/canvasTool.ts' as string)
    const document = { elements: Array.from({ length: 90 }, (_, i) => {
      const text = 'prefix '.repeat(70) + (i % 2 ? 'Needle literal.*' : 'Other')
      return { id: `item-${i}`, type: 'text', x: i, y: 0, width: 100, height: 20, angle: 0, groupIds: ['inner', 'outer'], text, originalText: text }
    }) }
    const scene = { document, get elements() { return document.elements }, selectedIds: ['item-0'], viewport: { x: 0, y: 0, width: 100, height: 100, zoom: 1 } }
    const tool = new CanvasTool(scene, {}, () => { throw new Error('Read must not write') })
    const call = async (name: string, args: any) => JSON.parse((await tool.execute(name, args, { cwd: '/tmp/galta-test', signal: new AbortController().signal })).content[0].text)
    const request = { query: 'NEEDLE literal.*', kind: 'text', groupId: 'outer', limit: 7, detail: 'elements' }
    const first = await call('canvas_inspect', request)
    let current = first
    const ids = current.elements.map((el: any) => el.id)
    const continuations = []
    while (current.next) {
      continuations.push(current.next)
      current = await call('canvas_inspect', current.next)
      ids.push(...current.elements.map((el: any) => el.id))
    }
    const noMatches = await call('canvas_inspect', { query: 'absent' })
    const failures: string[] = []
    for (const args of [{ scope: 'selection', query: 'Needle' }, { scope: 'viewport', kind: 'text' }, { ids: ['item-0'], query: 'Other' }, { query: '' }, { kind: 'rectangle' }, { groupId: '' }, { limit: 100 }]) {
      try { await call('canvas_inspect', args) } catch (error) { failures.push(String(error)) }
    }
    const exported = await call('canvas_extract', { ids: ['item-0', 'item-1'], source: 'current', limit: 1 })
    const exportedLast = await call('canvas_extract', exported.next)
    document.elements[0]!.text = 'Changed after first page'
    try { await call('canvas_inspect', first.next) } catch (error) { failures.push(String(error)) }
    return { ids, continuations, request, first, last: current, noMatches, exported, exportedLast, failures }
  })
  expect(result.ids).toEqual(Array.from({ length: 45 }, (_, i) => `item-${i * 2 + 1}`))
  expect(result.first.coverage.total).toBe(45)
  expect(result.first.elementCount).toBe(90)
  expect(result.last.next).toBeNull()
  expect(result.last.coverage.nextOffset).toBeNull()
  for (const next of result.continuations) expect(next).toMatchObject({ ...result.request, revision: result.first.revision })
  expect(result.noMatches.elements).toEqual([])
  expect(result.noMatches.next).toBeNull()
  expect(result.exported.next).toEqual({ ids: ['item-0', 'item-1'], source: 'current', limit: 1, offset: 1, revision: result.exported.revision })
  expect(result.exportedLast.elements.map((el: any) => el.id)).toEqual(['item-1'])
  expect(result.exportedLast.next).toBeNull()
  expect(result.failures).toHaveLength(8)
  expect(result.failures.at(-1)).toContain('canvas changed')
})
