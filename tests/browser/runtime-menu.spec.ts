import { test, expect } from '@playwright/test'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installCanvasPort, connectCodex } from '../helpers/canvas-port'

test.use({ deviceScaleFactor: 2 })
const longModelName = 'A model with a long display name from a connected agent'

function textContrast(element: Element) {
  const style = getComputedStyle(element)
  const luminance = (color: string) => {
    const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(channel => {
      const value = channel / 255
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
    })
    return r! * .2126 + g! * .7152 + b! * .0722
  }
  const a = luminance(style.color), b = luminance(style.backgroundColor)
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((longName: string) => {
    Object.assign(window, { chrome: { runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      connect: () => ({ onDisconnect: { addListener() {} }, disconnect() {} }),
      sendMessage: async (message: any) => message.type === 'codex-connect'
        ? { ok: true, account: { type: 'chatgpt', planType: 'pro' }, rateLimits: { primary: { usedPercent: 1 } },
          models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].map(id => ({
            id, displayName: id === 'gpt-5.6-terra' ? longName : id.replace('gpt', 'GPT').replace(/-(astra|sol|luna|terra)$/, (_, name: string) => `-${name.charAt(0).toUpperCase()}${name.slice(1)}`),
            isDefault: id === 'gpt-6-sol',
            supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(reasoningEffort => ({ reasoningEffort }))
          })) }
        : { ok: true, result: { thread: { id: 'runtime-menu-fixture', turns: [] } } },
    } } })
  }, longModelName)
  await installCanvasPort(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

test('model settings keep Effort compact and small marks readable on the dark composer', async ({ page }, info) => {
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await connectCodex(page)
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Rename conversation', exact: true }).click()
  await page.getByRole('textbox', { name: 'Conversation name', exact: true }).fill('将手绘篮球升级为真实比赛用球')
  await page.getByRole('button', { name: 'Save conversation name', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Conversation name', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Collapse conversation', exact: true }).click()
  const draft = 'Keep the light soft.'
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill(draft)
  const trigger = page.locator('.runtime-model'), panel = page.locator('.runtime-menu')
  for (const size of [{ width: 1000, height: 800 }, { width: 620, height: 700 }, { width: 360, height: 540 }, { width: 320, height: 540 }]) {
    await page.setViewportSize(size)
    await trigger.click()
    const models = page.getByRole('radiogroup', { name: 'Model', exact: true })
    const effort = panel.getByRole('button', { name: /^Effort / })
    await expect(models.getByRole('radio')).toHaveCount(7)
    await expect(page.getByRole('menu', { name: /^Effort / })).toHaveCount(0)
    await models.getByText('GPT-6-Sol', { exact: true }).click()
    await effort.click()
    const choices = page.getByRole('menu', { name: /^Effort / })
    await expect(choices.getByRole('menuitemradio')).toHaveCount(6)
    await expect(choices.getByRole('menuitemradio', { name: 'Ultra', exact: true })).toBeInViewport({ ratio: 1 })
    await choices.getByRole('menuitemradio', { name: 'Extra high', exact: true }).click()
    await expect(models.getByRole('radio', { name: 'GPT-6-Sol', exact: true })).toBeChecked()
    await expect(choices).toHaveCount(0)
    await expect(panel).toBeVisible()
    await expect(effort).toHaveAccessibleName('Effort Extra high')
    await expect(panel.getByText('GPT-6-Sol', { exact: true })).toHaveCount(1)
    await expect(panel.getByText('Extra high', { exact: true })).toHaveCount(1)
    const grid = await panel.evaluate(element => {
      const textLeft = (selector: string) => {
        const node = element.querySelector(selector)!
        const text = [...node.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) ?? node
        const range = document.createRange(); range.selectNodeContents(text)
        return range.getBoundingClientRect().left
      }
      const center = (selector: string) => { const box = element.querySelector(selector)!.getBoundingClientRect(); return box.x + box.width / 2 }
      const models = element.querySelector('.runtime-model-section')!.getBoundingClientRect()
      const effort = element.querySelector('.runtime-effort-section')!.getBoundingClientRect()
      const footer = element.querySelector('.runtime-account-section')!.getBoundingClientRect()
      return {
        text: ['.runtime-menu-header p', '.runtime-model-name', '.runtime-effort-trigger > span:first-child', '.runtime-account-line'].map(textLeft),
        leading: ['.runtime-model-check', '.runtime-account .runtime-agent-icon'].map(center),
        withinGroup: effort.top - models.bottom + parseFloat(getComputedStyle(element.querySelector('.runtime-model-list')!).paddingBottom), betweenGroups: footer.top - effort.bottom
      }
    })
    expect(Math.max(...grid.text) - Math.min(...grid.text), 'every text row must share its reading column').toBeLessThanOrEqual(1)
    expect(Math.max(...grid.leading) - Math.min(...grid.leading), 'selection and account marks must share their leading gutter').toBeLessThanOrEqual(1)
    expect(grid.withinGroup).toBeGreaterThan(0)
    expect(grid.betweenGroups, 'connection management needs a stronger break than the related model and Effort settings').toBeGreaterThanOrEqual(grid.withinGroup * 2)
    expect(await effort.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element.lastElementChild!)
      const text = range.getBoundingClientRect(), box = element.getBoundingClientRect()
      return text.left >= box.left && text.right <= box.right && box.width >= 32 && box.height >= 32
    }), `the current effort must fit its target at ${size.width}px`).toBe(true)
    // Settings left the model popover for the canvas corner.
    await expect(panel.getByRole('button', { name: 'Connections', exact: true })).toHaveCount(0)
    await expect(effort).toBeInViewport({ ratio: 1 })
    await expect(models.locator('.runtime-agent-icon')).toHaveCount(0)
    await expect(panel.locator('.runtime-menu-header .runtime-agent-icon')).toHaveCount(0)
    await expect(panel.locator('.runtime-menu-status')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Refresh account and usage', exact: true })).toHaveCount(0)
    await expect(panel.locator('.runtime-account .runtime-agent-icon')).toHaveCount(1)
    expect(await panel.locator('.runtime-account .runtime-agent-icon').evaluateAll(elements => elements.every(element => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect()
      return box.width === 14 && box.height === 14 && style.backgroundColor === style.color
    }))).toBe(true)
    const composer = (await page.locator('.conversation-composer').boundingBox())!, menu = (await panel.boundingBox())!
    expect(menu.y).toBeGreaterThanOrEqual(12)
    expect(menu.y + menu.height).toBeLessThanOrEqual(composer.y - 8)
    await page.mouse.move(0, 0)
    await panel.screenshot({ path: info.outputPath(`runtime-menu-${size.width}.png`), animations: 'disabled' })
    await page.screenshot({ path: info.outputPath(`runtime-menu-scene-${size.width}.png`), animations: 'disabled' })
    await models.getByText(longModelName, { exact: true }).click()
    await expect(models.getByRole('radio', { name: longModelName, exact: true })).toBeChecked()
    expect(await models.getByText(longModelName, { exact: true }).evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element)
      const text = range.getBoundingClientRect(), target = element.closest('label')!.getBoundingClientRect()
      return text.left >= target.left && text.right <= target.right + 1 && text.top >= target.top && text.bottom <= target.bottom + 1
    }), `the complete long name must wrap inside its choice at ${size.width}px`).toBe(true)
    // The short sidebar must still expose the last model through its own scroll area.
    await models.getByText('GPT-5.6-Luna', { exact: true }).click()
    await expect(models.getByRole('radio', { name: 'GPT-5.6-Luna', exact: true })).toBeChecked()
    await models.getByText('GPT-6-Sol', { exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
    await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue(draft)
    const input = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
    await input.click()
    await page.mouse.move(0, 0)
    const mark = trigger.locator('.runtime-trigger-model-icon')
    await expect(mark).toBeVisible()
    await expect(mark).toHaveCSS('width', '14px')
    const target = (await trigger.boundingBox())!
    expect(target.width).toBeGreaterThanOrEqual(32)
    expect(target.height).toBeGreaterThanOrEqual(32)
    if (size.width >= 620) {
      await expect(trigger.locator('.runtime-value')).toBeVisible()
      await expect(trigger.locator('.runtime-effort-value')).toHaveText('Extra high')
      expect(await trigger.locator('.runtime-value, .runtime-effort-value').evaluateAll(elements => elements.every(element => {
        const range = document.createRange(); range.selectNodeContents(element)
        const text = range.getBoundingClientRect(), box = element.getBoundingClientRect()
        return element.scrollWidth <= element.clientWidth && text.left >= box.left && text.right <= box.right + 1
      })), `the full model and effort must fit at ${size.width}px`).toBe(true)
    }
    const pixels = await mark.screenshot({ animations: 'disabled' })
    const visibleInk = await page.evaluate(async data => {
      const bitmap = await createImageBitmap(await (await fetch(data)).blob())
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
      const context = canvas.getContext('2d')!
      context.drawImage(bitmap, 0, 0); bitmap.close()
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
      let ink = 0
      for (let i = 0; i < rgba.length; i += 4) if (rgba[i]! > 120 && rgba[i + 1]! > 120 && rgba[i + 2]! > 120) ink++
      return ink
    }, `data:image/png;base64,${pixels.toString('base64')}`)
    expect(visibleInk, 'the dark footer must contain visible light model-mark pixels at every width').toBeGreaterThan(10)
    // The attached SVG extends past the form's layout box. Capture the page
    // with clearance so both bottom shoulders and the top grip remain visible.
    const body = (await page.locator('.conversation-composer').boundingBox())!
    const viewport = page.viewportSize()!
    const x = Math.max(0, body.x - 32), y = Math.max(0, body.y - 20)
    const clip = { x, y, width: Math.min(viewport.width - x, body.width + 64), height: viewport.height - y }
    const outline = (await page.locator('.conversation-dock .dock-surface-fill').boundingBox())!
    expect(outline.x, 'capture the complete left shoulder').toBeGreaterThanOrEqual(clip.x)
    expect(outline.x + outline.width, 'capture the complete right shoulder').toBeLessThanOrEqual(clip.x + clip.width)
    const suffix = size.width === 1000 ? '' : `-${size.width}`
    await page.screenshot({ path: info.outputPath(`runtime-composer-dark${suffix}.png`), clip, animations: 'disabled' })
    await input.fill('')
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
    await page.screenshot({ path: info.outputPath(`runtime-composer-idle${suffix}.png`), clip, animations: 'disabled' })
    await input.fill(draft)
  }
})

