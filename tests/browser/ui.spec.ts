import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { test, expect } from '@playwright/test'
import { installReturningAccount } from '../helpers/canvas-port'
import { seedWorkspace, storedWorkspace } from '../helpers/stored-workspace'

test('drawing controls stay independently docked on the left', async ({ page }) => {
  await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeVisible()
  await expect(page.locator('canvas.static')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Canvas zoom', exact: true })).toBeVisible()
  const theme = await page.evaluate(() => {
    const rgba = (color: string) => {
      const channels = color.match(/[\d.]+/g)!.map(Number)
      return color.startsWith('color(srgb') ? [...channels.slice(0, 3).map(c => c * 255), channels[3] ?? 1] : channels
    }
    const composite = (front: number[], back: number[]) => front.slice(0, 3).map((c, i) => c * (front[3] ?? 1) + back[i]! * (1 - (front[3] ?? 1)))
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.static')!
    const background = [...canvas.getContext('2d')!.getImageData(100 * devicePixelRatio, 150 * devicePixelRatio, 1, 1).data].slice(0, 3)
    const actionSurface = composite(rgba(getComputedStyle(document.querySelector('.viewport-control')!).backgroundColor), background)
    const text = rgba(getComputedStyle(document.querySelector('.viewport-trigger')!).color).slice(0, 3)
    const luminance = (channels: number[]) => channels.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i]!, 0)
    const surfaceLuminance = luminance(actionSurface), textLuminance = luminance(text)
    return { background, text, contrast: (Math.max(surfaceLuminance, textLuminance) + .05) / (Math.min(surfaceLuminance, textLuminance) + .05),
      font: getComputedStyle(document.querySelector('.composer-footer')!).fontFamily }
  })
  expect(new Set(theme.background).size, 'the painted canvas has no color cast').toBe(1)
  expect(new Set(theme.text).size, 'supporting UI text is neutral').toBe(1)
  expect(theme.contrast).toBeGreaterThanOrEqual(4.5)
  expect(theme.font).not.toContain('Georgia')
  await expect(page.getByRole('button', { name: /^Model GPT/ })).toBeVisible()
  const dock = page.getByRole('navigation', { name: 'Galta tools' })
  await expect(dock).toHaveAttribute('data-overflow', 'false')
  const toolsBar = page.getByRole('toolbar', { name: 'Canvas tools', exact: true })
  for (const name of ['Navigate canvas', 'Draw and write', 'Bring in media', 'Appearance']) await expect(toolsBar.getByRole('group', { name, exact: true })).toBeVisible()
  const selectBox = (await page.getByRole('button', { name: 'Select — V', exact: true }).boundingBox())!
  const handBox = (await page.getByRole('button', { name: 'Hand — H', exact: true }).boundingBox())!
  const drawBox = (await page.getByRole('button', { name: 'Draw — P', exact: true }).boundingBox())!
  expect(drawBox.y - handBox.y - handBox.height).toBeGreaterThan(handBox.y - selectBox.y - selectBox.height)
  await expect(page.locator('.conversation-dock .drawing-dock')).toHaveCount(0)
  await expect(page.getByRole('toolbar', { name: 'Canvas tools', exact: true })).toHaveAttribute('aria-orientation', 'vertical')
  expect((await dock.boundingBox())!.height).toBeLessThan(390)
  expect((await page.getByRole('button', { name: 'Draw — P' }).boundingBox())!.width).toBeGreaterThanOrEqual(32)
  const select = page.getByRole('button', { name: 'Select — V', exact: true })
  const hand = page.getByRole('button', { name: 'Hand — H', exact: true })
  await expect(select).toHaveCSS('background-color', 'rgb(65, 65, 65)')
  await hand.hover()
  await expect(hand).toHaveCSS('background-color', 'rgb(56, 56, 56)')
  await expect(select).toHaveCSS('background-color', 'rgb(65, 65, 65)')
  await hand.click()
  await page.mouse.move(700, 200)
  await expect(hand).toHaveAttribute('aria-pressed', 'true')
  await expect(select).toHaveAttribute('aria-pressed', 'false')
  await expect(hand).toHaveCSS('background-color', 'rgb(65, 65, 65)')
  await hand.press('Tab')
  const draw = page.getByRole('button', { name: 'Draw — P', exact: true })
  await draw.press('Space')
  await expect(draw).toHaveAttribute('aria-pressed', 'true')
  await expect(draw).toBeFocused()
  await expect(draw).toHaveCSS('background-color', 'rgb(80, 80, 80)')
  await expect(draw).toHaveCSS('color', 'rgb(245, 245, 245)')
  await expect(draw).toHaveCSS('box-shadow', 'none')
  await page.getByRole('button', { name: 'Shapes and more tools' }).click()
  await expect(page.locator('.tool-palette')).toHaveAttribute('data-side', 'right')
  const palette = (await page.locator('.tool-palette').boundingBox())!
  expect(palette.x).toBeGreaterThanOrEqual((await dock.boundingBox())!.x + (await dock.boundingBox())!.width + 8)
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click()
  await page.mouse.move(360, 250); await page.mouse.down(); await page.mouse.move(560, 400, { steps: 12 }); await page.mouse.up()
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Drawing style' }).click()
  await expect(page.getByRole('slider', { name: 'Stroke width' })).toBeVisible()
  await page.getByRole('button', { name: 'Stroke Clay', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Stroke color value', exact: true })).toHaveValue('#b65f46')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Shapes and more tools' }).click()
  await expect(page.getByRole('button', { name: 'Erase — E', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Arrow', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.mouse.click(450, 300, { button: 'right' })
  await expect(page.locator('.context-menu')).toBeVisible()
  const contextItem = page.locator('.context-menu-item').first()
  await contextItem.hover()
  await expect(contextItem).toHaveCSS('background-color', 'rgb(238, 238, 238)')
  expect((await contextItem.boundingBox())!.height).toBeGreaterThanOrEqual(32)
  expect((await contextItem.boundingBox())!.height).toBeLessThanOrEqual(40)
  // The adapter must outweigh the engine's own stylesheet: these values come
  // from Galta's tokens, not from Excalidraw's defaults.
  await expect(page.locator('.context-menu')).toHaveCSS('border-radius', '12px')
  expect(await page.locator('.context-menu .context-menu-item').last().evaluate(el =>
    getComputedStyle(el).paddingInlineStart), 'menu rows share one inset').toBe('12px')
  const lastAction = page.locator('.context-menu-item').last()
  await lastAction.scrollIntoViewIfNeeded()
  expect(await lastAction.evaluate(el => {
    const r = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
  }), 'the composer must not cover the end of the native context menu').toBe(true)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Switch conversation', exact: true }).click()
  await expect(page.getByRole('menuitemradio', { name: /^New conversation(?: Draft)?$/, exact: true })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Collapse conversation', exact: true }).click()
  await page.getByRole('button', { name: /^Model GPT/ }).click()
  await expect(page.getByRole('radiogroup', { name: 'Model', exact: true })).toBeVisible()
  await expect(page.getByRole('menu', { name: 'Switch conversation' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Export canvas', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /^Model GPT/ })).toBeFocused()
  for (const width of [980, 620, 480, 360]) {
    await page.setViewportSize({ width, height: 850 })
    await expect.poll(() => page.locator('.galta-shell').evaluate(e => Number.parseFloat((e as HTMLElement).style.getPropertyValue('--header-height')) === e.querySelector('.galta-topbar')!.getBoundingClientRect().height)).toBe(true)
    await expect(page.locator('.excalidraw .App-toolbar-container:visible')).toHaveCount(0)
    await expect(page.locator('.excalidraw .App-bottom-bar:visible')).toHaveCount(0)
    for (const selector of ['.composer-footer', '.conversation-composer', '.drawing-dock', '.viewport-control']) {
      const box = (await page.locator(selector).boundingBox())!
      expect(box.x, `${selector} left at ${width}`).toBeGreaterThanOrEqual(selector === '.drawing-dock' ? 0 : 8)
      expect(box.x + box.width, `${selector} right at ${width}`).toBeLessThanOrEqual(selector === '.drawing-dock' ? width : width - 8)
    }
    const composer = (await page.locator('.conversation-composer').boundingBox())!, tools = (await dock.boundingBox())!
    expect(tools.x, 'the floating toolbar sits close to the editor left edge').toBe(8)
    expect(tools.width).toBe(40)
    expect(tools.y).toBeGreaterThanOrEqual((await page.locator('.galta-topbar').boundingBox())!.height + 16)
    expect(tools.x + tools.width <= composer.x || tools.y + tools.height + 8 <= composer.y, 'tools and composer remain separate').toBe(true)
    await page.getByRole('textbox', { name: 'Ask Galta' }).fill('One line\nTwo lines\nThree lines\nFour lines\nFive lines')
    const multilineComposer = (await page.locator('.conversation-composer').boundingBox())!, multilineTools = (await dock.boundingBox())!
    expect(multilineTools.x).toBe(8)
    expect(multilineTools.x + multilineTools.width <= multilineComposer.x || multilineTools.y + multilineTools.height + 8 <= multilineComposer.y, 'growing the draft does not cover the left toolbar').toBe(true)
    expect(multilineComposer.y + multilineComposer.height).toBeCloseTo(850, 0)
    await page.getByRole('textbox', { name: 'Ask Galta' }).fill('')
  }
})

for (const touch of [false, true]) test.describe(touch ? 'Touch canvas chrome' : 'Mouse canvas chrome', () => {
  test.use({ hasTouch: touch })
  test('document history and view controls remain directly reachable with a long canvas name', async ({ page }) => {
    await installReturningAccount(page)
    await page.setViewportSize({ width: 360, height: 540 })
    await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
    const documentGroup = page.getByRole('group', { name: 'Current canvas', exact: true })
    const applicationGroup = page.getByRole('group', { name: 'Galta and collection', exact: true })
    const viewGroup = page.getByRole('group', { name: 'Canvas view controls', exact: true })
    await expect(documentGroup.getByRole('button', { name: 'Open Time Machine', exact: true })).toBeEnabled()
    await expect(viewGroup.getByRole('button', { name: 'Open Time Machine', exact: true })).toHaveCount(0)
    await documentGroup.getByRole('button', { name: 'Canvas menu', exact: true }).click()
    await page.getByRole('button', { name: 'Current canvas actions', exact: true }).click()
    await page.getByRole('button', { name: 'Rename canvas', exact: true }).click()
    await page.getByRole('textbox', { name: 'Canvas name', exact: true }).fill('A long canvas name that still leaves every action available')
    await page.getByRole('button', { name: 'Save canvas name', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.workspace-menu')).toHaveCount(0)
    for (const width of [360, 480, 620, 1440]) {
      await page.setViewportSize({ width, height: 750 })
      await expect(applicationGroup.locator('.galta-brand-name')).toHaveText('Galta')
      await expect(applicationGroup.locator('.galta-brand-name')).toBeVisible()
      await expect(applicationGroup.getByRole('button', { name: 'Collection', exact: true }).getByText('Collection', { exact: true })).toBeVisible()
      expect((await applicationGroup.locator('.galta-brand-mark').boundingBox())!.x, 'the mark has a balanced edge inset at every width').toBe(32)
      const boxes = []
      for (const name of ['Collection', 'Canvas menu', 'Open Time Machine', 'Canvas zoom', 'Expand canvas']) {
        const button = page.getByRole('button', { name, exact: true })
        const box = (await button.boundingBox())!
        expect(box.width, name).toBeGreaterThanOrEqual(touch ? 44 : 32)
        expect(box.height, name).toBeGreaterThanOrEqual(touch ? 44 : 32)
        expect(box.x, name).toBeGreaterThanOrEqual(16)
        expect(box.x + box.width, name).toBeLessThanOrEqual(width - 16)
        expect(await button.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
        }), `${name} receives pointer input`).toBe(true)
        boxes.push(box)
      }
      for (let i = 1; i < boxes.length; i++) {
        const current = boxes[i]!, previous = boxes[i - 1]!
        if (current.y === previous.y) expect(current.x).toBeGreaterThanOrEqual(previous.x + previous.width)
        else expect(current.y).toBeGreaterThanOrEqual(previous.y + previous.height)
      }
    }
    await page.getByRole('button', { name: 'Open Time Machine', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Time Machine', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Close Time Machine', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open Time Machine', exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Canvas zoom', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Fit canvas', exact: true })).toBeVisible()
    let previousRight = 0
    for (const name of ['Zoom out', 'Fit canvas', 'Zoom in']) {
      const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(touch ? 44 : 32)
      expect(box.height).toBeGreaterThanOrEqual(touch ? 44 : 32)
      expect(box.x).toBeGreaterThanOrEqual(previousRight)
      previousRight = box.x + box.width
    }
    await page.setViewportSize({ width: 360, height: 750 })
    for (let step = 0; step < 11; step++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await expect(page.locator('.viewport-value')).toHaveText('500%')
    await page.keyboard.press('Escape')
    const highZoomBoxes = []
    for (const name of ['Collection', 'Canvas menu', 'Open Time Machine', 'Canvas zoom', 'Expand canvas']) {
      const button = page.getByRole('button', { name, exact: true }), box = (await button.boundingBox())!
      expect(box.width, name).toBeGreaterThanOrEqual(touch ? 44 : 32)
      expect(box.x + box.width, name).toBeLessThanOrEqual(344)
      expect(await button.evaluate(element => {
        const rect = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
      }), `${name} receives input at a high zoom level`).toBe(true)
      highZoomBoxes.push(box)
    }
    for (let i = 1; i < highZoomBoxes.length; i++) {
      const current = highZoomBoxes[i]!, previous = highZoomBoxes[i - 1]!
      if (current.y === previous.y) expect(current.x).toBeGreaterThanOrEqual(previous.x + previous.width)
      else expect(current.y).toBeGreaterThanOrEqual(previous.y + previous.height)
    }
  })
})

test('canvas chrome communicates hover, open and keyboard focus through its surface', async ({ page }) => {
  await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  const zoom = page.getByRole('button', { name: 'Canvas zoom', exact: true })
  await zoom.hover()
  await expect(zoom).toHaveCSS('background-color', 'rgb(238, 238, 238)')
  await zoom.click()
  await expect(zoom).toHaveAttribute('data-state', 'open')
  await page.mouse.move(700, 200)
  await expect(zoom).toHaveCSS('background-color', 'rgb(229, 229, 229)')
  await page.keyboard.press('Escape')
  for (const name of ['Collection', 'Canvas menu', 'Open Time Machine', 'Canvas zoom', 'Expand canvas']) {
    const button = page.getByRole('button', { name, exact: true })
    await button.focus()
    await expect(button).toBeFocused()
    await expect(button).toHaveCSS('background-color', 'rgb(222, 222, 222)')
    await expect(button).toHaveCSS('box-shadow', 'none')
  }
  await page.emulateMedia({ forcedColors: 'active' })
  await zoom.focus()
  await expect(zoom).toHaveCSS('outline-style', 'solid')
  await expect(zoom).toHaveCSS('outline-width', '2px')
})

test('small chrome backings preserve text contrast over dark and patterned canvas images', async ({ page }) => {
  await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  for (const kind of ['dark', 'pattern']) {
    const fill = kind === 'dark' ? '#101010' : 'url(#pattern)'
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="2000"><defs><pattern id="pattern" width="48" height="48" patternUnits="userSpaceOnUse"><rect width="48" height="48" fill="#101010"/><path d="M0 0h24v24H0zM24 24h24v24H24z" fill="#ffffff"/></pattern></defs><rect width="3000" height="2000" fill="${fill}"/></svg>`
    await page.locator('nav input[type=file]').setInputFiles({ name: `${kind}.svg`, mimeType: 'image/svg+xml', buffer: Buffer.from(svg) })
    const count = kind === 'dark' ? 1 : 2
    await expect(page.getByRole('region', { name: `Galta canvas, ${count} objects`, exact: true })).toBeVisible()
    await expect(page.locator('.pending-image')).toHaveCount(0)
    await expect.poll(async () => {
      const saved = await storedWorkspace(page)
      return saved.snapshots[saved.project.headCommitId].document.elements.length
    }).toBe(count)
    const bundle = await storedWorkspace(page), head = bundle.project.headCommitId
    bundle.snapshots[head].document.elements = [bundle.snapshots[head].document.elements.at(-1)]
    Object.assign(bundle.snapshots[head].document.elements[0], { x: -1000, y: -1000, width: 4000, height: 3000 })
    bundle.canvasView = { commitId: head, scrollX: 0, scrollY: 0, zoom: 1 }
    await page.goto(`${acceptanceOrigin}/manifest.json`)
    await seedWorkspace(page, bundle)
    await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
    await expect(page.locator('canvas.static')).toBeVisible()
    await expect.poll(() => page.locator('canvas.static').evaluate((canvas: HTMLCanvasElement) => {
      const scale = canvas.width / canvas.getBoundingClientRect().width
      const pixels = canvas.getContext('2d')!.getImageData(20 * scale, 20 * scale, 120 * scale, 28 * scale).data
      let darkest = 255
      for (let i = 0; i < pixels.length; i += 4) darkest = Math.min(darkest, pixels[i]!)
      return darkest
    }), 'the imported artwork actually extends under the chrome').toBeLessThan(32)
    const surfaces = await page.locator('.galta-topbar').evaluate(header => {
      const rgba = (color: string) => {
        const channels = color.match(/[\d.]+/g)!.map(Number)
        return color.startsWith('color(srgb') ? [...channels.slice(0, 3).map(c => c * 255), channels[3] ?? 1] : channels
      }
      const luminance = (rgb: number[]) => rgb.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i]!, 0)
      return [...header.querySelectorAll('.galta-brand, .collection-control, .galta-document, .viewport-control, .canvas-presentation-control')].map(surface => {
        const style = getComputedStyle(surface), backing = rgba(style.backgroundColor)
        // Black is the lower bound for any image, including a blurred pattern.
        // Compose its alpha before measuring; raw backing RGB overstates contrast.
        const effective = backing.slice(0, 3).map(c => c * (backing[3] ?? 1))
        const text = rgba(getComputedStyle(surface.querySelector('button, .galta-brand-name')!).color).slice(0, 3)
        const ink = luminance(text), paper = luminance(effective)
        return { contrast: (paper + .05) / (ink + .05), alpha: backing[3], filter: style.backdropFilter, shadow: style.boxShadow, border: style.borderTopWidth }
      })
    })
    expect(surfaces).toHaveLength(5)
    for (const surface of surfaces) {
      expect(surface.contrast).toBeGreaterThanOrEqual(4.5)
      expect(surface.alpha).toBeLessThan(1)
      expect(surface.filter).toBe('blur(14px)')
      expect(surface.shadow).toBe('none')
      expect(surface.border).toBe('0px')
    }
  }
})

for (const touch of [false, true]) test.describe(touch ? 'Touch toolbar' : 'Mouse toolbar', () => {
test.use({ hasTouch: touch })
test('short left toolbar keeps every control reachable beside a multiline draft', async ({ page }) => {
  await installReturningAccount(page)
  await page.setViewportSize({ width: 360, height: 540 })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Keep the warm light.\nPreserve the materials.\nKeep the varied shapes.\nArrange a quieter composition.\nLeave room around each object.')
  const tools = page.locator('.drawing-tools')
  await expect(page.locator('.drawing-dock')).toHaveAttribute('data-overflow', 'true')
  await expect.poll(() => tools.evaluate(e => e.scrollHeight > e.clientHeight && e.scrollWidth <= e.clientWidth)).toBe(true)
  await expect.poll(async () => {
    const dock = (await page.locator('.drawing-dock').boundingBox())!, composer = (await page.locator('.conversation-composer').boundingBox())!
    return dock.y + dock.height + 8 <= composer.y
  }, 'the dock follows the measured height after the multiline draft grows').toBe(true)
  const toolDock = (await page.locator('.drawing-dock').boundingBox())!, composer = (await page.locator('.conversation-composer').boundingBox())!
  expect(toolDock.x).toBe(8)
  expect(toolDock.width).toBe(touch ? 52 : 40)
  expect(toolDock.y + toolDock.height + 8).toBeLessThanOrEqual(composer.y)
  for (const button of await tools.locator('button').all()) {
    await button.scrollIntoViewIfNeeded()
    await expect.poll(() => button.evaluate(element => {
      const r = element.getBoundingClientRect(), container = element.closest('.drawing-tools')!.getBoundingClientRect()
      return r.top >= container.top && r.bottom <= container.bottom && r.left >= container.left && r.right <= container.right && element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    })).toBe(true)
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(touch ? 44 : 32)
  }
  await page.getByRole('button', { name: 'Draw — P', exact: true }).click()
  await page.getByRole('button', { name: 'Drawing style', exact: true }).click()
  await expect(page.getByRole('slider', { name: 'Stroke width', exact: true })).toBeVisible()
  await expect(page.locator('.drawing-style-panel')).toHaveAttribute('data-side', 'right')
  const style = (await page.locator('.drawing-style-panel').boundingBox())!
  expect(style.x).toBeGreaterThanOrEqual(toolDock.x + toolDock.width + 8)
  expect(style.x + style.width).toBeLessThanOrEqual(360 - 8)
  await page.keyboard.press('Escape')
  await expect.poll(() => tools.evaluate(element => {
    const bounds = element.getBoundingClientRect(), inset = Number.parseFloat(getComputedStyle(element).paddingTop)
    return [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect())
      .filter(rect => rect.bottom > bounds.top + inset + 1 && rect.top < bounds.bottom - inset - 1)
      .every(rect => rect.top >= bounds.top + inset - 1 && rect.bottom <= bounds.bottom - inset + 1)
  }), 'the scrolled toolbar shows complete button rows').toBe(true)
  // A wide but short window must also reserve a multiline composer when its
  // attachment moves all the way to the same edge as the drawing dock.
  await page.setViewportSize({ width: 1440, height: 500 })
  const handle = page.getByRole('slider', { name: 'Move composer', exact: true })
  await handle.focus()
  await page.keyboard.press('Home')
  await expect.poll(async () => {
    const dock = (await page.locator('.drawing-dock').boundingBox())!, composer = (await page.locator('.conversation-composer').boundingBox())!
    return dock.x === 8 && dock.y + dock.height + 8 <= composer.y
  }, 'the left dock also clears a composer moved to the left in a wide, short window').toBe(true)
})
})

test('the element capsule shares Glass and control targets with floating menus', async ({ page }) => {
  await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.getByRole('button', { name: 'Shapes and more tools' }).click()
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click()
  await page.mouse.move(360, 250); await page.mouse.down(); await page.mouse.move(560, 400, { steps: 12 }); await page.mouse.up()
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await page.locator('.excalidraw').focus()
  await page.keyboard.press('Meta+a')
  await expect(page.locator('.selection-actions')).toBeVisible()
  const controlFaces = await page.locator('.selection-actions').evaluate(element => {
    const face = (node: Element) => {
      const style = getComputedStyle(node)
      return { radius: style.borderTopLeftRadius, height: Number.parseFloat(style.height), shadow: style.boxShadow, wash: style.backgroundImage, filter: style.backdropFilter, edge: style.borderTopColor, z: style.zIndex }
    }
    return { bar: face(element), button: face(element.querySelector('button')!), anchorZ: getComputedStyle(element.parentElement!).zIndex }
  })
  expect(controlFaces.bar.radius, 'selected-element actions form a capsule').toBe('999px')
  expect(controlFaces.bar.height, 'the toolbar is one compact row plus its own border, not a fourth control size').toBeLessThanOrEqual(44)
  expect(controlFaces.button.height, 'the toolbar sits on the compact control target').toBe(32)
  // The capsule is a full Glass face (docs/design/tokens.md); only its popovers use the quieter selection elevation.
  expect(controlFaces.bar.shadow, 'the capsule carries the shared Glass elevation')
    .toContain('rgba(25, 25, 25, 0.13) 0px 12px 34px 0px')
  expect(controlFaces.bar.wash, 'the toolbar carries the directional Glass wash').toContain('linear-gradient')
  expect(controlFaces.bar.filter, 'one backdrop belongs to the toolbar surface').not.toBe('none')
  expect(controlFaces.anchorZ, 'the toolbar sits in the context-actions layer, below every menu').toBe('1400')
  await page.getByRole('button', { name: 'More selection actions', exact: true }).click()
  const menuFaces = await page.locator('.selection-menu').evaluate(element => {
    const style = getComputedStyle(element)
    const item = element.querySelector('button')!
    return { radius: style.borderTopLeftRadius, shadow: style.boxShadow, wash: style.backgroundImage, filter: style.backdropFilter, edge: style.borderTopColor, z: Number(style.zIndex), itemHeight: Number.parseFloat(getComputedStyle(item).height) }
  })
  expect(menuFaces.radius, 'the popover menu matches the native context menu radius').toBe('12px')
  expect(menuFaces.itemHeight).toBe(32)
  for (const property of ['wash', 'filter'] as const) expect(menuFaces[property], `the toolbar and its menu share the Glass ${property}`).toBe(controlFaces.bar[property])
  expect(menuFaces.shadow, 'the popover sits close to the artwork with the quieter selection elevation')
    .toContain('rgba(0, 0, 0, 0.04) 0px 12px 32px 0px')
  expect(menuFaces.z, 'portalled menus sit above every working surface').toBe(20000)
  expect(menuFaces.z, 'and above the toolbar that opened them').toBeGreaterThan(Number(controlFaces.anchorZ))
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.locator('.selection-menu')).toHaveCount(0)
  // The attached surfaces are a silhouette, so their corner is only observable
  // through the path. Its turn reaches `radius / .6` from each outer corner, and
  // the token it turns with is the same one the expanded reading surface uses.
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  const attached = await page.evaluate(() => {
    const value = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    const path = document.querySelector('.dock-surface-bottom .dock-surface-fill')!
    const start = Number(path.getAttribute('d')!.match(/^M (-?[\d.]+)/)![1])
    const sheet = document.querySelector('.conversation-sheet')!
    return { token: value('--radius-dock'), start: Math.abs(start), sheetRadius: getComputedStyle(sheet).borderTopLeftRadius }
  })
  expect(attached.token, 'one token owns the attached corner').toBe('8px')
  expect(attached.start, 'the composer turn is that radius over the fixed turn ratio').toBeCloseTo(8 / .6, 1)
  expect(attached.sheetRadius, 'the reading surface it joins uses the same radius').toBe(attached.token)
})

test('workspace actions and connection recovery open in their owning surfaces', async ({ page }) => {
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Export canvas', exact: true })).toHaveCount(0)
  const actions = page.getByRole('button', { name: 'Current canvas actions', exact: true })
  await actions.click()
  await expect(page.getByRole('button', { name: 'Export canvas', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import canvas', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(actions).toBeFocused()
  await expect(page.getByRole('dialog', { name: 'Canvases', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Canvas menu', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Canvas menu', exact: true }).click()
  await actions.click()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Canvas menu', exact: true })).toBeFocused()
  await expect(page.getByRole('button', { name: 'Open conversation', exact: true })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveCount(0)
  await page.locator('.conversation-dock').getByRole('button', { name: 'Connect an agent', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Work in Codex or Claude Code', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.conversation-dock').getByRole('button', { name: 'Connect an agent', exact: true })).toBeFocused()
  await expect(page.locator('.conversation-title')).toHaveCount(0)
})

test('conversation expands from the composer and stopping remains available while collapsed', async ({ page }) => {
  await page.goto('/dev/conversation-test.html')
  const idle = (await page.locator('.conversation-dock').boundingBox())!
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Keep the composition. Give it softer morning light.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByRole('button', { name: 'Collapse conversation', exact: true })).toBeVisible()
  // The sheet rises from the composer, so the dock grows over the motion.
  await expect.poll(async () => (await page.locator('.conversation-dock').boundingBox())!.height).toBeGreaterThan(idle.height)
  await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toHaveAttribute('placeholder', 'Ask Galta…')
  await expect(page.locator('.composer-footer .composer-progress')).toHaveCount(1)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.composer-footer .working-dot')).toHaveCSS('animation-name', 'none')
  await expect(page.getByRole('button', { name: 'Stop generation' })).toBeVisible()
  await expect(page.locator('.conversation-peek')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Collapse conversation', exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Switch conversation', exact: true })).toBeEnabled()
  const process = page.locator('.conversation-process').first()
  await process.getByRole('button', { name: 'Execution details', exact: true }).click()
  await expect(page.locator('.conversation-commentary')).toContainText('soften the light around the entrance')
  await expect(page.locator('.conversation-presence')).not.toHaveCSS('background-image', 'none')
  await expect(page.locator('.conversation-user')).not.toHaveCSS('background-image', 'none')
  // A step with nothing more to show is a plain line, not a control.
  await expect(page.locator('.conversation-activity-line').filter({ hasText: 'Viewed the canvas' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Viewed the canvas', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Collapse conversation', exact: true }).first().click()
  await expect(page.locator('.conversation-sheet')).toHaveCount(0)
  await page.getByRole('button', { name: 'Stop generation' }).click()
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Show task progress' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Open conversation' }).click()
  await expect(page.locator('.conversation-status')).toContainText('Stopped')
})

for (const transport of ['legacy', 'mcp']) test(`a running ${transport} canvas call is named by its verb, in its segment and as its own line`, async ({ page }) => {
  await page.goto(`/dev/conversation-test.html?canvas=1${transport === 'mcp' ? '&mcp=1' : ''}`)
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Soften the light around the entrance.')
  await page.getByRole('button', { name: 'Send message' }).click()
  // The copy comes from the reported tool name. Rewording the item label must
  // not silently degrade this to 'Working on the canvas'.
  await expect(page.getByRole('button', { name: 'Collapse conversation', exact: true })).toBeVisible()
  const process = page.locator('.conversation-process').last()
  await expect(process.locator('.conversation-status-change')).toContainText('Updating the canvas')
  await process.getByRole('button', { name: 'Execution details', exact: true }).click()
  // Until it reports an effect the call has nothing more to show, so it is a
  // named line within the segment, not a disclosure of its own.
  await expect(process.locator('.conversation-activity-line').filter({ hasText: 'Updating the canvas' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Updating the canvas', exact: true })).toHaveCount(0)
})

test('running and long conversation controls remain reachable on narrow screens and touch', async ({ browser, baseURL }) => {
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 360, height: 540 }, hasTouch: touch, reducedMotion: 'reduce' })
    const page = await context.newPage()
    await page.goto(`${baseURL}/dev/conversation-test.html?long=1&long-title=1`)
    const idle = (await page.locator('.conversation-dock').boundingBox())!
    await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Soften the light.')
    await page.getByRole('button', { name: 'Send message' }).click()
    // Legacy prose is process history too; open its parent when this fixture
    // intentionally exercises a long reading surface.
    await page.locator('[data-turn-id=previous]').getByRole('button', { name: 'Execution details', exact: true }).click()
    expect((await page.locator('.conversation-dock').boundingBox())!.height).toBeGreaterThan(idle.height)
    for (const selector of ['.composer-conversation', '.runtime-model', '.composer-submit']) {
      expect(await page.locator(selector).evaluate((e, min) => {
        const r = e.getBoundingClientRect()
        return r.width >= min && r.height >= min && r.left >= 0 && r.right <= innerWidth && (e.matches(':disabled') || e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)))
      }, touch ? 44 : selector === '.composer-submit' ? 40 : 32), selector).toBe(true)
    }
    await page.getByRole('textbox', { name: 'Ask Galta' }).fill('Keep this next instruction.\nPreserve the materials.')
    await expect(page.locator('.conversation-scroll')).toHaveJSProperty('scrollLeft', 0)
    expect(await page.locator('.conversation-scroll').evaluate(e => e.scrollHeight > e.clientHeight && e.scrollWidth === e.clientWidth)).toBe(true)
    const open = (await page.locator('.conversation-dock').boundingBox())!
    expect(open.y).toBeGreaterThanOrEqual(92)
    expect(open.y + open.height).toBe(540)
    await page.locator('.conversation-scroll').evaluate(e => { e.scrollTop = 0 })
    const primary = await page.locator('.conversation-header-primary').boundingBox()
    const actions = await page.locator('.conversation-header-actions').boundingBox()
    expect(primary).not.toBeNull()
    expect(actions).not.toBeNull()
    expect(primary!.x + primary!.width).toBeLessThanOrEqual(actions!.x)
    await expect(page.locator('.conversation-header-actions')).toHaveCSS('border-left-width', '0px')
    await expect(page.locator('.conversation-session-actions')).toHaveCSS('border-left-width', '0px')
    await expect(page.locator('.conversation-requests .request-label')).toBeHidden()
    await expect(page.getByRole('link', { name: 'Reference', exact: true })).toHaveAttribute('href', 'https://example.com/reference')
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toHaveValue('')
    await page.getByRole('button', { name: 'Stop generation' }).click()
    await page.getByRole('button', { name: 'Collapse conversation', exact: true }).first().click()
    await page.getByRole('button', { name: /^Model GPT/ }).click()
    const model = page.getByRole('radiogroup', { name: 'Model', exact: true })
    await expect(model.getByRole('radio').first()).toBeFocused()
    expect((await model.locator('label').first().boundingBox())!.height).toBeGreaterThanOrEqual(touch ? 44 : 32)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: /^Model GPT/ })).toBeFocused()
    await context.close()
  }
})
