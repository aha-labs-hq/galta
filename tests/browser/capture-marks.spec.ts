import { test, expect } from '@playwright/test'

// A model cannot tie an element ID to its pixels when objects overlap. Marks
// print one number per object a person would point at and return which IDs it
// names; the grid prints world coordinates, so positions read off a view can be
// used as x/y directly.
test('marks number each object and the grid prints world coordinates', async ({ page }, info) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const { CanvasTool } = await import('/canvas/canvasTool.ts' as string)
    const { TaskScene } = await import('/canvas/toolScene.ts' as string)
    const { prepareCanvasMessage } = await import('/canvas/canvasMessage.ts' as string)
    const w = window as any, t = w.engineTest, scene = w.scene
    t.apply([
      { type: 'create_element', id: 'back', elementType: 'rectangle', x: 0, y: 0, props: { width: 300, height: 200, backgroundColor: '#ff0000', fillStyle: 'solid', roughness: 0 } },
      { type: 'create_element', id: 'front', elementType: 'rectangle', x: 150, y: 100, props: { width: 300, height: 200, backgroundColor: '#0000ff', fillStyle: 'solid', roughness: 0 } },
      { type: 'create_element', id: 'card', elementType: 'rectangle', x: 600, y: 0, props: { width: 200, height: 120, roughness: 0, groupIds: ['card-group'] } },
      { type: 'create_text', id: 'card-note', x: 600, y: 140, text: 'Note', props: { groupIds: ['card-group'] } },
      { type: 'create_element', id: 'box', elementType: 'rectangle', x: 0, y: 500, props: { width: 200, height: 100, roughness: 0 } },
      { type: 'create_text', id: 'box-label', x: 20, y: 520, text: 'Inside' },
      { type: 'bind_text', elementId: 'box-label', containerId: 'box' }
    ])
    scene.select([])
    const pixelsOf = async (data: string) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob())
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close()
      const image = context.getImageData(0, 0, canvas.width, canvas.height)
      const at = (x: number, y: number) => { const i = (y * image.width + x) * 4; return [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!] }
      // Mean brightness of one pixel column over a span of rows.
      const column = (x: number, from: number, to: number) => { let sum = 0; for (let y = from; y < to; y++) sum += at(x, y).reduce((a, b) => a + b, 0) / 3; return sum / (to - from) }
      return { width: image.width, height: image.height, at, column }
    }
    const region = { x: 0, y: 0, width: 500, height: 320 }
    const plain = await t.tool('canvas_capture', { region })
    const marked = await t.tool('canvas_capture', { region, marks: true })
    const gridded = await t.tool('canvas_capture', { region, grid: true })
    const canvasMarks = (await t.tool('canvas_capture', { scope: 'canvas', marks: true })).structuredContent.marks
    const failures: string[] = []
    for (const input of [{ scope: 'canvas', marks: true, file: true }, { scope: 'canvas', marks: 'yes' }, { scope: 'canvas', grid: 1 }]) {
      try { await t.tool('canvas_capture', input); failures.push('accepted') } catch (error) { failures.push(String(error)) }
    }
    const [p, m, g] = await Promise.all([plain, marked, gridded].map(view => pixelsOf(view.content[0].data)))
    // 1400 px over 500 world units: 2.8 px per unit. Badges sit 4 px inside
    // each object's top-left corner, with the number 4 px further in, so the
    // sample point is in the badge's left margin; grid lines fall every 50 units.
    const scale = 1400 / 500, inBadge = (x: number, y: number) => [Math.round(x * scale) + 6, Math.round(y * scale) + 14] as const
    const submitted = t.captureSubmittedContext(scene); submitted.viewport = { ...region, zoom: 1 }
    const task = new TaskScene(scene.snapshot(), [], { ...region, zoom: 1, center: { x: 250, y: 160 } })
    const scope = { executionId: 'test', cwd: '/tmp/galta-test', signal: new AbortController().signal }
    const observe = (unchanged?: string) => prepareCanvasMessage(new CanvasTool(task, {}, () => { throw Error('Observation cannot write') }, submitted), submitted, 'commit', scope, unchanged)
    const message = await observe()
    const unchanged = await observe(message.context.preview.evidenceId)
    task.close()
    return {
      plainMarks: plain.structuredContent.marks ?? null,
      regionMarks: marked.structuredContent.marks,
      canvasMarks,
      failures,
      size: [m.width, m.height],
      badge: { back: { plain: p.at(...inBadge(0, 0)), marked: m.at(...inBadge(0, 0)) }, front: { plain: p.at(...inBadge(150, 100)), marked: m.at(...inBadge(150, 100)) } },
      // A 1 px line at a fractional raster position spreads over two columns.
      grid: Object.fromEntries(([['gridded', g], ['plain', p]] as const).map(([name, view]) => {
        const between = view.column(Math.round(275 * scale), 300, 700)
        return [name, Math.max(...[-2, -1, 0, 1, 2].map(dx => Math.abs(view.column(Math.round(250 * scale) + dx, 300, 700) - between)))]
      })),
      visible: message.context.visible.items, unchangedVisible: unchanged.context.visible.items,
      images: { marked: marked.content[0].data, gridded: gridded.content[0].data }
    }
  })
  await info.attach('marked.jpg', { body: Buffer.from(result.images.marked, 'base64'), contentType: 'image/jpeg' })
  await info.attach('gridded.jpg', { body: Buffer.from(result.images.gridded, 'base64'), contentType: 'image/jpeg' })
  expect(result.plainMarks).toBeNull()
  // Overlapping rectangles are separate objects, read in rows from the top.
  expect(result.regionMarks.map((mark: any) => [mark.label, mark.ids])).toEqual([['1', ['back']], ['2', ['front']]])
  expect(result.regionMarks[1].bounds).toMatchObject({ x: 150, y: 100, width: 300, height: 200 })
  // A group is one object, and bound text belongs to its container.
  expect(result.canvasMarks.map((mark: any) => [mark.label, [...mark.ids].sort(), mark.groupId ?? null])).toEqual([
    ['1', ['back'], null], ['2', ['card', 'card-note'], 'card-group'], ['3', ['front'], null], ['4', ['box', 'box-label'], null]
  ])
  expect(result.failures[0]).toContain('request marks or grid in a separate view')
  expect(result.failures[1]).toContain('marks must be true or false')
  expect(result.failures[2]).toContain('grid must be true or false')
  expect(result.size).toEqual([1400, 896])
  // The badge is dark ink where the plain view shows the red and blue fills.
  for (const corner of [result.badge.back, result.badge.front]) {
    expect(Math.max(...corner.marked)).toBeLessThan(60)
    expect(Math.max(...corner.plain)).toBeGreaterThan(180)
    expect(Math.min(...corner.plain)).toBeLessThan(60)
  }
  // A grid line changes its column even over a saturated fill; the plain view
  // has no such line.
  expect(result.grid.gridded).toBeGreaterThan(20)
  expect(result.grid.plain).toBeLessThan(3)
  // The message names the same numbers, with or without fresh pixels.
  expect(result.visible.map((item: any) => [item.id, item.mark])).toEqual([['back', '1'], ['front', '2']])
  expect(result.unchangedVisible).toEqual(result.visible)
})
