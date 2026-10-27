import { test, expect, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.GALTA_SEMANTICS_URL ?? '/dev/scene-test.html')
  await page.waitForFunction(() => !!(window as any).engineTest)
})

async function selected(page: Page) {
  return page.evaluate(() => [...(window as any).scene.selectedIds].sort())
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from)
  await page.mouse.down()
  await page.mouse.move(...to, { steps: 8 })
  await page.mouse.up()
}

async function prepare(page: Page, elements: any[], mode?: 'contain' | 'overlap') {
  await page.evaluate(({ elements, mode }) => {
    const { scene, engineTest } = window as any
    engineTest.apply(elements)
    scene.select([])
    scene.api.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, ...(mode && { boxSelectionMode: mode }) } })
    scene.api.setActiveTool({ type: 'selection' })
  }, { elements, mode })
  await page.locator('.excalidraw').focus()
}

const rect = (id: string, x = 200, y = 200, props: Record<string, unknown> = {}) => ({
  type: 'create_element', id, elementType: 'rectangle', x, y,
  props: { width: 100, height: 100, roughness: 0, ...props },
})

test('default overlap selection updates during dragging and leaves artwork unchanged', async ({ page }) => {
  await prepare(page, [rect('shape')])
  const before = await page.evaluate(() => JSON.stringify((window as any).scene.snapshot().document))
  await page.mouse.move(160, 160)
  await page.mouse.down()
  await page.mouse.move(250, 250, { steps: 8 })
  await expect.poll(() => selected(page)).toEqual(['shape'])
  await page.mouse.move(180, 180, { steps: 8 })
  await expect.poll(() => selected(page)).toEqual([])
  await page.mouse.move(250, 250, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => selected(page)).toEqual(['shape'])
  expect(await page.evaluate(() => JSON.stringify((window as any).scene.snapshot().document))).toBe(before)
})

test('contain mode requires the entire element and survives scene restoration', async ({ page }) => {
  await prepare(page, [rect('shape')], 'contain')
  await drag(page, [160, 160], [250, 250])
  await expect.poll(() => selected(page)).toEqual([])
  await drag(page, [160, 160], [340, 340])
  await expect.poll(() => selected(page)).toEqual(['shape'])
  expect(await page.evaluate(() => {
    const s = (window as any).scene
    s.restore(s.snapshot())
    return s.api.getAppState().boxSelectionMode
  })).toBe('contain')
})

test('overlap works in every drag direction', async ({ page }) => {
  await prepare(page, [rect('shape')])
  for (const [from, to] of [
    [[160, 160], [250, 250]], [[340, 160], [250, 250]],
    [[160, 340], [250, 250]], [[340, 340], [250, 250]],
  ] as [number, number][][]) {
    await page.keyboard.press('Escape')
    await drag(page, from!, to!)
    await expect.poll(() => selected(page)).toEqual(['shape'])
  }
})

test('empty interiors and empty bounds corners do not select geometry', async ({ page }) => {
  await prepare(page, [rect('outline', 150, 150, { width: 300, height: 300 })])
  await drag(page, [210, 210], [270, 270])
  await expect.poll(() => selected(page)).toEqual([])
  await drag(page, [210, 210], [480, 270])
  await expect.poll(() => selected(page)).toEqual(['outline'])
})

for (const elementType of ['ellipse', 'diamond', 'line', 'freedraw']) {
  test(`${elementType} selection follows its outline instead of its bounding box`, async ({ page }) => {
    await prepare(page, [{ type: 'create_element', id: 'shape', elementType, x: 200, y: 200,
      props: { width: 200, height: 200, roughness: 0, ...(['line', 'freedraw'].includes(elementType) ? { points: [[0, 0], [200, 200]] } : {}) } }])
    await drag(page, [190, 375], [225, 410])
    await expect.poll(() => selected(page)).toEqual([])
    await drag(page, [170, 170], [320, 320])
    await expect.poll(() => selected(page)).toEqual(['shape'])
  })
}

test('locked objects are excluded, groups and bound text retain native selection', async ({ page }) => {
  await prepare(page, [rect('locked', 160, 160, { locked: true }),
    rect('one', 300, 200, { groupIds: ['group'] }), rect('two', 500, 200, { groupIds: ['group'] }),
    { type: 'create_text', id: 'label', x: 320, y: 210, text: 'Label' },
    { type: 'bind_text', elementId: 'label', containerId: 'one' }])
  await drag(page, [100, 100], [350, 250])
  await expect.poll(() => selected(page)).toEqual(['one', 'two'])
  await page.keyboard.press('Escape')
  await page.evaluate(() => (window as any).scene.api.updateScene({ appState: { boxSelectionMode: 'contain' } }))
  await drag(page, [100, 100], [450, 350])
  await expect.poll(() => selected(page)).toEqual([])
  await drag(page, [100, 100], [650, 350])
  await expect.poll(() => selected(page)).toEqual(['one', 'two'])
})

