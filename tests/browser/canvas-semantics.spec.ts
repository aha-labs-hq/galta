import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.GALTA_SEMANTICS_URL ?? '/dev/scene-test.html', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean((window as any).engineTest) || Boolean(document.querySelector('.canvas-notice')))
  await expect(page.locator('.canvas-notice')).toHaveCount(0)
})

test('native text and endpoint bindings survive edits, movement, persistence and deletion atomically', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, s = w.scene
    const decode = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text)
    const call = async (ops: any[]) => decode(await t.tool('canvas_edit', { revision: t.revision(), operations: ops }))
    await call([
      { type: 'create_element', id: 'source', elementType: 'rectangle', x: 80, y: 100, props: { width: 240, height: 180, backgroundColor: '#fff3bf', fillStyle: 'solid', roughness: 0, groupIds: ['source-card'] } },
      { type: 'create_text', id: 'caption', x: 100, y: 300, text: 'Source note', props: { groupIds: ['source-card'], fontFamily: 2 } },
      { type: 'create_text', id: 'body', x: 100, y: 130, text: 'Editable source text', props: { fontFamily: 2 } },
      { type: 'bind_text', elementId: 'body', containerId: 'source' },
      { type: 'create_element', id: 'target', elementType: 'ellipse', x: 580, y: 100, props: { width: 220, height: 180, roughness: 0, backgroundColor: '#d0ebff', fillStyle: 'solid' } },
      { type: 'create_element', id: 'edge', elementType: 'arrow', x: 325, y: 190, props: { points: [[0, 0], [250, 0]], width: 250, height: 0 } },
      { type: 'bind_arrow', elementId: 'edge', start: 'source', end: 'target' }
    ])
    const original = structuredClone(s.elements)
    const by = (id: string) => s.elements.find((el: any) => el.id === id)
    const before = JSON.stringify(s.snapshot().document)
    let invalid = ''
    try { await call([{ type: 'move', elementId: 'source', x: 100, y: 200 }, { type: 'bind_arrow', elementId: 'edge', end: 'missing' }]) } catch (e) { invalid = String(e) }
    const atomic = before === JSON.stringify(s.snapshot().document)
    const moved = await call([{ type: 'move', elementId: 'source', scope: 'group', x: 180, y: 160 }])
    const translation = ['source', 'caption', 'body'].map(id => ({ id, dx: by(id).x - original.find((el: any) => el.id === id).x, dy: by(id).y - original.find((el: any) => el.id === id).y }))
    const edgeMoved = JSON.stringify(by('edge').points) !== JSON.stringify(original.find((el: any) => el.id === 'edge').points) || by('edge').x !== original.find((el: any) => el.id === 'edge').x
    await call([{ type: 'update_element', elementId: 'source', rotation: .3, props: { width: 280 } }, { type: 'update_element', elementId: 'body', props: { text: 'Revised source text, with native wrapping and a longer explanation.' } }])
    const text = structuredClone(by('body')), arrow = structuredClone(by('edge'))
    const saved = s.snapshot(); s.restore(saved)
    const restored = by('body').containerId === 'source' && by('edge').startBinding.elementId === 'source'
    await call([{ type: 'delete', elementId: 'source' }])
    return { atomic, invalid, translation, edgeMoved, text, arrow, restored, deleted: { body: by('body').containerId, start: by('edge').startBinding, end: by('edge').endBinding }, changed: moved.elements.map((el: any) => el.id) }
  })
  expect(result.atomic).toBe(true)
  expect(result.invalid).toContain('Invalid arrow binding target')
  for (const el of result.translation) { expect(el.dx).toBeCloseTo(100); expect(el.dy).toBeCloseTo(60) }
  expect(result.edgeMoved).toBe(true)
  expect(result.text.originalText).toContain('native wrapping')
  expect(result.text.angle).toBeCloseTo(.3)
  expect(result.arrow.startBinding.elementId).toBe('source')
  expect(result.arrow.endBinding.elementId).toBe('target')
  expect(result.restored).toBe(true)
  expect(result.deleted.body).toBe(null)
  expect(result.deleted.start).toBe(null)
  expect(result.deleted.end.elementId).toBe('target')
  expect(result.changed.sort()).toEqual(['body', 'caption', 'edge', 'source'])
})

