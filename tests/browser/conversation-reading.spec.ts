import { test, expect, type Page } from '@playwright/test'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'
import { seedWorkspace, storedWorkspace } from '../helpers/stored-workspace'

// Inspect an actual intermediate animation frame, rather than just CSS names.
async function pauseMotion(page: Page, trigger: string, selector: string, name: string) {
  return page.evaluate(async ({ trigger, selector, name }) => {
    document.querySelector<HTMLButtonElement>(trigger)!.click()
    for (let frame = 0; frame < 30; frame++) {
      await new Promise(requestAnimationFrame)
      const element = document.querySelector<HTMLElement>(selector)
      // CSS animations carry a name; script-driven motion carries an id.
      const animation = element?.getAnimations().find(animation => (animation as CSSAnimation).animationName === name || animation.id === name)
      if (!element || !animation) continue
      const duration = Number(animation.effect!.getTiming().duration)
      animation.pause(); animation.currentTime = duration / 2
      const style = getComputedStyle(element), keyframes = (animation.effect as KeyframeEffect).getKeyframes()
      return { duration, opacity: Number(style.opacity), height: element.getBoundingClientRect().height,
        from: Number.parseFloat(String(keyframes[0]?.height)), to: Number.parseFloat(String(keyframes.at(-1)?.height)), inert: element.inert }
    }
    throw new Error(`Missing animation: ${name}`)
  }, { trigger, selector, name })
}

async function finishMotion(page: Page, selector: string) {
  await page.locator(selector).evaluate(element => element.getAnimations().forEach(animation => animation.finish()))
}

async function pauseLatestControl(page: Page, latest: boolean) {
  return page.locator('.conversation-scroll').evaluate(async (element, latest) => {
    element.scrollTop = latest ? element.scrollHeight : Math.round((element.scrollHeight - element.clientHeight) / 2)
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
    const control = document.querySelector<HTMLButtonElement>('.conversation-jump-latest')!
    for (let frame = 0; frame < 30; frame++) {
      await new Promise(requestAnimationFrame)
      const animations = control.getAnimations()
      const opacity = animations.find(animation => (animation as CSSTransition).transitionProperty === 'opacity')
      if (!opacity) continue
      const duration = Number(opacity.effect!.getTiming().duration)
      animations.forEach(animation => { animation.pause(); animation.currentTime = duration / 2 })
      const style = getComputedStyle(control)
      return { top: element.scrollTop, height: element.clientHeight, duration, opacity: Number(style.opacity), visibility: style.visibility, inert: control.inert, pointerEvents: style.pointerEvents }
    }
    throw new Error(`Missing latest-control ${latest ? 'exit' : 'entry'} transition: ${JSON.stringify({ visible: control.dataset.visible, opacity: getComputedStyle(control).opacity, visibility: getComputedStyle(control).visibility, transition: getComputedStyle(control).transition, inert: control.inert })}`)
  }, latest)
}

const live = () => ({ id: 'live', instruction: '继续细化，但保持整体轮廓。', status: 'streaming', startedAt: Date.now(), items: [
  { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: 'Comparing spacing and proportions.' },
  { id: 'command', type: 'commandExecution', text: 'review', status: 'completed', output: 'Reviewed proportions' },
  { id: 'reply', type: 'agentMessage', phase: 'final_answer', status: 'inProgress', text: '## 调整结果\n\n' + '共享轮廓保持完整，内部留白更清楚。\n\n'.repeat(20) }
] })

async function openScrollFixture(page: Page) {
  await page.goto('/dev/conversation-test.html')
  const turn = live()
  turn.items[2] = { ...turn.items[2]!, text: turn.items[2]!.text + '\n\n保持材质细节，同时让明暗过渡更加自然。\n\n'.repeat(20) }
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), turn)
  await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
  await finishMotion(page, '.conversation-presence')
  const scroll = page.locator('.conversation-scroll')
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(300)
  await scroll.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll', { bubbles: true })) })
  await expect(page.getByRole('button', { name: 'Back to latest', exact: true })).toBeVisible()
  return scroll
}