test('rotated empty interiors are not mistaken for an outline', async ({ page }) => {
  await prepare(page, [rect('shape', 200, 200, { width: 200, height: 200 })])
  await page.evaluate(() => {
    const { scene, engineTest } = window as any
    engineTest.mutateElement(scene.elements[0], { angle: Math.PI / 4 })
  })
  await drag(page, [390, 290], [410, 310])
  await expect.poll(() => selected(page)).toEqual([])
  await drag(page, [430, 270], [410, 330])
  await expect.poll(() => selected(page)).toEqual(['shape'])
})

test('native frame ownership excludes invisible portions and moves the frame as a unit', async ({ page }) => {
  await prepare(page, [
    { ...rect('frame', 200, 200, { width: 300, height: 300 }), elementType: 'frame' },
    rect('child', 440, 300, { width: 200, height: 100 }),
  ])
  await page.evaluate(() => {
    const { scene, engineTest } = window as any
    engineTest.mutateElement(scene.elements.find((el: any) => el.id === 'child'), { frameId: 'frame' })
  })
  await drag(page, [550, 270], [650, 360])
  await expect.poll(() => selected(page)).toEqual([])
  await drag(page, [410, 270], [470, 340])
  await expect.poll(() => selected(page)).toEqual(['child'])
  await page.keyboard.press('Escape')
  await drag(page, [150, 150], [700, 550])
  await expect.poll(() => selected(page)).toEqual(['child', 'frame'])
  await drag(page, [200, 220], [240, 250])
  expect(await page.evaluate(() => (window as any).scene.elements.map((el: any) => ({ id: el.id, x: el.x, y: el.y, frameId: el.frameId })))).toEqual([
    { id: 'frame', x: 240, y: 230, frameId: null },
    { id: 'child', x: 480, y: 330, frameId: 'frame' },
  ])
})

test('shift extends the selection, and the next unmodified marquee replaces it', async ({ page }) => {
  await prepare(page, [rect('one'), rect('two', 500, 200)])
  await drag(page, [160, 160], [250, 250])
  await page.keyboard.down('Shift')
  await drag(page, [450, 160], [550, 250])
  await page.keyboard.up('Shift')
  await expect.poll(() => selected(page)).toEqual(['one', 'two'])
  await drag(page, [450, 150], [550, 230])
  await expect.poll(() => selected(page)).toEqual(['two'])
})

test('crossing the middle of native line and brush paths selects them', async ({ page }) => {
  await prepare(page, ['line', 'freedraw'].map((elementType, i) => ({
    type: 'create_element', id: elementType, elementType, x: 200 + i * 400, y: 200,
    props: { points: [[0, 0], [200, 200]], roughness: 0 },
  })))
  await drag(page, [265, 290], [325, 310])
  await expect.poll(() => selected(page)).toEqual(['line'])
  await page.keyboard.press('Escape')
  await drag(page, [665, 290], [725, 310])
  await expect.poll(() => selected(page)).toEqual(['freedraw'])
})

test('the existing tools menu switches native selection preferences', async ({ page }) => {
  const url = new URL(process.env.GALTA_SEMANTICS_URL ?? '/dev/scene-test.html', page.url())
  await page.goto(new URL('/sidepanel/index.html', url).href)
  await page.getByRole('button', { name: 'Shapes and more tools', exact: true }).click()
  const overlap = page.getByRole('button', { name: 'Box selection Overlap', exact: true })
  const wrap = page.getByRole('button', { name: 'Box selection Wrap', exact: true })
  await expect(overlap).toHaveAttribute('aria-pressed', 'true')
  await wrap.click()
  await expect(wrap).toHaveAttribute('aria-pressed', 'true')
  await expect(overlap).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Shapes and more tools', exact: true }).click()
  await expect(wrap).toHaveAttribute('aria-pressed', 'true')
  await overlap.click()
  await expect(overlap).toHaveAttribute('aria-pressed', 'true')
})

test('fully clipped frame children cannot be selected in either mode', async ({ page }) => {
  await prepare(page, [
    { ...rect('frame', 200, 200, { width: 200, height: 200, locked: true }), elementType: 'frame' },
    rect('hidden', 500, 220),
  ])
  await page.evaluate(() => {
    const { scene, engineTest } = window as any
    engineTest.mutateElement(scene.elements.find((el: any) => el.id === 'hidden'), { frameId: 'frame' })
  })
  for (const mode of ['overlap', 'contain']) {
    await page.evaluate(mode => (window as any).scene.api.updateScene({ appState: { boxSelectionMode: mode } }), mode)
    await drag(page, [460, 180], [640, 350])
    await expect.poll(() => selected(page)).toEqual([])
  }
})

