import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'
import { seedWorkspace, storedWorkspace } from '../helpers/stored-workspace'

const region = { ids: ['placed'], bounds: { x: 2400, y: 1600, width: 320, height: 240 } }
const working = () => ({
  id: 'presence', instruction: 'Place the glass and soften the light.', status: 'streaming', startedAt: Date.now(), items: [
    { id: 'look', type: 'mcpToolCall', server: 'galta', tool: 'canvas_capture', text: 'canvas_capture', status: 'completed' },
    { id: 'say', type: 'agentMessage', phase: 'commentary', status: 'completed', text: 'I will place the **glass** first, then soften the light around it.' },
    { id: 'place', type: 'mcpToolCall', server: 'galta', tool: 'canvas_place', text: 'canvas_place', status: 'completed', canvasChanges: { created: 1, updated: 0, deleted: 0, kind: 'image', region } },
    { id: 'make', type: 'imageGeneration', text: 'image', status: 'inProgress' }]
})
const set = (page: Page, turn: unknown) => page.evaluate(turn => (window as any).__conversationTest.set(turn), turn)
const settle = (page: Page) => page.locator('.conversation-presence').evaluateAll(elements => elements.forEach(element => element.getAnimations().forEach(animation => animation.finish())))

test('the closed composer speaks the agent\'s words a sentence at a time, then its answer until read', async ({ page }) => {
  await page.goto('/dev/conversation-test.html')
  await set(page, working())
  const line = page.locator('.composer-conversation .conversation-title')
  await expect(line).toHaveText('I will place the glass first, then soften the light around it.')
  await expect(line).toHaveAttribute('data-narration', 'true')
  // The composer keeps its height: the words replace the tool name in place.
  await expect(page.locator('.composer-conversation')).not.toContainText('Generating an image')
  const turn = working()
  turn.items.push({ id: 'answer', type: 'agentMessage', phase: 'final_answer', status: 'inProgress', text: 'The glass sits on the left. Its light' } as any)
  await set(page, turn)
  await expect(line).toHaveText('Its light')
  await page.evaluate(() => (window as any).__conversationTest.finish(4000))
  await expect(line).toHaveText('The glass sits on the left.')
  await line.click()
  await expect(page.locator('.conversation-sheet')).toHaveCount(1)
  await expect(line).not.toHaveAttribute('data-narration', 'true')
})

const lightAt = (page: Page) => page.locator('.dock-trace radialGradient').first().evaluate(paint => [Number(paint.getAttribute('cx')), Number(paint.getAttribute('cy'))])

test('the agent light travels the dock\'s outline while it works, and holds still when work ends', async ({ page }) => {
  await page.goto('/dev/conversation-test.html')
  await set(page, working())
  await expect(page.locator('.dock-trace')).toHaveAttribute('data-working', 'true')
  const start = await lightAt(page)
  await expect.poll(() => lightAt(page)).not.toEqual(start)
  // The light is on the dock's edge, or past one of its feet along the
  // bottom, where it rises and sets.
  const [x, y] = await lightAt(page), dock = (await page.locator('.conversation-dock').boundingBox())!
  const [reach, radius] = await page.evaluate(() => ['--agent-light-reach', '--radius-dock'].map(name => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))))
  const beyond = radius / .6 + reach + .5
  expect(x).toBeGreaterThan(-beyond); expect(x).toBeLessThan(dock.width + beyond)
  expect(y).toBeGreaterThan(-.5); expect(y).toBeLessThan(dock.height + .5)
  await page.evaluate(() => (window as any).__conversationTest.finish(4000))
  await expect(page.locator('.dock-trace')).toHaveAttribute('data-working', 'false')
  const held = await lightAt(page)
  await page.waitForTimeout(300)
  expect(await lightAt(page)).toEqual(held)
})

test('without motion, the hairline alone shows the agent at work', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/dev/conversation-test.html')
  const start = await lightAt(page)
  await set(page, working())
  await expect(page.locator('.dock-trace')).toHaveAttribute('data-working', 'true')
  await expect(page.locator('.dock-trace .agent-light-hairline .agent-light-line')).toBeVisible()
  await expect(page.locator('.dock-trace .agent-light-glow')).toBeHidden()
  await page.waitForTimeout(300)
  expect(await lightAt(page)).toEqual(start)
})

