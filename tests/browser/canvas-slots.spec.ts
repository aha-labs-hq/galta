import { test, expect } from '@playwright/test'

test('a held place glows where work will land, takes the result in proportion and leaves no trace in the document', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest
    const picture = document.createElement('canvas'); picture.width = 400; picture.height = 200
    picture.getContext('2d')!.fillRect(0, 0, 400, 200)
    w.testArtifacts.readImage = async () => ({ dataUrl: picture.toDataURL() })
    const agent = t.agentTool(); w.agent = agent
    const before = t.revision()
    const reserved = (await agent.execute('canvas_reserve', { places: [{ width: 300, height: 300 }, { width: 300, height: 300 }] })).structuredContent.slots
    const drawn = [...document.querySelectorAll<SVGElement>('svg.canvas-slot')].map(svg => ({ width: parseFloat(svg.style.width) }))
    const unchanged = t.revision() === before && t.revision() === t.revision() && w.scene.elements.length === 0
    const { structuredContent: placed } = await agent.execute('canvas_place', { revision: before, path: '/tmp/galta-test/outputs/a.png', slot: reserved[0].id })
    const image = w.scene.elements.find((el: any) => el.id === placed.elementId)
    const afterPlace = agent.held.slots.map((slot: any) => slot.id)
    const errors: string[] = []
    for (const args of [
      { revision: placed.revision, path: '/tmp/galta-test/outputs/a.png', slot: reserved[0].id },
      { revision: placed.revision, path: '/tmp/galta-test/outputs/a.png', slot: reserved[1].id, x: 0, y: 0 }
    ]) { try { await agent.execute('canvas_place', args) } catch (error) { errors.push(String(error)) } }
    for (const args of [{}, { places: [{ width: 0, height: 10 }] }, { places: [{ width: 10, height: 10, x: 1 }] }, { places: [{ width: 1e308, height: 10 }] }]) { try { await agent.execute('canvas_reserve', args) } catch (error) { errors.push(String(error)) } }
    // An edit glows over the image it reworks; replacing keeps its geometry and ends the place.
    const over = (await agent.execute('canvas_reserve', { places: [{ x: image.x, y: image.y, width: image.width, height: image.height }] })).structuredContent.slots.at(-1)
    const replaced = (await agent.execute('canvas_place', { revision: t.revision(), path: '/tmp/galta-test/outputs/b.png', replace: placed.elementId, slot: over.id })).structuredContent
    const rebound = w.scene.elements.find((el: any) => el.id === placed.elementId)
    const afterReplace = agent.held.slots.map((slot: any) => slot.id)
    const released = (await agent.execute('canvas_reserve', { release: [reserved[1].id] })).structuredContent.slots
    const left = document.querySelectorAll('svg.canvas-slot').length
    const documentIds = w.scene.document.elements.map((el: any) => el.id)
    return { reserved, drawn, unchanged, image: { x: image.x, y: image.y, width: image.width, height: image.height }, afterPlace, errors, released, left, viewport: w.scene.viewport,
      replaced: { action: replaced.action, x: rebound.x, y: rebound.y, width: rebound.width, height: rebound.height }, afterReplace, documentIds, placedId: placed.elementId }
  })
  // Two places line up in one row centred in the view, 32 apart, and each is drawn where it is.
  const [first, second] = result.reserved
  expect(second.x - (first.x + first.width)).toBe(32)
  expect((first.x + second.x + second.width) / 2).toBeCloseTo(result.viewport.center.x)
  expect(first.y + first.height / 2).toBeCloseTo(result.viewport.center.y)
  expect(result.drawn).toHaveLength(2)
  expect(result.drawn[0].width).toBeCloseTo(300 * result.viewport.zoom, 0)
  // Reserving is view state: the document and its revision do not move.
  expect(result.unchanged).toBe(true)
  // A 2:1 image fills the square place's width, centred vertically, and the place ends.
  expect(result.image).toEqual({ x: first.x, y: first.y + 75, width: 300, height: 150 })
  expect(result.afterPlace).toEqual([second.id])
  expect(result.errors[0]).toContain('is no longer reserved')
  expect(result.errors[1]).toContain('A slot sets the geometry')
  expect(result.errors[2]).toContain('Give places to reserve or places to release')
  expect(result.errors[3]).toContain('Invalid place width')
  expect(result.errors[4]).toContain('Place x and y must be supplied together')
  expect(result.errors[5]).toContain('Invalid place width')
  expect(result.replaced).toEqual({ action: 'updated', ...result.image })
  expect(result.afterReplace).toEqual([second.id])
  expect(result.released).toEqual([])
  expect(result.left).toBe(0)
  // Only the placed image ever entered the document.
  expect(result.documentIds).toEqual([result.placedId])
})