test('editable composition groups remain observable through writes, summary reads and restoration', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, s = w.scene
    const decode = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text)
    const call = async (operations: any[]) => decode(await t.tool('canvas_edit', { revision: t.revision(), operations }))
    const status = async (args = {}) => decode(await t.tool('canvas_inspect', args))
    const groups = (reply: any) => Object.fromEntries(reply.elements.map((el: any) => [el.id, el.groupIds ?? null]))
    await call([{ type: 'create_text', id: 'existing', x: 900, y: 100, text: 'Existing work' }])
    const existing = JSON.stringify(s.elements.find((el: any) => el.id === 'existing'))
    const created = await call([
      { type: 'create_text', id: 'title', x: 100, y: 100, text: 'Exploration', props: { groupIds: ['board'] } },
      { type: 'create_text', id: 'a-title', x: 100, y: 200, text: 'First direction', props: { groupIds: ['a', 'board'] } },
      { type: 'create_text', id: 'a-body', x: 100, y: 250, text: 'First idea', props: { groupIds: ['a', 'board'] } },
      { type: 'create_text', id: 'b-title', x: 450, y: 200, text: 'Second direction', props: { groupIds: ['b', 'board'] } },
      { type: 'create_text', id: 'b-body', x: 450, y: 250, text: 'Second idea', props: { groupIds: ['b', 'board'] } },
      { type: 'create_text', id: 'loose', x: 900, y: 300, text: 'Independent note in the same batch' }
    ])
    const summary = await status()
    const edited = await call([{ type: 'update_element', elementId: 'a-body', props: { text: 'Revised idea' } }])
    s.restore(structuredClone(w.saved))
    const restored = await status()
    const ungrouped = await call([
      { type: 'update_element', elementId: 'a-title', props: { groupIds: [] } },
      { type: 'update_element', elementId: 'a-body', props: { groupIds: [] } }
    ])
    const afterUngroup = await status()
    const exact = await status({ ids: ['a-title', 'a-body'], detail: 'elements' })
    const moved = await call([{ type: 'move', elementId: 'b-title', scope: 'group', x: 500, y: 240 }])
    return {
      created: groups(created), summary: groups(summary), edited: edited.elements,
      restored: groups(restored), restoredText: restored.elements.find((el: any) => el.id === 'a-body').text,
      ungrouped: groups(ungrouped), afterUngroup: groups(afterUngroup), exact: groups(exact),
      moved: moved.elements.map((el: any) => ({ id: el.id, x: el.x, y: el.y, groupIds: el.groupIds })),
      existingUnchanged: existing === JSON.stringify(s.elements.find((el: any) => el.id === 'existing'))
    }
  })
  const created = { title: ['board'], 'a-title': ['a', 'board'], 'a-body': ['a', 'board'], 'b-title': ['b', 'board'], 'b-body': ['b', 'board'], loose: null }
  expect(result.created).toEqual(created)
  expect(result.summary).toEqual({ existing: null, ...created })
  expect(result.edited).toHaveLength(1)
  expect(result.edited[0]).toMatchObject({ id: 'a-body', text: 'Revised idea', groupIds: ['a', 'board'] })
  expect(result.restored).toEqual(result.summary)
  expect(result.restoredText).toBe('Revised idea')
  expect(result.ungrouped).toEqual({ 'a-title': null, 'a-body': null })
  expect(result.afterUngroup).toEqual({ ...result.summary, 'a-title': null, 'a-body': null })
  expect(result.exact).toEqual({ 'a-title': [], 'a-body': [] })
  expect(result.moved).toEqual([
    { id: 'title', x: 150, y: 140, groupIds: ['board'] },
    { id: 'b-title', x: 500, y: 240, groupIds: ['b', 'board'] },
    { id: 'b-body', x: 500, y: 290, groupIds: ['b', 'board'] }
  ])
  expect(result.existingUnchanged).toBe(true)
})

