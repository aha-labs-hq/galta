import { test, expect } from '@playwright/test'

test('world bounds agree across submission, inspection and receipts without changing native edit coordinates', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const { CanvasTool } = await import('/canvas/canvasTool.ts' as string)
    const { TaskScene } = await import('/canvas/toolScene.ts' as string)
    const { prepareCanvasMessage } = await import('/canvas/canvasMessage.ts' as string)
    const { scene, engineTest: t } = window as any
    const expected: Record<string, any> = {}, operations: any[] = []
    // Two paths with opposite origins occupy the SAME world box. Include
    // translation, negative points and rotations, with an independent analytic rotation oracle.
    for (const [row, elementType] of ['freedraw', 'line', 'arrow'].entries()) {
      for (const [col, rotation] of [0, Math.PI / 2, 2.31].entries()) {
        const id = `path-${row}-${col}`, x = 180 + col * 300, y = 150 + row * 240
        operations.push({ type: 'create_element', elementType, id, x, y, rotation,
          props: { points: [[0, 0], [-80, 120]], roughness: 0, roundness: null, startArrowhead: null, endArrowhead: null } })
        // Analytic rotated segment, independent of the production bounds API.
        const cx = x - 40, cy = y + 60, dx = 40 * Math.cos(rotation) + 60 * Math.sin(rotation), dy = 40 * Math.sin(rotation) - 60 * Math.cos(rotation)
        expected[id] = { x: cx - Math.abs(dx), y: cy - Math.abs(dy), width: 2 * Math.abs(dx), height: 2 * Math.abs(dy) }
      }
    }
    operations.push({ type: 'create_element', id: 'opposite-origin', elementType: 'freedraw', x: 100, y: 270, props: { points: [[0, 0], [80, -120]] } })
    expected['opposite-origin'] = expected['path-0-0']
    operations.push({ type: 'create_element', id: 'rotated-box', elementType: 'rectangle', x: 950, y: 150, rotation: Math.PI / 2, props: { width: 120, height: 40 } })
    expected['rotated-box'] = { x: 990, y: 110, width: 40, height: 120 }
    const receipt = (await t.tool('canvas_edit', { revision: t.revision(), operations })).structuredContent
    const before = JSON.stringify(scene.snapshot()), native = structuredClone(scene.elements)
    const viewport = { x: 0, y: 0, width: 1200, height: 900, zoom: 1 }
    const submitted = { ...t.captureSubmittedContext(scene), selection: [], viewport }
    const task = new TaskScene(scene.snapshot(), [], { ...viewport, center: { x: 600, y: 450 } })
    const scope = { executionId: 'test', cwd: '/tmp/galta-test', signal: new AbortController().signal }
    try {
      const tool = new CanvasTool(task, {}, () => { throw Error('Observation cannot write') }, submitted)
      const summary = (await tool.execute('canvas_inspect', {}, scope)).structuredContent.elements
      const message = await prepareCanvasMessage(tool, submitted, 'commit', scope)
      const detailed = (await tool.execute('canvas_inspect', { detail: 'elements' }, scope)).structuredContent.elements
      return { expected, native, receipt, summary, detailed, message: message.context, unchanged: before === JSON.stringify(scene.snapshot()) }
    } finally { task.close() }
  })
  expect(result.unchanged).toBe(true)
  for (const [id, bounds] of Object.entries(result.expected)) {
    const summary = result.summary.find((item: any) => item.id === id)
    const native = result.native.find((item: any) => item.id === id)
    expect(summary).toMatchObject({ x: native.x, y: native.y, width: native.width, height: native.height, rotation: native.angle })
    expect(summary.bounds).toEqual(result.detailed.find((item: any) => item.id === id).bounds)
    expect(summary.bounds).toEqual(result.receipt.elements.find((item: any) => item.id === id).bounds)
    expect(result.message.visible.items.find((item: any) => item.id === id)).toEqual({ id, kind: summary.kind, bounds: summary.bounds })
    for (const [key, value] of Object.entries(bounds as any)) expect(summary.bounds[key]).toBeCloseTo(value as number, 7)
  }
})

test('a path is discovered where it lies even when its native origin is outside the viewport', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const { CanvasTool } = await import('/canvas/canvasTool.ts' as string)
    const { scene, engineTest: t } = window as any
    t.apply([{ type: 'create_element', elementType: 'freedraw', id: 'negative-path', x: 900, y: 700, props: { points: [[0, 0], [-800, -600]] } }])
    const submitted = { ...t.captureSubmittedContext(scene), viewport: { x: 80, y: 80, width: 50, height: 50, zoom: 1 } }
    const tool = new CanvasTool(scene, {}, () => {}, submitted)
    return (await tool.execute('canvas_inspect', { scope: 'viewport' }, { executionId: 'test', cwd: '/tmp', signal: new AbortController().signal })).structuredContent
  })
  expect(result.coverage.total).toBe(1)
  expect(result.elements[0]).toMatchObject({ x: 900, y: 700, bounds: { x: 100, y: 100, width: 800, height: 600 } })
})