test('held places follow the camera', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const moved = await page.evaluate(async () => {
    const w = window as any, agent = w.engineTest.agentTool()
    const [slot] = (await agent.execute('canvas_reserve', { places: [{ width: 200, height: 120, x: 40, y: 60 }] })).structuredContent.slots
    const at = () => document.querySelector('svg.canvas-slot')!.getBoundingClientRect()
    const before = at()
    const { scrollX, scrollY } = w.scene.api.getAppState()
    w.scene.api.updateScene({ appState: { scrollX: scrollX + 100, scrollY: scrollY + 50 } })
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const after = at()
    // Off screen the light rests; back on screen it travels again.
    const light = () => Number(document.querySelector('svg.canvas-slot radialGradient')!.getAttribute('cx'))
    const frames = (n: number) => new Promise(resolve => { const step = () => --n ? requestAnimationFrame(step) : resolve(undefined); requestAnimationFrame(step) })
    const moving = async () => { const a = light(); await frames(6); return light() !== a }
    const onScreen = await moving()
    w.scene.api.updateScene({ appState: { scrollX: scrollX + 100000, scrollY } }); await frames(3)
    const offScreen = await moving()
    w.scene.api.updateScene({ appState: { scrollX, scrollY } }); await frames(3)
    const back = await moving()
    return { slot, dx: after.x - before.x, dy: after.y - before.y, onScreen, offScreen, back }
  })
  expect(moved.slot).toEqual({ id: expect.stringMatching(/^place-\d+$/), x: 40, y: 60, width: 200, height: 120 })
  expect(moved.dx).toBeCloseTo(100, 0)
  expect(moved.dy).toBeCloseTo(50, 0)
  expect([moved.onScreen, moved.offScreen, moved.back]).toEqual([true, false, true])
})

test('a page, a frame or an image made with canvas_edit fills a held place, which ends only when the edit commits', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest
    const picture = document.createElement('canvas'); picture.width = 400; picture.height = 200
    picture.getContext('2d')!.fillRect(0, 0, 400, 200)
    w.testArtifacts.readImage = async () => ({ dataUrl: picture.toDataURL() })
    w.testArtifacts.readHtml = async () => ({ html: '<!doctype html><html><body>Page</body></html>' })
    const agent = t.agentTool()
    const [pagePlace, framePlace, imagePlace] = (await agent.execute('canvas_reserve', { places: [{ x: 0, y: 0, width: 640, height: 400 }, { x: 700, y: 0, width: 300, height: 200 }, { x: 0, y: 500, width: 300, height: 300 }] })).structuredContent.slots
    const errors: string[] = []
    const attempt = async (operations: unknown[]) => { try { return (await agent.execute('canvas_edit', { revision: t.revision(), operations })).structuredContent } catch (error) { errors.push(String(error)); return undefined } }
    // A failed edit leaves its places held; a place is filled once per edit.
    await attempt([{ type: 'create_element', elementType: 'rectangle', slot: framePlace.id }, { type: 'create_element', elementType: 'frame', slot: framePlace.id }])
    await attempt([{ type: 'create_element', elementType: 'rectangle', slot: 'place-404' }])
    const heldAfterFailures = agent.held.slots.map((slot: any) => slot.id)
    await attempt([
      { type: 'create_element', id: 'page', elementType: 'html', slot: pagePlace.id, props: { htmlPath: '/tmp/galta-test/outputs/page.html' } },
      { type: 'create_element', id: 'board', elementType: 'frame', slot: framePlace.id, props: { name: 'Research' } },
      { type: 'create_element', id: 'still', elementType: 'image', slot: imagePlace.id, props: { mediaPath: '/tmp/galta-test/outputs/a.png' } }
    ])
    const box = (id: string) => { const el = w.scene.elements.find((el: any) => el.id === id); return { x: el.x, y: el.y, width: el.width, height: el.height } }
    const heldAfterFill = agent.held.slots.map((slot: any) => slot.id)
    // An edit that reworks the page glows over it and keeps its geometry.
    const over = (await agent.execute('canvas_reserve', { places: [box('page')] })).structuredContent.slots.at(-1)
    await attempt([{ type: 'update_element', elementId: 'page', slot: over.id, props: { htmlPath: '/tmp/galta-test/outputs/page-2.html' } }])
    return { places: [pagePlace, framePlace, imagePlace], errors, heldAfterFailures, heldAfterFill, page: box('page'), board: box('board'), still: box('still'), reworked: box('page'), heldAtEnd: agent.held.slots.length }
  })
  const [pagePlace, framePlace, imagePlace] = result.places
  expect(result.errors[0]).toContain('is already filled in this edit')
  expect(result.errors[1]).toContain('place-404 is no longer reserved')
  expect(result.heldAfterFailures).toEqual([pagePlace.id, framePlace.id, imagePlace.id])
  expect(result.page).toEqual({ x: 0, y: 0, width: 640, height: 400 })
  expect(result.board).toEqual({ x: 700, y: 0, width: 300, height: 200 })
  // A 2:1 image fills the square place's width, centred vertically.
  expect(result.still).toEqual({ x: 0, y: 575, width: 300, height: 150 })
  expect(result.heldAfterFill).toEqual([])
  expect(result.reworked).toEqual(result.page)
  expect(result.heldAtEnd).toBe(0)
})