test('region previews show the composition while related and exact scopes remain explicit', async ({ page }, info) => {
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest
    const decode = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text)
    await t.tool('canvas_edit', { revision: t.revision(), operations: [
      { type: 'create_element', id: 'wall', elementType: 'rectangle', x: -2000, y: -2000, props: { width: 10000, height: 10000, backgroundColor: '#ffffff', fillStyle: 'solid', roughness: 0 } },
      { type: 'create_element', id: 'paper', elementType: 'rectangle', x: 100, y: 100, props: { width: 300, height: 180, backgroundColor: '#fff3bf', fillStyle: 'solid', roughness: 0, groupIds: ['card'] } },
      { type: 'create_text', id: 'words', x: 120, y: 140, text: 'Visible native text', props: { strokeColor: '#111111', fontFamily: 2, fontSize: 24, groupIds: ['card'] } },
      { type: 'create_element', id: 'outside', elementType: 'rectangle', x: 900, y: 100, props: { width: 300, height: 180, backgroundColor: '#ff00ff', fillStyle: 'solid' } }
    ] })
    const region = await t.tool('canvas_capture', { region: { x: 90, y: 90, width: 320, height: 200 }, detail: 'high' })
    const exact = decode(await t.tool('canvas_capture', { element: 'paper', include: 'exact' }))
    const related = decode(await t.tool('canvas_capture', { element: 'paper' }))
    const block = region.content.find((c: any) => c.type === 'image')
    const url = `data:${block.mimeType};base64,${block.data}`
    const image = new Image(); image.src = url; await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 400
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(45, 90, 530, 75).data
    let dark = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 90 && pixels[i + 1] < 90 && pixels[i + 2] < 90) dark++
    return { region: decode(region), exact, related, width: image.width, height: image.height, dark, url }
  })
  expect(result.width).toBe(2800)
  expect(result.height).toBe(1750)
  expect(result.region.elementIds.sort()).toEqual(['paper', 'wall', 'words'])
  expect(result.exact.elementIds).toEqual(['paper'])
  expect(result.related.elementIds.sort()).toEqual(['paper', 'words'])
  expect(result.dark).toBeGreaterThan(300)
  await info.attach('region-preview.jpg', { body: Buffer.from(result.url.split(',')[1], 'base64'), contentType: 'image/jpeg' })
  await info.attach('region-preview.json', { body: JSON.stringify({ ...result, url: undefined }), contentType: 'application/json' })
})

test('image placement sets geometry once and rejects concurrent changes during decoding', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, s = w.scene
    const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100
    const context = canvas.getContext('2d')!; context.fillStyle = '#008866'; context.fillRect(0, 0, 200, 100)
    w.testArtifacts.readImage = async () => ({ dataUrl: canvas.toDataURL() })
    const decode = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text)
    const first = decode(await t.tool('canvas_place', { revision: t.revision(), path: '/tmp/image.png', x: -80, y: 90, width: 420, rotation: .12 }))
    const second = decode(await t.tool('canvas_place', { revision: first.revision, path: '/tmp/second.png', x: 480, y: 90, height: 100 }))
    let release: () => void = () => {}
    let entered!: () => void
    const reading = new Promise<void>(resolve => { entered = resolve })
    w.testArtifacts.readImage = () => new Promise(resolve => { release = () => resolve({ dataUrl: canvas.toDataURL() }); entered() })
    const pending = t.tool('canvas_place', { revision: second.revision, path: '/tmp/third.png' }).then(() => 'unexpected success', (e: Error) => String(e))
    await reading
    t.apply([{ type: 'create_text', x: 50, y: 500, text: 'Concurrent user content' }])
    release()
    const error = await pending
    return { first, second, error, images: s.elements.filter((e: any) => e.type === 'image').length, text: s.elements.some((e: any) => e.text === 'Concurrent user content') }
  })
  expect(result.first.element).toMatchObject({ x: -80, y: 90, width: 420, height: 210, rotation: .12 })
  expect(result.second.element).toMatchObject({ x: 480, y: 90, width: 200, height: 100 })
  expect(result.error).toContain('canvas changed')
  expect(result.images).toBe(2)
  expect(result.text).toBe(true)
})