for (const surface of ['canvas', 'sidepanel']) test(`the built ${surface} returns to latest through intermediate scroll frames`, { tag: '@serial' }, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await installReturningAccount(page)
  const url = `${acceptanceOrigin}/${surface}/index.html`
  await page.goto(url)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeVisible()
  await expect.poll(async () => Object.keys((await storedWorkspace(page))?.snapshots ?? {}).length).toBeGreaterThan(0)
  const workspace = await storedWorkspace(page)
  const turn = live()
  turn.items[2] = { ...turn.items[2]!, text: turn.items[2]!.text + '\n\n保持材质细节，同时让明暗过渡更加自然。\n\n'.repeat(20) }
  workspace.agentSessions = [{ id: 'scroll-fixture', label: 'Reading conversation', turns: [{ ...turn, status: 'completed' }] }]
  workspace.runtimeDefaults = { ...workspace.runtimeDefaults, sessionId: 'scroll-fixture', sessionLabel: 'Reading conversation' }
  // Unmount the host before changing its durable history.
  await page.goto(`${acceptanceOrigin}/manifest.json`)
  await seedWorkspace(page, workspace)
  await page.goto(url)
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await finishMotion(page, '.conversation-presence')
  const scroll = page.locator('.conversation-scroll')
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(300)
  await scroll.hover()
  await page.mouse.wheel(0, -2000)
  const control = page.getByRole('button', { name: 'Back to latest', exact: true })
  await expect(control).toBeVisible()
  // Start sampling from the real pointer click, including the first frame.
  await control.evaluate(button => {
    button.addEventListener('click', () => {
      const element = document.querySelector<HTMLElement>('.conversation-scroll')!
      const startedAt = performance.now()
      ;(window as any).__returnLatestSamples = (async () => {
        const frames = [{ elapsed: 0, top: element.scrollTop, target: element.scrollHeight - element.clientHeight }]
        for (let frame = 0; frame < 40; frame++) {
          await new Promise(requestAnimationFrame)
          const elapsed = performance.now() - startedAt
          frames.push({ elapsed, top: element.scrollTop, target: element.scrollHeight - element.clientHeight })
          if (elapsed > 600) break
        }
        return frames
      })()
    }, { once: true })
  })
  const token = await scroll.evaluate(element => getComputedStyle(element).getPropertyValue('--motion-scroll').trim())
  await control.click()
  const frames: { elapsed: number; top: number; target: number }[] = await page.evaluate(() => (window as any).__returnLatestSamples)
  await info.attach('built-scroll-frames', { body: JSON.stringify({ token, frames }, null, 2), contentType: 'application/json' })
  expect(frames.filter(frame => frame.top > frames[0]!.top + 1 && frame.target - frame.top > 2).length).toBeGreaterThan(3)
  expect(frames.every((frame, index) => !index || frame.top >= frames[index - 1]!.top)).toBe(true)
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2)
  await expect(scroll).toBeFocused()
  await expect(page.locator('.conversation-jump-latest')).toBeHidden()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await scroll.hover()
  await page.mouse.wheel(0, -2000)
  await expect(control).toBeVisible()
  const remaining = await scroll.evaluate(element => {
    document.querySelector<HTMLButtonElement>('.conversation-jump-latest')!.click()
    return element.scrollHeight - element.clientHeight - element.scrollTop
  })
  expect(remaining).toBeLessThan(2)
})