// The conversation's reading sheet rises when a request is sent and covers the
// lower canvas. Work that has no place of its own lands, and is sized, in what
// the reader can see: the clear frame less that sheet. The camera keeps the
// clear frame; only where new work lands moves.
test('work without a place of its own lands where the reader can see it, above an open conversation', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const w = window as any, t = w.engineTest, scene = w.scene
    const picture = document.createElement('canvas'); picture.width = 300; picture.height = 400
    picture.getContext('2d')!.fillRect(0, 0, 300, 400)
    w.testArtifacts.readImage = async () => ({ dataUrl: picture.toDataURL() })
    const { canvasFrame, visibleCanvasFrame } = await import('/canvas/useCanvasInsets.ts' as string)
    // The canvas view's chrome: header, tool rail, and a dock with its sheet open.
    const shell = document.createElement('div')
    shell.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:720px;pointer-events:none'
    shell.innerHTML = '<div class="galta-workspace" style="position:absolute;inset:0"></div>'
      + '<header class="galta-topbar" style="position:absolute;left:0;top:0;width:100%;height:64px"></header>'
      + '<div class="drawing-dock" style="position:absolute;left:16px;top:200px;width:48px;height:300px"></div>'
      + '<section class="conversation-dock" style="position:absolute;bottom:16px;left:360px;width:560px"><div class="conversation-presence" style="height:240px"></div><form class="conversation-composer" style="height:96px"></form></section>'
    document.body.append(shell)
    const clear = canvasFrame(shell), seen = visibleCanvasFrame(shell)
    const unseen = scene.seenThrough(() => visibleCanvasFrame(shell))
    const view = scene.viewport, state = scene.api.getAppState()
    const agent = t.agentTool()
    const placed = (await agent.execute('canvas_place', { revision: t.revision(), path: '/tmp/galta-test/outputs/lamp.png' })).structuredContent
    const image = scene.elements.find((el: any) => el.id === placed.elementId)
    const slot = (await agent.execute('canvas_reserve', { places: [{ width: 120, height: 120 }] })).structuredContent.slots[0]
    // Closing the sheet gives the reader the whole clear frame back.
    shell.querySelector<HTMLElement>('.conversation-presence')!.style.height = '0px'
    const closed = scene.viewport
    unseen(); shell.remove()
    return { clear, seen, view, closed, whole: scene.viewport, zoom: state.zoom.value, scroll: { x: state.scrollX, y: state.scrollY }, editor: { width: state.width, height: state.height },
      image: { x: image.x, y: image.y, width: image.width, height: image.height }, slot }
  })
  const { clear, seen, view, closed, whole, zoom, scroll, image, slot } = result
  expect(seen).toEqual({ ...clear, height: clear.height - 240 })
  expect(view).toMatchObject({ x: seen.left / zoom - scroll.x, y: seen.top / zoom - scroll.y, width: seen.width / zoom, height: seen.height / zoom })
  expect(closed.height).toBeCloseTo(clear.height / zoom)
  expect(whole).toMatchObject({ x: 0 - scroll.x, y: 0 - scroll.y, width: result.editor.width / zoom, height: result.editor.height / zoom })
  // The picture is centred in the reader's view and fits inside it.
  expect(image.x + image.width / 2).toBeCloseTo(view.center.x)
  expect(image.y + image.height / 2).toBeCloseTo(view.center.y)
  expect(image.y).toBeGreaterThanOrEqual(view.y)
  expect(image.y + image.height).toBeLessThanOrEqual(view.y + view.height)
  expect(slot.x + slot.width / 2).toBeCloseTo(view.center.x)
  expect(slot.y + slot.height / 2).toBeCloseTo(view.center.y)
})