test('native pointer movement and undo retain the same grouped card and bound arrow', async ({ page }, info) => {
  const original = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, s = w.scene
    await t.tool('canvas_edit', { revision: t.revision(), operations: [
      { type: 'create_element', id: 'card', elementType: 'rectangle', x: 100, y: 180, props: { width: 240, height: 160, backgroundColor: '#fff3bf', fillStyle: 'solid', groupIds: ['card-unit'] } },
      { type: 'create_text', id: 'label', x: 120, y: 230, text: 'Move this card', props: { groupIds: ['card-unit'], fontFamily: 2 } },
      { type: 'create_element', id: 'destination', elementType: 'rectangle', x: 600, y: 180, props: { width: 200, height: 160 } },
      { type: 'create_element', id: 'connector', elementType: 'arrow', x: 345, y: 260, props: { width: 250, height: 0, points: [[0, 0], [250, 0]] } },
      { type: 'bind_arrow', elementId: 'connector', start: 'card', end: 'destination' }
    ] })
    s.api.updateScene({ appState: { zoom: { value: 1 }, scrollX: 0, scrollY: 0, selectedElementIds: {} } })
    return structuredClone(s.elements)
  })
  await page.keyboard.press('v')
  await page.mouse.move(155, 305)
  await page.mouse.down()
  await page.mouse.move(260, 395, { steps: 12 })
  await page.mouse.up()
  const moved = await page.evaluate(() => structuredClone((window as any).scene.elements))
  const get = (elements: any[], id: string) => elements.find(el => el.id === id)
  const dx = get(moved, 'card').x - get(original, 'card').x
  const dy = get(moved, 'card').y - get(original, 'card').y
  expect(Math.abs(dx)).toBeGreaterThan(70)
  expect(get(moved, 'label').x - get(original, 'label').x).toBeCloseTo(dx)
  expect(get(moved, 'label').y - get(original, 'label').y).toBeCloseTo(dy)
  expect(get(moved, 'connector').startBinding.elementId).toBe('card')
  expect(JSON.stringify(get(moved, 'connector').points)).not.toBe(JSON.stringify(get(original, 'connector').points))
  await page.keyboard.press('Meta+z')
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements.find((el: any) => el.id === 'card').x)).toBe(get(original, 'card').x)
  await page.screenshot({ path: info.outputPath('native-group-and-bindings.png') })
})

test('rebinding, detaching and nested groups keep native relationships consistent', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, s = w.scene
    const call = (operations: any[]) => t.tool('canvas_edit', { revision: t.revision(), operations })
    const by = (id: string) => s.elements.find((el: any) => el.id === id)
    await call([
      { type: 'create_element', id: 'a', elementType: 'rectangle', x: 100, y: 100, props: { groupIds: ['inner', 'outer'] } },
      { type: 'create_text', id: 'label', text: 'Native label', x: 100, y: 120, props: { fontFamily: 2 } },
      { type: 'bind_text', elementId: 'label', containerId: 'a' },
      { type: 'create_element', id: 'b', elementType: 'rectangle', x: 500, y: 100, props: { groupIds: ['inner', 'outer'] } },
      { type: 'create_element', id: 'edge', elementType: 'arrow', x: 300, y: 170, props: { width: 200, height: 0, points: [[0, 0], [200, 0]] } },
      { type: 'bind_arrow', elementId: 'edge', start: 'a', end: 'b' }
    ])
    const labelBefore = JSON.stringify(by('label'))
    await call([{ type: 'update_element', elementId: 'a', props: { backgroundColor: '#fff3bf' } }])
    const stylePreservedText = labelBefore === JSON.stringify(by('label'))
    const before = JSON.stringify(s.snapshot().document)
    let nestingError = ''
    try { await call([{ type: 'update_element', elementId: 'a', props: { groupIds: ['inner'] } }]) } catch (e) { nestingError = String(e) }
    const atomic = before === JSON.stringify(s.snapshot().document)
    await call([
      { type: 'update_element', elementId: 'a', props: { groupIds: ['inner'] } },
      { type: 'update_element', elementId: 'b', props: { groupIds: ['inner'] } },
      { type: 'bind_arrow', elementId: 'edge', start: 'b' }
    ])
    const rebound = { a: by('a').boundElements, b: by('b').boundElements, start: by('edge').startBinding.elementId, end: by('edge').endBinding.elementId }
    await call([{ type: 'bind_arrow', elementId: 'edge', start: null }])
    const retained = by('b').boundElements.some((binding: any) => binding.id === 'edge')
    await call([{ type: 'bind_arrow', elementId: 'edge', end: null }, { type: 'bind_text', elementId: 'label', containerId: null }])
    return { stylePreservedText, nestingError, atomic, rebound, retained, detached: !by('b').boundElements.length && !by('a').boundElements.length && by('label').containerId === null }
  })
  expect(result.stylePreservedText).toBe(true)
  expect(result.nestingError).toContain('inconsistent nesting')
  expect(result.atomic).toBe(true)
  expect(result.rebound.a).toEqual([{ id: 'label', type: 'text' }])
  expect(result.rebound.b).toEqual([{ id: 'edge', type: 'arrow' }])
  expect(result.rebound.start).toBe('b')
  expect(result.rebound.end).toBe('b')
  expect(result.retained).toBe(true)
  expect(result.detached).toBe(true)
})