test('frame clipping applies to outline intersections, not just their bounding boxes', async ({ page }) => {
  await prepare(page, [
    { ...rect('frame', 200, 200, { width: 250, height: 250, locked: true }), elementType: 'frame' },
    { ...rect('circle', 300, 300, { width: 200, height: 200 }), elementType: 'ellipse' },
  ])
  await page.evaluate(() => {
    const { scene, engineTest } = window as any
    engineTest.mutateElement(scene.elements.find((el: any) => el.id === 'circle'), { frameId: 'frame' })
  })
  // Only empty circle interior is visible in this part of the frame. The
  // selection crosses the circle's hidden bottom/right outline outside it.
  await drag(page, [420, 420], [530, 530])
  await expect.poll(() => selected(page)).toEqual([])
  await drag(page, [270, 370], [325, 425])
  await expect.poll(() => selected(page)).toEqual(['circle'])
})

test('group IDs are opaque strings, including Object prototype property names', async ({ page }) => {
  await prepare(page, [rect('one', 200, 200, { groupIds: ['constructor'] }), rect('two', 400, 200, { groupIds: ['constructor'] })])
  await drag(page, [160, 160], [250, 250])
  await expect.poll(() => selected(page)).toEqual(['one', 'two'])
})

test('selection uses scene coordinates across zoom and pan in both modes', async ({ page }) => {
  await prepare(page, [rect('shape')])
  for (const zoom of [0.5, 2]) {
    await page.evaluate(zoom => (window as any).scene.api.updateScene({ appState: {
      zoom: { value: zoom }, scrollX: 100, scrollY: 50,
    } }), zoom)
    // updateScene commits asynchronously; Escape must observe the new camera.
    await expect.poll(() => page.evaluate(() => (window as any).scene.api.getAppState().zoom.value)).toBe(zoom)
    const screen = ([x, y]: [number, number]): [number, number] => [(x + 100) * zoom, (y + 50) * zoom]
    for (const mode of ['overlap', 'contain']) {
      await page.keyboard.press('Escape')
      await page.evaluate(mode => (window as any).scene.api.updateScene({ appState: { boxSelectionMode: mode } }), mode)
      await drag(page, screen([160, 160]), screen([250, 250]))
      await expect.poll(() => selected(page)).toEqual(mode === 'overlap' ? ['shape'] : [])
      await page.keyboard.press('Escape')
      await drag(page, screen([160, 160]), screen([340, 340]))
      await expect.poll(() => selected(page)).toEqual(['shape'])
    }
  }
})

test('curved and rotated arrows are selected by crossing between their vertices', async ({ page }) => {
  await prepare(page, [{ type: 'create_element', id: 'curve', elementType: 'arrow', x: 200, y: 200,
    props: { points: [[0, 0], [100, -100], [200, 0]], roundness: { type: 2 }, roughness: 0 },
  }])
  await drag(page, [240, 90], [260, 180])
  await expect.poll(() => selected(page)).toEqual(['curve'])
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    const { scene, engineTest } = window as any
    engineTest.mutateElement(scene.elements[0], { angle: Math.PI / 2 })
  })
  await drag(page, [300, 95], [350, 120])
  await expect.poll(() => selected(page)).toEqual(['curve'])
})

test('native frame creation contains whole groups regardless of the overlap preference', async ({ page }) => {
  await prepare(page, [
    rect('inside-one', 230, 240, { width: 40, height: 40, groupIds: ['inside'] }),
    rect('inside-two', 300, 240, { width: 40, height: 40, groupIds: ['inside'] }),
    rect('partial-one', 360, 320, { width: 40, height: 40, groupIds: ['partial'] }),
    rect('partial-two', 460, 320, { width: 40, height: 40, groupIds: ['partial'] }),
    rect('crossing', 420, 220),
  ])
  await page.evaluate(() => (window as any).scene.api.setActiveTool({ type: 'frame' }))
  await drag(page, [180, 180], [450, 420])
  expect(await page.evaluate(() => {
    const elements = (window as any).scene.elements
    const frame = elements.find((el: any) => el.type === 'frame')
    return elements.filter((el: any) => el.frameId === frame.id).map((el: any) => el.id).sort()
  })).toEqual(['inside-one', 'inside-two'])
})

test('switching modes adds no undo step and native undo preserves the preference', async ({ page }) => {
  await prepare(page, [rect('shape')])
  await drag(page, [200, 230], [240, 260])
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements[0].x)).toBe(240)
  await page.evaluate(() => {
    const { scene } = window as any
    scene.api.updateScene({ appState: { boxSelectionMode: 'contain' }, captureUpdate: 'NEVER' })
  })
  await page.keyboard.press('Meta+z')
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements[0].x)).toBe(200)
  expect(await page.evaluate(() => (window as any).scene.api.getAppState().boxSelectionMode)).toBe('contain')
  await page.keyboard.press('Meta+Shift+z')
  await expect.poll(() => page.evaluate(() => (window as any).scene.elements[0].x)).toBe(240)
  expect(await page.evaluate(() => (window as any).scene.api.getAppState().boxSelectionMode)).toBe('contain')
})
