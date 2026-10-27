import { test, expect } from '@playwright/test'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'

test('production tool keys match Galta and numeric aliases cannot switch tools', async ({ page }) => {
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  const canvas = page.locator('.excalidraw')
  for (const [key, label] of [['v', 'Select — V'], ['h', 'Hand — H'], ['t', 'Text — T'], ['e', 'Erase — E'], ['p', 'Draw — P']]) {
    await canvas.focus(); await page.keyboard.press(key!)
    await expect(page.getByRole('button', { name: label!, exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: label!, exact: true })).toHaveAttribute('aria-keyshortcuts', key!.toUpperCase())
  }
  for (const key of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Numpad0', 'Numpad2', 'x', 'k', 'q']) {
    await page.keyboard.press(key)
    await expect(page.getByRole('button', { name: 'Draw — P', exact: true })).toHaveAttribute('aria-pressed', 'true')
  }
  for (const [key, label] of [['r', 'Rectangle'], ['d', 'Diamond'], ['o', 'Ellipse'], ['a', 'Arrow'], ['l', 'Line'], ['f', 'Frame']]) {
    await canvas.focus(); await page.keyboard.press(key!)
    await page.getByRole('button', { name: 'Shapes and more tools', exact: true }).click()
    const choice = page.getByRole('button', { name: label!, exact: true })
    await expect(choice).toHaveAttribute('aria-pressed', 'true')
    await expect(choice).toHaveAttribute('aria-keyshortcuts', key!.toUpperCase())
    await page.keyboard.press('Escape')
  }
  await canvas.focus(); await page.keyboard.press('Meta+-')
  await expect(page.getByRole('button', { name: 'Canvas zoom', exact: true })).not.toHaveText('100%')
  await page.keyboard.press('Meta+0')
  await expect(page.getByRole('button', { name: 'Canvas zoom', exact: true })).toHaveText('100%')
})

test('engine UI shortcuts and IME keystrokes cannot enter hidden modes', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).scene))
  await page.evaluate(() => (window as any).scene.api.setActiveTool({ type: 'freedraw' }))
  const canvas = page.locator('.excalidraw')
  const state = () => page.evaluate(() => {
    const s = (window as any).scene.api.getAppState()
    return { tool: s.activeTool, popup: s.openPopup, dialog: s.openDialog, sidebar: s.openSidebar, view: s.viewModeEnabled, zen: s.zenModeEnabled, stats: s.showStats, snap: s.objectsSnapModeEnabled }
  })
  const before = await state()
  for (const key of ['x', 'k', 'q', 's', 'g', 'i', 'Shift+f', 'Shift+s', 'Shift+g', '?', 'Alt+z', 'Alt+r', 'Alt+s', 'Alt+/', 'Meta+Shift+e', 'Meta+Shift+s', 'Meta+Shift+p', 'Meta+/', 'Meta+f', 'Meta+Backspace']) {
    await canvas.focus(); await page.keyboard.press(key)
    await expect.poll(state, key).toEqual(before)
  }
  await canvas.dispatchEvent('keydown', { key: 't', code: 'KeyT', isComposing: true, keyCode: 229, bubbles: true })
  await expect.poll(state).toEqual(before)
})

test('text editing, form entry, undo and global shortcut isolation survive in production', async ({ page }) => {
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.getByRole('button', { name: 'Text — T', exact: true }).click()
  await page.mouse.click(450, 240)
  const text = page.locator('.excalidraw-wysiwyg')
  await text.pressSequentially('0123456789 qxkgsi?')
  await expect(text).toHaveValue('0123456789 qxkgsi?')
  await text.press('Escape')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  const canvas = page.locator('.excalidraw')
  await canvas.focus(); await page.keyboard.press('Meta+z')
  await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  await page.keyboard.press('Meta+Shift+z')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  for (const key of ['Meta+/', 'Meta+Shift+p', '?', 'Meta+Shift+e']) {
    await canvas.focus(); await page.keyboard.press(key)
    // Native style pickers stay mounted even while closed.
    await expect(page.locator('.excalidraw [role=dialog]:not(.color-picker-container):not(.FontPicker__container)')).toHaveCount(0)
    await expect(page.locator('.command-palette')).toHaveCount(0)
  }
  await page.getByRole('button', { name: 'Drawing style', exact: true }).click()
  const size = page.getByRole('spinbutton', { name: 'Font size', exact: true })
  await size.fill(''); await size.pressSequentially('123')
  await expect(size).toHaveValue('123')
  await size.press('Meta+/')
  await expect(page.getByRole('dialog', { name: 'Drawing style', exact: true })).toBeVisible()
  await expect(page.locator('.command-palette')).toHaveCount(0)
  await size.press('Escape')
  await expect(size).toHaveValue('20')
})