test('an arrow points to an out-of-view change, and a change in view is lit in place', async ({ page }) => {
  await page.goto('/dev/conversation-test.html?locate=135')
  await set(page, working())
  const arrow = page.locator('.composer-conversation-slot .agent-locate')
  await expect(arrow).toHaveAttribute('aria-label', 'Show on canvas')
  await expect(arrow.locator('svg')).toHaveCSS('rotate', '135deg')
  await arrow.click()
  expect(await page.evaluate(() => (window as any).__locatorCalls.located)).toEqual([region])
  expect(await page.evaluate(() => (window as any).__locatorCalls.marked)).toEqual([])

  await page.goto('/dev/conversation-test.html?locate=here')
  await set(page, working())
  await expect(page.locator('.composer-conversation .conversation-title')).toHaveAttribute('data-narration', 'true')
  await expect(page.locator('.composer-conversation-slot .agent-locate')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).__locatorCalls.marked)).toEqual([region])
})

test('a canvas step in the conversation takes the reader to the canvas', async ({ page }) => {
  await page.goto('/dev/conversation-test.html?locate=90')
  await set(page, working())
  await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
  await settle(page)
  await page.locator('.conversation-process > button').first().click()
  const row = page.locator('.conversation-activity').filter({ has: page.locator('.agent-locate') })
  await expect(row).toHaveCount(1)
  await row.hover()
  await row.locator('.agent-locate').click()
  expect(await page.evaluate(() => (window as any).__locatorCalls.located)).toEqual([region])
  // Showing a change means going to the canvas: the reading surface settles away.
  await settle(page)
  await expect(page.locator('.conversation-sheet')).toHaveCount(0)
})

test('locating flies the built canvas to the change and lights it', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 820 })
  await installReturningAccount(page)
  const png = readFileSync('tests/fixtures/reference-glass.png')
  await page.route('https://images.test/glass.png', route => route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: png }))
  const url = `${acceptanceOrigin}/sidepanel/index.html`
  await page.goto(url)
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).waitFor()
  await page.locator('.galta-canvas').evaluate(element => {
    const rect = element.getBoundingClientRect(), data = new DataTransfer()
    data.setData('application/x-galta-reference', JSON.stringify({ url: 'https://images.test/glass.png', sourceUrl: 'https://images.test/gallery' }))
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: rect.x + 520, clientY: rect.y + 330, dataTransfer: data }))
  })
  await expect.poll(async () => {
    const workspace: any = await storedWorkspace(page)
    return workspace?.snapshots?.[workspace.project.headCommitId]?.document?.elements?.some((el: any) => el.type === 'image' && !el.isDeleted)
  }, { timeout: 20_000 }).toBe(true)
  const workspace: any = await storedWorkspace(page)
  const image = workspace.snapshots[workspace.project.headCommitId].document.elements.find((el: any) => el.type === 'image' && !el.isDeleted)
  const landed = { ids: [image.id], bounds: { x: image.x, y: image.y, width: image.width, height: image.height } }
  workspace.agentSessions = [{ id: 'presence', label: 'Presence', turns: [{ id: 't', instruction: 'Place the glass.', status: 'completed', startedAt: 1, completedAt: 2, items: [
    { id: 'p', type: 'mcpToolCall', server: 'galta', tool: 'canvas_place', text: 'canvas_place', status: 'completed', canvasChanges: { created: 1, updated: 0, deleted: 0, kind: 'image', region: landed } },
    { id: 'a', type: 'agentMessage', phase: 'final_answer', status: 'completed', text: 'The glass is on the canvas.' }] }] }]
  workspace.runtimeDefaults = { ...workspace.runtimeDefaults, sessionId: 'presence', sessionLabel: 'Presence' }
  await page.goto(`${acceptanceOrigin}/manifest.json`)
  await seedWorkspace(page, workspace)
  await page.goto(url)
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).waitFor()
  // Travel well away from the change, as a reader drawing elsewhere would.
  const canvas = (await page.locator('.galta-canvas').boundingBox())!
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
  for (let i = 0; i < 14; i++) await page.mouse.wheel(1400, 900)
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await page.locator('.conversation-process > button').first().click()
  const row = page.locator('.conversation-activity').filter({ has: page.locator('.agent-locate') })
  await row.hover()
  await expect(row.locator('.agent-locate')).toHaveAttribute('aria-label', 'Show on canvas')
  await row.locator('.agent-locate').click()
  await expect(page.locator('.conversation-sheet')).toHaveCount(0)
  const mark = page.locator('.agent-mark')
  await expect(mark).toHaveCount(1, { timeout: 5_000 })
  const box = (await mark.boundingBox())!, composer = (await page.locator('.conversation-composer').boundingBox())!
  expect(box.x).toBeGreaterThan(canvas.x); expect(box.x + box.width).toBeLessThan(canvas.x + canvas.width)
  expect(box.y).toBeGreaterThan(canvas.y); expect(box.y + box.height).toBeLessThan(composer.y)
  // The light is decoration: it fades away and leaves nothing behind.
  await expect(mark).toHaveCount(0, { timeout: 5_000 })
})