test.describe('return to latest scrolling', () => {
  test.use({ viewport: { width: 1000, height: 860 } })
  for (const width of [1000, 360]) test(`returning to latest eases through arriving output at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 860 })
    const scroll = await openScrollFixture(page)
    const samples = await page.evaluate(async () => {
      const element = document.querySelector<HTMLElement>('.conversation-scroll')!
      const startedAt = performance.now()
      document.querySelector<HTMLButtonElement>('.conversation-jump-latest')!.click()
      const frames = [{ elapsed: 0, top: element.scrollTop, target: element.scrollHeight - element.clientHeight }]
      let appended = false
      for (let frame = 0; frame < 40; frame++) {
        await new Promise(requestAnimationFrame)
        const elapsed = performance.now() - startedAt
        if (!appended && elapsed >= 80) {
          ;(window as any).__conversationTest.append('\n\n最新输出也加入同一次滚动过渡。\n\n'.repeat(8))
          appended = true
        }
        frames.push({ elapsed, top: element.scrollTop, target: element.scrollHeight - element.clientHeight })
        if (elapsed > 600) break
      }
      return frames
    })
    expect(samples[0]!.top).toBe(0)
    expect(samples.filter(sample => sample.top > 0 && sample.target - sample.top > 2).length).toBeGreaterThan(3)
    expect(samples.every((sample, index) => !index || sample.top >= samples[index - 1]!.top)).toBe(true)
    expect(samples.at(-1)!.target).toBeGreaterThan(samples[0]!.target)
    await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2)
    await expect(scroll).toBeFocused()
    await expect(page.locator('.conversation-jump-latest')).toBeHidden()
    await page.evaluate(() => (window as any).__conversationTest.append('\n\n过渡结束后继续跟随最新输出。\n\n'.repeat(4)))
    await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2)
    await info.attach('scroll-frames', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' })
    await page.screenshot({ path: info.outputPath(`latest-${width}.png`), animations: 'disabled' })
  })
})

for (const gesture of ['wheel', 'pointer', 'keyboard'] as const) test(`a ${gesture} gesture interrupts returning to latest and preserves reading`, async ({ page }) => {
  const scroll = await openScrollFixture(page)
  await page.locator('.conversation-jump-latest').evaluate(element => (element as HTMLButtonElement).click())
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  if (gesture === 'keyboard') await page.keyboard.press('PageUp')
  else {
    await scroll.hover()
    if (gesture === 'wheel') await page.mouse.wheel(0, -120)
    else { await page.mouse.down(); await page.mouse.up() }
  }
  await expect(page.getByRole('button', { name: 'Back to latest', exact: true })).toBeVisible()
  const positions = await scroll.evaluate(async element => {
    const values: number[] = []
    for (let frame = 0; frame < 30; frame++) { await new Promise(requestAnimationFrame); values.push(element.scrollTop) }
    return values
  })
  expect(Math.max(...positions.slice(-10)) - Math.min(...positions.slice(-10))).toBeLessThan(2)
  const top = positions.at(-1)!
  await page.evaluate(() => (window as any).__conversationTest.append('\n\n手动阅读时的新输出不应夺走当前位置。\n\n'.repeat(8)))
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeCloseTo(top, 0)
})

test('reduced motion returns to latest immediately', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const scroll = await openScrollFixture(page)
  const remaining = await scroll.evaluate(element => {
    document.querySelector<HTMLButtonElement>('.conversation-jump-latest')!.click()
    return element.scrollHeight - element.clientHeight - element.scrollTop
  })
  expect(remaining).toBeLessThan(2)
  await expect(page.locator('.conversation-jump-latest')).toBeHidden()
})

test('switching sessions cancels the previous return-to-latest transition', async ({ page }) => {
  const scroll = await openScrollFixture(page)
  await page.locator('.conversation-jump-latest').evaluate(element => (element as HTMLButtonElement).click())
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await page.evaluate(() => (window as any).__conversationTest.selectSession('Another conversation', { id: 'other', instruction: '继续看另一段对话。', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', phase: 'final_answer', text: '这段对话保持自己的阅读位置。' }] }))
  await expect(page.locator('.conversation-reply')).toContainText('这段对话保持自己的阅读位置。')
  const positions = await scroll.evaluate(async element => {
    const values: number[] = []
    for (let frame = 0; frame < 30; frame++) { await new Promise(requestAnimationFrame); values.push(element.scrollTop) }
    return values
  })
  expect(positions.every(top => top === 0)).toBe(true)
  await expect(page.locator('.conversation-jump-latest')).toBeHidden()
})

for (const viewport of [{ width: 1440, height: 900 }, { width: 360, height: 540 }]) {
  test(`a newly sent conversation grows with its response at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await page.goto('/dev/conversation-test.html')
    const input = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
    await input.fill('Keep the response readable as it arrives.')
    await input.press('Enter')
    const sheet = page.locator('.conversation-sheet')
    const scroll = page.locator('.conversation-scroll')
    await expect(sheet).toBeVisible()
    await finishMotion(page, '.conversation-presence')
    const turn = live()
    turn.items = [{ id: 'reply', type: 'agentMessage', phase: 'final_answer', status: 'inProgress', text: 'A growing response.\n\n' }]
    await page.evaluate(turn => (window as any).__conversationTest.set(turn), turn)
    await expect(page.locator('.conversation-reply')).toContainText('A growing response.')
    const initialHeight = (await scroll.boundingBox())!.height
    await page.evaluate(() => (window as any).__conversationTest.append('The new paragraph must have room to read.\n\n'.repeat(40)))
    await expect.poll(async () => (await scroll.boundingBox())!.height).toBeGreaterThan(initialHeight + 100)
    await expect.poll(() => scroll.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThan(2)
    const reading = (await sheet.boundingBox())!
    const composer = (await page.locator('.conversation-composer').boundingBox())!
    expect(reading.y).toBeGreaterThanOrEqual(92)
    expect(reading.height).toBeLessThanOrEqual(Math.min(viewport.height * .72, 720))
    expect(reading.y + reading.height).toBeCloseTo(composer.y, 0)
    await expect(input).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: info.outputPath('growing-response.png'), animations: 'disabled' })
  })

  test(`switching from a long conversation to a short one leaves no gap at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await page.goto('/dev/conversation-test.html')
    const turn = live()
    await page.evaluate(turn => (window as any).__conversationTest.set(turn), turn)
    await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
    await finishMotion(page, '.conversation-presence')
    turn.id = 'short-turn'
    turn.items = [{ id: 'short-reply', type: 'agentMessage', phase: 'final_answer', status: 'inProgress', text: 'A short response in another conversation.' }]
    await page.evaluate(turn => (window as any).__conversationTest.selectSession('Short conversation', turn), turn)
    await expect(page.locator('.conversation-reply')).toContainText('A short response in another conversation.')
    await expect.poll(() => page.evaluate(() => {
      const sheet = document.querySelector('.conversation-sheet')!.getBoundingClientRect()
      const composer = document.querySelector('.conversation-composer')!.getBoundingClientRect()
      return Math.abs(composer.top - sheet.bottom)
    })).toBeLessThan(1)
    await expect.poll(() => page.locator('.conversation-scroll').evaluate(e => e.scrollHeight - e.clientHeight)).toBeLessThan(2)
    await expect(page.locator('.conversation-user')).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: info.outputPath('short-conversation.png'), animations: 'disabled' })
  })
}

test('requests and real responses are directly reachable while execution stays lazy', async ({ page }, info) => {
  await page.setViewportSize({ width: 420, height: 860 })
  await page.goto('/dev/conversation-test.html?rounds=12')
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect(page.locator('.conversation-reply[data-reply=final]')).toHaveCount(12)
  await expect(page.locator('.conversation-activity')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('conversation-420.png'), animations: 'disabled' })
  // Process prose stays in the same folded surface as the work that surrounds
  // it; opening the parent reveals it directly without a second disclosure.
  await expect(page.locator('.conversation-commentary')).toHaveCount(0)
  const firstProcess = page.locator('[data-turn-id=history-0] .conversation-process').first()
  await firstProcess.getByRole('button', { name: 'Execution details', exact: true }).click()
  await expect(firstProcess.locator('.conversation-process-message')).toContainText('I will inspect the proportions before editing.')
  await expect(firstProcess.locator('.conversation-process-message button')).toHaveCount(0)
  await page.getByRole('button', { name: 'Browse requests', exact: true }).click()
  await page.getByRole('textbox', { name: 'Find a request' }).fill('第 3 版')
  await page.screenshot({ path: info.outputPath('requests-420.png'), animations: 'disabled' })
  await page.getByRole('list', { name: 'Requests in this conversation' }).getByRole('button').first().click()
  const third = page.locator('[data-turn-id=history-2]')
  await expect(third).toBeFocused()
  await expect(third.locator('.conversation-user')).toBeInViewport({ ratio: 1 })
  await page.getByRole('button', { name: 'Browse requests', exact: true }).click()
  await page.getByRole('button', { name: 'Jump to response 7', exact: true }).click()
  await expect(page.locator('[data-turn-id=history-6] .conversation-reply')).toBeFocused()
  const process = page.locator('[data-turn-id=history-6]')
  await process.getByRole('button', { name: 'Execution details', exact: true }).click()
  await expect(process.locator('.conversation-activity')).toHaveCount(8)
  await expect(process.getByText('Detailed tool receipt', { exact: true })).toHaveCount(0)
  // Commentary is direct prose inside the process; open the first tool receipt
  // explicitly to keep its details lazy.
  await process.locator('.conversation-activity').first().getByRole('button').click()
  await expect(process.getByText('Detailed tool receipt', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toBeInViewport({ ratio: 1 })
})

test('streaming and completing preserve a reader position, selection, open details and the next draft', async ({ page }) => {
  await page.goto('/dev/conversation-test.html?rounds=12')
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), live())
  await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
  const scroll = page.locator('.conversation-scroll')
  await page.getByRole('button', { name: 'Browse requests', exact: true }).click()
  await page.getByRole('button', { name: 'Jump to response 4', exact: true }).click()
  await page.locator('[data-turn-id=history-3]').getByRole('button', { name: 'Execution details', exact: true }).click()
  await page.getByRole('textbox', { name: 'Ask Galta' }).fill('下一轮请保留材质。\n不要改变轮廓。')
  const top = await scroll.evaluate(element => element.scrollTop)
  await page.locator('[data-turn-id=history-3] .conversation-reply p').first().evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element)
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  })
  const selection = await page.evaluate(() => window.getSelection()!.toString())
  for (let i = 0; i < 15; i++) await page.evaluate(() => (window as any).__conversationTest.append('\n\nNew result.'))
  await page.evaluate(() => (window as any).__conversationTest.finish())
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeCloseTo(top, 0)
  expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selection)
  await expect(page.locator('[data-turn-id=history-3]').getByRole('button', { name: 'Execution details', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('textbox', { name: 'Ask Galta' })).toHaveValue('下一轮请保留材质。\n不要改变轮廓。')
  await page.getByRole('button', { name: 'Collapse conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await finishMotion(page, '.conversation-presence')
  // Reopening retains both the reading position and manually opened details.
  const returnControl = page.getByRole('button', { name: 'Back to latest', exact: true })
  await expect(returnControl).toBeVisible()
  const floatingControl = page.locator('.conversation-jump-latest')
  await expect(returnControl).toHaveText('')
  await expect(floatingControl).toHaveCSS('position', 'absolute')
  const controlGeometry = await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('.conversation-scroll')!.getBoundingClientRect()
    const control = document.querySelector<HTMLElement>('.conversation-jump-latest')!.getBoundingClientRect()
    return { scrollBottom: scroll.bottom, scrollTop: scroll.top, controlTop: control.top, controlBottom: control.bottom, paddingBottom: Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>('.conversation-scroll')!).paddingBottom) }
  })
  expect(controlGeometry.controlTop).toBeGreaterThan(controlGeometry.scrollTop)
  expect(controlGeometry.controlBottom).toBeLessThan(controlGeometry.scrollBottom)
  expect(controlGeometry.paddingBottom).toBeLessThan(32)
  const heightBefore = (await scroll.boundingBox())!.height
  await returnControl.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => scroll.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThan(2)
  await expect(scroll).toBeFocused()
  await expect(floatingControl).toHaveAttribute('inert', '')
  await expect(floatingControl).toHaveCSS('pointer-events', 'none')
  await expect(floatingControl).toBeHidden()
  expect((await scroll.boundingBox())!.height).toBeCloseTo(heightBefore, 0)
  await scroll.evaluate(element => {
    // A scrollbar gesture interrupts any remaining return animation before
    // moving its position; a programmatic scroll assignment has no such intent.
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    element.scrollTop = Math.max(0, element.scrollTop - element.clientHeight)
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await expect(page.getByRole('button', { name: 'Back to latest', exact: true })).toBeVisible()
})

test('scrollbar reading position stays anchored while live output grows', async ({ page }, info) => {
  await page.setViewportSize({ width: 420, height: 700 })
  await page.goto('/dev/conversation-test.html')
  const turn = live()
  turn.items[2] = { ...turn.items[2]!, text: `${turn.items[2]!.text}\n\n${'A readable paragraph keeps its place. '.repeat(80)}` }
  await page.evaluate(value => (window as any).__conversationTest.set(value), turn)
  await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
  await finishMotion(page, '.conversation-presence')
  const scroll = page.locator('.conversation-scroll')
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  const opening = await pauseLatestControl(page, false)
  expect(opening.duration).toBe(140)
  expect(opening.opacity).toBeGreaterThan(0); expect(opening.opacity).toBeLessThan(1)
  expect(opening.inert).toBe(false)
  await page.screenshot({ path: info.outputPath('latest-entry-midpoint.png') })
  await finishMotion(page, '.conversation-jump-latest')
  const top = opening.top
  await expect(page.getByRole('button', { name: 'Back to latest', exact: true })).toBeVisible()
  await page.evaluate(() => (window as any).__conversationTest.append(`\n\n${'A later result must not move the reader. '.repeat(80)}`))
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeCloseTo(top, 0)
  await expect(page.getByRole('button', { name: 'Back to latest', exact: true })).toBeVisible()
  const closing = await pauseLatestControl(page, true)
  expect(closing.duration).toBe(140)
  expect(closing.opacity).toBeGreaterThan(0); expect(closing.opacity).toBeLessThan(1)
  expect(closing.visibility).toBe('visible')
  expect(closing.inert).toBe(true)
  expect(closing.pointerEvents).toBe('none')
  expect(closing.height).toBe(opening.height)
  await page.screenshot({ path: info.outputPath('latest-exit-midpoint.png') })
  await finishMotion(page, '.conversation-jump-latest')
  await expect(page.locator('.conversation-jump-latest')).toBeHidden()
})

test('narrow reading, partial replies, large output and IME remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 540 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/dev/conversation-test.html')
  const turn = live(); turn.status = 'stopped'
  delete (turn.items[2] as any).phase
  turn.items[1] = { ...turn.items[1], status: 'failed', output: 'Failure detail\n'.repeat(20_000) }
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), turn)
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect(page.locator('.conversation-reply')).toHaveCount(0)
  const process = page.locator('.conversation-process')
  await process.getByRole('button', { name: 'Execution details', exact: true }).click()
  await expect(process.locator('.conversation-process-message[data-message-id=reply]')).toHaveClass(/conversation-commentary/)
  await expect(process.locator('.conversation-process-message[data-message-id=reply] button')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Command failed', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Command failed', exact: true }).click()
  expect((await page.locator('.conversation-activity pre').textContent())!.length).toBe(16_000)
  await page.getByRole('button', { name: 'Show more output' }).click()
  expect((await page.locator('.conversation-activity pre').textContent())!.length).toBe(32_000)
  const input = page.getByRole('textbox', { name: 'Ask Galta' })
  await input.fill('中文输入\n第二行\n第三行')
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
  await expect(input).toHaveValue('中文输入\n第二行\n第三行')
  await expect(page.getByRole('button', { name: 'Send message' })).toBeInViewport({ ratio: 1 })
  expect(await page.locator('.conversation-scroll').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true)
  await expect(page.locator('.conversation-presence')).toHaveCSS('animation-duration', '0s')
  await expect(page.locator('.conversation-jump-latest')).toHaveCSS('transition-duration', '0s')
})

test('streamed Markdown retains tables, fences and reference links without mounting remote media or HTML', async ({ page }) => {
  await page.goto('/dev/conversation-test.html')
  const turn = live(); turn.items = [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', status: 'inProgress', text: '**共享' }]
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), turn)
  await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
  await expect(page.locator('.conversation-assistant strong')).toHaveText('共享')
  await page.evaluate(() => (window as any).__conversationTest.append('轮廓**\n\n| 版本 | 结果 |\n| --- | --- |\n| 1 | 清晰 |\n\n```ts\nconst shape = "logo";'))
  await expect(page.locator('.conversation-assistant table')).toContainText('清晰')
  await expect(page.locator('.conversation-assistant pre')).toContainText('const shape')
  await page.evaluate(() => (window as any).__conversationTest.append('\n```\n\n[Reference][ref]\n\n[ref]: https://example.com/reference\n\n![Canvas artwork](https://example.com/private.png)\n\n<img src=x onerror=alert(1)>\n\n[Unsafe](javascript:alert(1))'))
  await page.evaluate(() => (window as any).__conversationTest.finish())
  await expect(page.getByRole('link', { name: 'Reference', exact: true })).toHaveAttribute('href', 'https://example.com/reference')
  await expect(page.locator('.conversation-assistant img, .conversation-assistant script')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Unsafe', exact: true })).toHaveCount(0)
  await expect(page.locator('.conversation-assistant')).toContainText('<img src=x onerror=alert(1)>')
})