test('detaching wrapped text restores its editable content and rejects invalid connector targets', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, s = w.scene
    const call = (operations: any[]) => t.tool('canvas_edit', { revision: t.revision(), operations })
    const content = 'A longer editable sentence that wraps inside a narrow card.'
    await call([
      { type: 'create_element', id: 'card', elementType: 'rectangle', x: 100, y: 100, props: { width: 140, height: 200 } },
      { type: 'create_text', id: 'label', x: 150, y: 150, text: content, props: { fontFamily: 2 } },
      { type: 'bind_text', elementId: 'label', containerId: 'card' }
    ])
    const wrapped = s.elements.find((e: any) => e.id === 'label').text
    await call([{ type: 'bind_text', elementId: 'label', containerId: null }])
    const detached = structuredClone(s.elements.find((e: any) => e.id === 'label'))
    await call([
      { type: 'create_element', id: 'edge', elementType: 'arrow', x: 400, y: 200, props: { points: [[0, 0], [200, 0]] } },
      { type: 'bind_arrow', elementId: 'edge', start: 'label' }
    ])
    const before = JSON.stringify(s.snapshot().document)
    let error = ''
    try { await call([{ type: 'bind_text', elementId: 'label', containerId: 'card' }]) } catch (e) { error = String(e) }
    return { content, wrapped, detached, error, atomic: before === JSON.stringify(s.snapshot().document) }
  })
  expect(result.wrapped).toContain('\n')
  expect(result.detached.text).toBe(result.content)
  expect(result.detached.originalText).toBe(result.content)
  expect(result.detached.containerId).toBeNull()
  expect(result.error).toContain('arrow')
  expect(result.atomic).toBe(true)
})

test('clearing bound text reports every changed relationship and native undo restores it', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, s = w.scene
    const call = async (operations: any[]) => JSON.parse((await t.tool('canvas_edit', { revision: t.revision(), operations })).content[0].text)
    await call([
      { type: 'create_element', id: 'card', elementType: 'rectangle', x: 100, y: 100 },
      { type: 'create_text', id: 'label', text: 'Editable label', x: 100, y: 100, props: { fontFamily: 2 } },
      { type: 'bind_text', elementId: 'label', containerId: 'card' }
    ])
    const result = await call([{ type: 'update_element', elementId: 'label', props: { text: '' } }])
    return { result, card: s.elements.find((e: any) => e.id === 'card') }
  })
  expect(result.result.deletedIds).toEqual(['label'])
  expect(result.card.boundElements).toEqual([])
  expect(result.result.elements.map((e: any) => e.id)).toEqual(['card'])
  await page.locator('.excalidraw').focus()
  await page.keyboard.press('Meta+z')
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements.find((e: any) => e.id === 'label')?.containerId)).toBe('card')
  expect(await page.evaluate(() => (window as any).scene.elements.find((e: any) => e.id === 'card').boundElements)).toEqual([{ id: 'label', type: 'text' }])
})

test('binding pre-existing text keeps it above its container and label edits have one authority', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, s = w.scene
    const call = (operations: any[]) => t.tool('canvas_edit', { revision: t.revision(), operations })
    await call([
      { type: 'create_text', id: 'label', text: 'Before', x: 100, y: 100, props: { fontFamily: 2 } },
      { type: 'create_element', id: 'card', elementType: 'rectangle', x: 100, y: 100, props: { backgroundColor: '#ffffff', fillStyle: 'solid' } },
      { type: 'bind_text', elementId: 'label', containerId: 'card' }
    ])
    const order = s.elements.map((e: any) => e.id)
    await call([{ type: 'bind_text', elementId: 'label', containerId: null }, { type: 'update_element', elementId: 'label', props: { originalText: 'After' } }])
    const after = structuredClone(s.elements.find((e: any) => e.id === 'label'))
    let conflict = ''
    try { await call([{ type: 'update_element', elementId: 'label', props: { text: 'One', originalText: 'Two' } }]) } catch (e) { conflict = String(e) }
    return { order, after, conflict }
  })
  expect(result.order.indexOf('label')).toBeGreaterThan(result.order.indexOf('card'))
  expect(result.after.text).toBe('After')
  expect(result.after.originalText).toBe('After')
  expect(result.conflict).toContain('text')
})