test('Glass controls retain keyboard selection, contrast preferences and the settings action', async ({ page }, info) => {
  await page.setViewportSize({ width: 620, height: 700 })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await connectCodex(page)
  const input = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  await input.fill('Keep this draft while choosing a model.')
  const trigger = page.locator('.runtime-model'), panel = page.getByRole('dialog', { name: 'Model settings', exact: true })
  await trigger.click()
  const models = panel.getByRole('radiogroup', { name: 'Model', exact: true })
  const effort = panel.getByRole('button', { name: /^Effort / })
  await models.getByText('GPT-6-Sol', { exact: true }).click()
  await expect(models.getByRole('radio', { name: 'GPT-6-Sol', exact: true })).toBeFocused()
  // Radix defers roving focus. Release the key after that move, rather than
  // sending synthetic keydown/keyup in one instant before its focus callback.
  await page.keyboard.down('ArrowDown')
  await expect(models.getByRole('radio', { name: 'GPT-6-Luna', exact: true })).toBeChecked()
  await page.keyboard.up('ArrowDown')
  await effort.press('ArrowDown')
  const choices = page.getByRole('menu', { name: /^Effort / })
  await expect(choices.getByRole('menuitemradio', { name: 'Low', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(choices.getByRole('menuitemradio', { name: 'Ultra', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(choices).toHaveCount(0)
  await expect(effort).toHaveAccessibleName('Effort Ultra')
  await expect(effort).toBeFocused()
  const contrast = await effort.evaluate(textContrast)
  expect(contrast, 'focused Effort text must remain legible').toBeGreaterThanOrEqual(4.5)
  for (const [role, name, tooltip] of [['meter', 'Usage remaining', '99% remaining in the current usage window']] as const) {
    const action = panel.getByRole(role, { name, exact: true })
    await action.focus()
    expect(await action.evaluate(textContrast), `${name} must remain legible with keyboard focus`).toBeGreaterThanOrEqual(4.5)
    await expect(page.getByRole('tooltip', { name: tooltip, exact: true })).toBeVisible()
    if (role === 'meter') {
      expect(await action.locator('.runtime-usage-label > span').evaluate(element => {
        const ink = getComputedStyle(element).color, parentInk = getComputedStyle(element.closest('[role=meter]')!).color
        return ink === parentInk
      }), 'focused percentage must inherit the legible foreground').toBe(true)
    }
  }
  for (const mode of ['contrast', 'forced-colors'] as const) {
    await page.emulateMedia({ contrast: mode === 'contrast' ? 'more' : 'no-preference', forcedColors: mode === 'forced-colors' ? 'active' : 'none' })
    await expect(panel).toHaveCSS('backdrop-filter', 'none')
    await expect(panel).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await effort.click()
    await expect(choices.getByRole('menuitemradio', { name: 'Ultra', exact: true })).toBeChecked()
    await expect(choices.getByRole('menuitemradio', { name: 'Ultra', exact: true }).locator('svg')).toBeVisible()
    await page.screenshot({ path: info.outputPath(`runtime-menu-${mode}.png`), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(choices).toHaveCount(0)
    await expect(panel).toBeVisible()
    await expect(effort).toBeFocused()
  }
  await effort.click()
  await input.click()
  await expect(choices).toHaveCount(0)
  await expect(panel).toHaveCount(0)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('Keep this draft while choosing a model.')
  await trigger.click()
  // Settings opens in place from the canvas corner, over the canvas, instead of in another tab.
  await page.locator('.settings-corner').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await expect(page.getByRole('dialog').getByRole('button', { name: /^Generation/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(input).toHaveValue('Keep this draft while choosing a model.')
})

test.describe('touch controls', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 360, height: 540 } })
  test('a short touch sidebar keeps full targets and the last model reachable', async ({ page }, info) => {
    await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
    await connectCodex(page)
    await page.locator('.runtime-model').tap()
    const panel = page.getByRole('dialog', { name: 'Model settings', exact: true })
    const models = panel.getByRole('radiogroup', { name: 'Model', exact: true })
    const effort = panel.getByRole('button', { name: /^Effort / })
    expect(await panel.locator('.runtime-model-option, .runtime-effort-trigger').evaluateAll(elements => elements.every(element => {
      const box = element.getBoundingClientRect()
      return box.height >= 44 && box.width >= 44
    }))).toBe(true)
    await effort.tap()
    const choices = page.getByRole('menu', { name: /^Effort / })
    expect(await choices.getByRole('menuitemradio').evaluateAll(elements => elements.every(element => element.getBoundingClientRect().height >= 44))).toBe(true)
    // A short viewport constrains the ordinary menu. Scroll its last option
    // into view rather than requiring six full touch targets to fit at once.
    await choices.getByRole('menuitemradio', { name: 'Ultra', exact: true }).scrollIntoViewIfNeeded()
    await expect(choices.getByRole('menuitemradio', { name: 'Ultra', exact: true })).toBeInViewport({ ratio: 1 })
    await choices.getByRole('menuitemradio', { name: 'Ultra', exact: true }).tap()
    await expect(choices).toHaveCount(0)
    await expect(panel).toBeVisible()
    await expect(effort).toHaveAccessibleName('Effort Ultra')
    await expect(models.getByText('GPT-6.1-Sol', { exact: true })).toBeInViewport({ ratio: 1 })
    expect(await models.getByText('GPT-6.1-Sol', { exact: true }).evaluate(element => {
      const list = element.closest('[role=radiogroup]')!, range = document.createRange()
      range.selectNodeContents(element)
      return range.getBoundingClientRect().top >= list.getBoundingClientRect().top + parseFloat(getComputedStyle(list).paddingTop)
    }), 'the first model name must remain entirely below the fading edge').toBe(true)
    await expect(effort).toBeInViewport({ ratio: 1 })
    await expect(panel.getByRole('meter', { name: 'Usage remaining', exact: true })).toBeInViewport({ ratio: 1 })
    await models.getByText('GPT-5.6-Luna', { exact: true }).tap()
    await expect(models.getByRole('radio', { name: 'GPT-5.6-Luna', exact: true })).toBeChecked()
    expect(await models.getByText('GPT-5.6-Luna', { exact: true }).evaluate(element => {
      const list = element.closest('[role=radiogroup]')!, range = document.createRange()
      range.selectNodeContents(element)
      return range.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom - parseFloat(getComputedStyle(list).paddingBottom)
    }), 'the last model name must remain entirely above the fading edge').toBe(true)
    const menu = (await panel.boundingBox())!, composer = (await page.locator('.conversation-composer').boundingBox())!
    expect(menu.y).toBeGreaterThanOrEqual(12)
    expect(menu.y + menu.height).toBeLessThanOrEqual(composer.y - 8)
    await page.screenshot({ path: info.outputPath('runtime-menu-touch.png'), animations: 'disabled' })
  })
})