test('microinteractions retain exit presence, allow reversal and leave typing immediately available', async ({ page }, info) => {
  await page.setViewportSize({ width: 420, height: 860 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/dev/conversation-test.html?rounds=1')
  const presence = '.conversation-presence', toggle = '.composer-conversation'
  // The sheet slides out of the composer: its height moves while its glass
  // keeps full strength, and its contents hold their height.
  const opening = await pauseMotion(page, toggle, presence, 'unfold-enter')
  expect(opening.duration).toBe(420)
  expect(opening.from).toBe(0)
  expect(opening.height).toBeGreaterThan(0); expect(opening.height).toBeLessThan(opening.to)
  expect(opening.opacity).toBe(1)
  expect(await page.locator('.conversation-sheet').evaluate(sheet => sheet.getBoundingClientRect().height)).toBeCloseTo(opening.to, 0)
  expect(opening.inert).toBe(false)
  await page.screenshot({ path: info.outputPath('opening-midpoint.png') })
  await finishMotion(page, presence)
  const input = page.getByRole('textbox', { name: 'Ask Galta' })
  const before = (await input.boundingBox())!
  const closing = await pauseMotion(page, toggle, presence, 'unfold-exit')
  expect(closing.duration).toBe(280)
  expect(closing.to).toBe(0)
  expect(closing.height).toBeGreaterThan(0); expect(closing.height).toBeLessThan(closing.from)
  expect(closing.opacity).toBe(1)
  expect(closing.inert).toBe(true)
  await expect(page.locator('.conversation-sheet')).toHaveCount(1)
  // The glass must retire with the content. A fading child over an opaque,
  // stationary dock still looks like an instant close when its parent shrinks.
  await expect(page.locator(presence)).toHaveCSS('backdrop-filter', 'blur(28px) saturate(1.12)')
  await expect(page.locator('.conversation-dock')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await page.screenshot({ path: info.outputPath('closing-midpoint.png') })
  expect((await input.boundingBox())!.y).toBeCloseTo(before.y, 0)
  await input.fill('Continue while the panel closes.')
  // Reverse before exit completes. The surface continues from the height on
  // screen instead of restarting, stays mounted, and the draft survives.
  const reversing = await pauseMotion(page, toggle, presence, 'unfold-enter')
  expect(reversing.from).toBeCloseTo(closing.height, 0)
  expect(reversing.to).toBeCloseTo(closing.from, 0)
  await finishMotion(page, presence)
  await expect(page.locator(presence)).not.toHaveAttribute('inert')
  await expect(input).toHaveValue('Continue while the panel closes.')
  const disclosure = '.conversation-process > [data-slot=collapsible-content]'
  const trigger = '.conversation-process > button'
  const disclosing = await pauseMotion(page, trigger, disclosure, 'unfold-enter')
  expect(disclosing.duration).toBe(260)
  expect(disclosing.height).toBeGreaterThan(0); expect(disclosing.height).toBeLessThan(disclosing.to)
  await finishMotion(page, disclosure)
  await expect(page.locator('.conversation-activity')).toHaveCount(8)
  expect((await pauseMotion(page, trigger, disclosure, 'unfold-exit')).inert).toBe(true)
  await expect(page.locator('.conversation-activity')).toHaveCount(8)
  await finishMotion(page, disclosure)
  await expect(page.locator('.conversation-activity')).toHaveCount(0)
  // A disclosure that settled away unfolds from nothing when opened again.
  expect((await pauseMotion(page, trigger, disclosure, 'unfold-enter')).from).toBe(0)
  await finishMotion(page, disclosure)
  await page.locator(trigger).first().click()
  await finishMotion(page, disclosure)
  await expect(page.locator('.conversation-activity')).toHaveCount(0)
  await pauseMotion(page, toggle, presence, 'unfold-exit')
  await finishMotion(page, presence)
  await expect(page.locator('.conversation-sheet')).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect(page.locator(presence)).toHaveCSS('animation-duration', '0s')
  await page.getByRole('button', { name: 'Collapse conversation', exact: true }).click()
  await expect(page.locator('.conversation-sheet')).toHaveCount(0)
})

test('a disclosure opened while following keeps its trigger in place and reveals its steps', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 860 })
  await page.goto('/dev/conversation-test.html?rounds=4')
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await finishMotion(page, '.conversation-presence')
  const scroll = page.locator('.conversation-scroll')
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2)
  // The upper visible process is the case following used to push out of view.
  const trigger = await scroll.evaluate(element => {
    const view = element.getBoundingClientRect()
    const visible = [...element.querySelectorAll<HTMLElement>('.conversation-process > button')].filter(button => button.getBoundingClientRect().top > view.top + 40)
    visible[0]!.dataset.probe = 'true'
    return visible[0]!.getBoundingClientRect().top
  })
  await page.locator('[data-probe=true]').click()
  const disclosure = '[data-probe=true] + [data-slot=collapsible-content]'
  await expect(page.locator(disclosure)).toHaveCount(1)
  await finishMotion(page, disclosure)
  await page.waitForTimeout(100)
  const after = await scroll.evaluate(element => {
    const view = element.getBoundingClientRect(), button = element.querySelector<HTMLElement>('[data-probe=true]')!
    const block = button.parentElement!.getBoundingClientRect()
    return { top: button.getBoundingClientRect().top, viewTop: view.top, viewBottom: view.bottom, blockBottom: block.bottom }
  })
  expect(after.top, 'what the reader pressed never moves down').toBeLessThanOrEqual(trigger + 1)
  expect(after.top, 'and never leaves the top edge').toBeGreaterThanOrEqual(after.viewTop + 11)
  expect(after.blockBottom <= after.viewBottom - 11 || after.top <= after.viewTop + 13, 'the steps show as far as the trigger allows').toBe(true)
  await expect(page.locator('.conversation-activity')).toHaveCount(8)
  await expect(page.getByRole('button', { name: 'Back to latest', exact: true })).toBeVisible()
})

test('a disclosure in a conversation that fits never offers Back to latest', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 860 })
  await page.goto('/dev/conversation-test.html')
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Soften the light.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await finishMotion(page, '.conversation-presence')
  const process = page.locator('.conversation-process').first()
  await process.getByRole('button', { name: 'Execution details', exact: true }).click()
  await finishMotion(page, '.conversation-process > [data-slot=collapsible-content]')
  await expect(process.locator('.conversation-activity').first()).toBeVisible()
  expect(await page.locator('.conversation-scroll').evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThan(24)
  await expect(page.locator('.conversation-jump-latest')).toHaveAttribute('data-visible', 'false')
})