test('point edits normalize arrow geometry before positioning its bound label', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, s = w.scene
    const call = (operations: any[]) => t.tool('canvas_edit', { revision: t.revision(), operations })
    await call([
      { type: 'create_element', id: 'edge', elementType: 'arrow', x: 100, y: 200, props: { points: [[0, 0], [200, 0]] } },
      { type: 'create_text', id: 'label', text: 'Connected', x: 150, y: 180, props: { fontFamily: 2 } },
      { type: 'bind_text', elementId: 'label', containerId: 'edge' }
    ])
    await call([{ type: 'update_element', elementId: 'edge', props: { points: [[0, 0], [0, 400]] } }])
    const edge = structuredClone(s.elements.find((e: any) => e.id === 'edge'))
    const label = structuredClone(s.elements.find((e: any) => e.id === 'label'))
    let unsupported = ''
    try { await call([{ type: 'update_element', elementId: 'edge', props: { height: 800 } }]) } catch (e) { unsupported = String(e) }
    return { edge, label, unsupported }
  })
  expect(result.edge.width).toBe(0)
  expect(result.edge.height).toBe(400)
  expect(result.label.x + result.label.width / 2).toBeCloseTo(100)
  expect(result.label.y + result.label.height / 2).toBeCloseTo(400)
  expect(result.unsupported).toContain('points')
})

test('selection action geometry keeps image connectors attached and can be undone', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, s = w.scene
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 100
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#008866'; ctx.fillRect(0, 0, 100, 100)
    const [id] = await t.import(canvas.toDataURL(), { x: 200, y: 200 })
    await t.tool('canvas_edit', { revision: t.revision(), operations: [
      { type: 'create_element', id: 'target', elementType: 'rectangle', x: 600, y: 150 },
      { type: 'create_element', id: 'edge', elementType: 'arrow', x: 255, y: 200, props: { points: [[0, 0], [340, 0]] } },
      { type: 'bind_arrow', elementId: 'edge', start: id, end: 'target' }
    ] })
    const before = structuredClone(s.elements.find((e: any) => e.id === 'edge'))
    // Selection actions prepare geometry then use CanvasScene.replace.
    s.replace(s.elements.map((e: any) => e.id === id ? { ...e, x: e.x + 200, y: e.y + 100, version: e.version + 1 } : e))
    return { before, after: s.elements.find((e: any) => e.id === 'edge') }
  })
  expect([result.after.x, result.after.y, result.after.points]).not.toEqual([result.before.x, result.before.y, result.before.points])
  await page.locator('.excalidraw').focus()
  await page.keyboard.press('Meta+z')
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements.find((e: any) => e.id === 'edge')?.x)).toBe(result.before.x)
})

test('a batch that groups nothing reports it, while any deliberate unit stays silent', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w: any = window, t = w.engineTest, s = w.scene
    const call = async (ops: any[]) => {
      const reply: any = await t.tool('canvas_edit', { revision: t.revision(), operations: ops })
      return JSON.parse(reply.content.find((part: any) => part.type === 'text').text)
    }
    const box = (id: string, group?: string) => ({ type: 'create_element', id, elementType: 'rectangle', x: 100, y: 100,
      props: { width: 20, height: 20, ...(group ? { groupIds: [group] } : {}) } })
    const isolated = await call([box('solo')])
    const loose = await call([box('loose-a'), box('loose-b'), box('loose-c')])
    const grouped = await call([box('held-a', 'unit'), box('held-b', 'unit')])
    const partial = await call([box('mix-a', 'unit-2'), box('mix-b')])
    const single = await call([box('held-c', 'unit-3')])
    return { isolated: isolated.notes ?? null, loose: loose.notes ?? null, grouped: grouped.notes ?? null,
      partial: partial.notes ?? null, single: single.notes ?? null,
      groupedIds: s.elements.filter((el: any) => el.groupIds.includes('unit')).map((el: any) => el.id) }
  })
  expect(result.isolated).toBeNull()
  expect(result.grouped).toBeNull()
  // A deliberately mixed batch is not nagged: only an entirely ungrouped batch is reported.
  expect(result.partial).toBeNull()
  expect(result.single).toBeNull()
  expect(result.loose).toHaveLength(1)
  expect(result.loose[0]).toContain('3 elements were created with no group')
  expect(result.loose[0]).toContain('resubmit them sharing a props.groupIds entry')
  expect(result.groupedIds).toEqual(['held-a', 'held-b'])
})
