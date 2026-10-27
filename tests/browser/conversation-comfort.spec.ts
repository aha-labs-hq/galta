import { test, expect } from '@playwright/test'
import type { CreativeConversationTurn } from '@galta/storage'

const workingTurn = (): CreativeConversationTurn => ({
  id: 'comfort', instruction: '保留原来的构图，让入口的光线更柔和。', status: 'streaming', startedAt: Date.now(),
  steering: [{ id: 'followup', text: '也保留玻璃原本的质感。', createdAt: Date.now(), afterItemId: 'commentary' }],
  items: [
    { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: '我会先看光线与材质的关系，再调整入口附近的亮度。' },
    { id: 'reasoning', type: 'reasoning', text: 'Thinking', details: '## 光线与材质\n\n保留玻璃上的细微反射，让明暗过渡更自然。', status: 'completed' },
    { id: 'capture', type: 'mcpToolCall', server: 'galta', tool: 'canvas_capture', text: 'Canvas receipt: revision 12', status: 'completed' },
    { id: 'answer', type: 'agentMessage', phase: 'final_answer', status: 'inProgress', text: '入口的光线现在更柔和了。\n\n保留了建筑的轮廓、玻璃的反射和石材的细节，只调整了入口附近的明暗关系。\n\n- 构图与比例保持一致。\n- 玻璃依然清透，有自然的反光。' }
  ]
})

for (const width of [1000, 360]) test(`conversation has a readable dialogue and reachable controls at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 860 })
  await page.goto('/dev/conversation-test.html')
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), workingTurn())
  await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
  const turn = page.locator('[data-turn-id=comfort]')
  await turn.getByRole('button', { name: 'Execution details', exact: true }).first().click()
  await expect(turn.locator('.conversation-commentary')).toHaveCount(1)
  await expect(turn.locator('.conversation-process')).toHaveCount(2)
  const order = await turn.evaluate(element => [...element.children].filter(child => child.matches('.conversation-user, .conversation-process, .conversation-commentary, .conversation-reply')).map(child => child.className.split(' ')[0]))
  expect(order).toEqual(['conversation-user', 'conversation-process', 'conversation-user', 'conversation-process', 'conversation-reply'])
  await expect(turn.locator('.conversation-process-message[data-message-id=commentary]')).toContainText('我会先看')
  await expect(turn.locator('.conversation-process-message[data-message-id=commentary] button')).toHaveCount(0)
  await expect(turn).not.toContainText('Steered')
  const input = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  await expect(input).toHaveAttribute('placeholder', 'Ask Galta…')
  await expect(page.locator('.conversation-dock .dock-surface-fill')).toHaveCSS('fill', 'rgb(36, 36, 36)')
  await input.fill('再少一点高光，保持自然。')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
  // Steering is a transport detail. A drafted follow-up keeps the ordinary
  // Send message affordance instead of exposing a second user-facing mode.
  await expect(page.getByRole('button', { name: 'Steer message', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: info.outputPath(`working-${width}.png`), animations: 'disabled' })
  await input.press('Enter')
  await expect(turn.locator('.conversation-followup')).toHaveCount(2)
  await expect(turn.locator('.conversation-followup').last()).toHaveText('You: 再少一点高光，保持自然。')
  await expect(input).toHaveValue('')
  await page.evaluate(() => (window as any).__conversationTest.finish(400))
  const details = turn.getByRole('button', { name: 'Execution details', exact: true })
  await expect(details).toHaveCount(2)
  await expect(details.first()).toContainText('Shared an update')
  await expect(details.last()).toContainText('Looked at the canvas')
  await expect(details.last()).toContainText('<1s')
  await page.screenshot({ path: info.outputPath(`completed-${width}.png`), animations: 'disabled' })
  const process = turn.locator('.conversation-process').last()
  await details.last().click()
  await expect(process).toHaveAttribute('data-state', 'open')
  await process.getByRole('button', { name: 'Thought through the next step', exact: true }).click()
  await expect(turn.locator('.conversation-reasoning h2')).toHaveText('光线与材质')
  await expect(turn.locator('.conversation-reasoning pre')).toHaveCount(0)
  await expect(input).toBeInViewport({ ratio: 1 })
  expect(await page.locator('.conversation-scroll').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath(`details-${width}.png`), animations: 'disabled' })
})

test('high contrast retains message boundaries and keyboard focus', async ({ page }) => {
  await page.emulateMedia({ contrast: 'more', reducedMotion: 'reduce' })
  await page.goto('/dev/conversation-test.html')
  await page.evaluate(turn => (window as any).__conversationTest.set({ ...turn, status: 'completed' }), workingTurn())
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect(page.locator('.conversation-presence')).toHaveCSS('backdrop-filter', 'none')
  await page.getByRole('button', { name: 'Execution details', exact: true }).first().focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Execution details', exact: true }).first()).toHaveAttribute('aria-expanded', 'true')
  await page.emulateMedia({ forcedColors: 'active' })
  await expect(page.locator('.conversation-user').first()).toHaveCSS('border-top-style', 'solid')
})

test('a running process block rolls its latest internal state without changing its frame', async ({ page }) => {
  await page.goto('/dev/conversation-test.html')
  const initial = { id: 'ticker', instruction: '检查当前画布。', status: 'streaming', items: [{ id: 'command', type: 'commandExecution', text: 'pwd', status: 'inProgress' }] }
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), initial)
  await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
  const trigger = page.getByRole('button', { name: 'Execution details', exact: true })
  await expect(trigger).toContainText('Running a command')
  const describedBy = await trigger.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText('Running a command')
  await page.locator('.conversation-presence').evaluate(element => element.getAnimations().forEach(animation => animation.finish()))
  const before = await page.locator('.conversation-process-trigger').boundingBox()
  const updated = { ...initial, items: [{ ...initial.items[0], status: 'completed' }] }
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), updated)
  await expect(trigger).toContainText('Ran a command')
  await expect.poll(() => page.locator('.conversation-status-track[data-rolling=true]').count()).toBe(1)
  const motion = await page.locator('.conversation-status-track[data-rolling=true]').evaluate(element => {
    const oldLine = element.querySelector<HTMLElement>('.conversation-status-line:first-child')!
    const newLine = element.querySelector<HTMLElement>('.conversation-status-line:last-child')!
    return {
      oldAnimation: getComputedStyle(oldLine).animationName,
      newAnimation: getComputedStyle(newLine).animationName,
      duration: getComputedStyle(newLine).animationDuration,
      oldFilter: getComputedStyle(oldLine).filter,
      newFilter: getComputedStyle(newLine).filter
    }
  })
  expect(Number.parseFloat(motion.duration)).toBeCloseTo(.44, 2)
  expect(motion.oldAnimation).toBe('conversation-status-shimmer-out')
  expect(motion.newAnimation).toBe('conversation-status-shimmer-in')
  expect(motion.oldFilter).not.toBe('none')
  expect(motion.newFilter).not.toBe('none')
  const after = await page.locator('.conversation-process-trigger').boundingBox()
  expect(after?.height).toBe(before?.height)
  expect(after?.width).toBe(before?.width)
})

test('the collapsed status follows the final answer after a tool completes', async ({ page }) => {
  await page.goto('/dev/conversation-test.html')
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), {
    id: 'final-answer-status',
    instruction: '检查并总结当前画布。',
    status: 'streaming',
    items: [
      { id: 'tool', type: 'commandExecution', text: 'pwd', status: 'inProgress' },
      { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '结果正在整理。', status: 'inProgress' }
    ]
  })
  // The closed status speaks the answer itself, not the step that preceded it.
  await expect(page.locator('.composer-conversation .conversation-title')).toHaveText('结果正在整理。')
  await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
  const process = page.locator('.conversation-process')
  await expect(process.getByRole('button', { name: 'Execution details', exact: true })).toContainText('Ran a command')
  await process.getByRole('button', { name: 'Execution details', exact: true }).click()
  await expect(process.locator('.conversation-text-shimmer')).toHaveCount(0)
})

test('an empty final answer announces writing while its first delta is pending', async ({ page }) => {
  await page.goto('/dev/conversation-test.html')
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), {
    id: 'empty-final-answer', instruction: '检查并总结当前画布。', status: 'streaming',
    items: [
      { id: 'tool', type: 'commandExecution', text: 'pwd', status: 'completed' },
      { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '', status: 'inProgress' }
    ]
  })
  await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Writing a response')
  await expect(page.locator('.conversation-process')).toContainText('Ran a command')
})

for (const width of [1000, 360]) test(`process status, step count and duration stay adjacent on one baseline at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 860 })
  await page.goto('/dev/conversation-test.html')
  const turn = {
    id: 'baseline', instruction: '检查当前画布。', status: 'streaming', startedAt: Date.now(),
    items: [{ id: 'command', type: 'commandExecution', text: 'pwd', status: 'inProgress' }]
  }
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), turn)
  await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
  const meta = page.locator('.conversation-process-meta')
  await page.locator('.conversation-presence').evaluate(element => element.getAnimations().forEach(animation => animation.finish()))
  await expect(meta).toHaveCSS('align-items', 'baseline')
  await expect(meta.locator('.conversation-status-viewport')).toHaveCSS('line-height', '16px')
  await expect(meta.locator('.conversation-process-count').first()).toHaveCSS('line-height', '16px')
  const boxes = await meta.evaluate(element => {
    const status = element.querySelector<HTMLElement>('.conversation-status-viewport')!.getBoundingClientRect()
    const count = element.querySelector<HTMLElement>('.conversation-process-count')!.getBoundingClientRect()
    return { statusBottom: status.bottom, countBottom: count.bottom, gap: count.left - status.right }
  })
  expect(Math.abs(boxes.statusBottom - boxes.countBottom)).toBeLessThanOrEqual(1)
  expect(boxes.gap).toBeCloseTo(4, 0)
  // A shorter replacement owns its width immediately; the hidden previous
  // label cannot leave an empty gap before the metadata.
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), { ...turn, status: 'completed', completedAt: turn.startedAt + 8000, items: turn.items.map(item => ({ ...item, status: 'completed' })) })
  await expect(meta.locator('.conversation-status-line:last-child')).toHaveText('Ran a command')
  await expect(meta.locator('.conversation-process-count').last()).toHaveText('· 8s')
  const replacement = await meta.evaluate(element => {
    const status = element.querySelector<HTMLElement>('.conversation-status-viewport')!.getBoundingClientRect()
    const count = element.querySelector<HTMLElement>('.conversation-process-count')!.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(element.querySelector('.conversation-status-line:last-child')!)
    return { gap: count.left - range.getBoundingClientRect().right, statusWidth: status.width }
  })
  expect(replacement.gap).toBeCloseTo(4, 0)
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), { ...turn, status: 'completed', completedAt: turn.startedAt + 8000, items: [{ id: 'first', type: 'commandExecution', text: 'pwd', status: 'completed' }, { id: 'second', type: 'commandExecution', text: 'pwd', status: 'completed' }, { id: 'reasoning', type: 'reasoning', text: 'Thinking', status: 'completed' }] })
  await expect(meta.locator('.conversation-status-line:last-child')).toHaveText('Thought through the next step')
  await expect(meta.locator('.conversation-process-count').first()).toHaveText('· 3 steps')
  await expect(meta.locator('.conversation-process-count').last()).toHaveText('· 8s')
  await expect(meta.locator('.conversation-process-count').last()).toBeInViewport({ ratio: 1 })
  expect(await page.locator('.conversation-scroll').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.locator('.conversation-presence').evaluate(element => element.getAnimations().forEach(animation => animation.finish()))
  await meta.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.finish()))
  await page.screenshot({ path: info.outputPath(`metadata-${width}.png`), animations: 'disabled' })
})

test('only the current activity receives the live shimmer', async ({ page }) => {
  await page.goto('/dev/conversation-test.html')
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), {
    id: 'active-shimmer', instruction: '检查当前画布。', status: 'streaming', startedAt: Date.now(),
    items: [
      { id: 'done', type: 'commandExecution', text: 'pwd', status: 'completed' },
      { id: 'active', type: 'commandExecution', text: 'rg --files', status: 'inProgress' }
    ]
  })
  await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
  await page.getByRole('button', { name: 'Execution details', exact: true }).click()
  await expect(page.locator('.conversation-activity')).toHaveCount(2)
  await expect(page.locator('.conversation-activity .conversation-text-shimmer')).toHaveCount(1)
  await expect(page.locator('.conversation-activity').first().locator('.conversation-text-shimmer')).toHaveCount(0)
  await expect(page.locator('.conversation-activity').last().locator('.conversation-text-shimmer')).toHaveText('Running a command')
})

test('finished process segments stay still while later work and the final reply stream', async ({ page }, info) => {
  await page.goto('/dev/conversation-test.html')
  const initial: CreativeConversationTurn = {
    id: 'segment-status', instruction: 'Check the light and preserve the glass.', status: 'streaming',
    steering: [{ id: 'followup', text: 'Keep the original reflections.', createdAt: 1, afterItemId: 'command' }],
    items: [
      { id: 'command', type: 'commandExecution', text: 'pwd', status: 'completed' },
      { id: 'thinking', type: 'reasoning', text: 'Thinking', status: 'inProgress' }
    ]
  }
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), initial)
  await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
  const processes = page.locator('.conversation-process')
  await expect(processes).toHaveCount(2)
  await page.screenshot({ path: info.outputPath('segmented-work.png'), animations: 'disabled' })
  await expect(processes.first().locator('.working-dot, .conversation-text-shimmer')).toHaveCount(0)
  await expect(processes.last().locator('.working-dot')).toHaveCount(1)
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), {
    ...initial,
    items: [...initial.items.map(item => ({ ...item, status: 'completed' })),
      { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'The light is balanced.', status: 'inProgress' }]
  })
  await expect(page.locator('.conversation-reply')).toContainText('The light is balanced.')
  await expect(processes.locator('.working-dot, .conversation-text-shimmer')).toHaveCount(0)
})

test('switching sessions resets disclosures even when restored item IDs repeat', async ({ page }, info) => {
  await page.goto('/dev/conversation-test.html')
  const turn: CreativeConversationTurn = {
    id: 'restored-turn', instruction: 'Check the current canvas.', status: 'completed',
    items: [
      { id: 'item-0', type: 'commandExecution', text: 'pwd', output: '/tmp/creative', status: 'completed' },
      { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: 'The canvas is ready.', status: 'completed' }
    ]
  }
  await page.evaluate(turn => (window as any).__conversationTest.selectSession('first-session', turn), turn)
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  const process = page.getByRole('button', { name: 'Execution details', exact: true })
  await process.click()
  await page.getByRole('button', { name: 'Ran a command', exact: true }).click()
  await expect(page.locator('.conversation-activity pre')).toContainText('/tmp/creative')
  await page.evaluate(turn => (window as any).__conversationTest.selectSession('second-session', turn), turn)
  await expect(page.locator('.session-current-label')).toHaveText('second-session')
  await page.screenshot({ path: info.outputPath('switched-session.png'), animations: 'disabled' })
  await expect(process).toHaveAttribute('aria-expanded', 'false')
  await process.click()
  await expect(page.getByRole('button', { name: 'Ran a command', exact: true })).toHaveAttribute('aria-expanded', 'false')
})

test('collapsing from the keyboard returns focus to the composer conversation entry', async ({ page }) => {
  await page.goto('/dev/conversation-test.html')
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Collapse conversation', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.conversation-sheet')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open conversation', exact: true })).toBeFocused()
})

test('activity status replacement keeps one line and uses the same handoff motion', async ({ page }) => {
  await page.goto('/dev/conversation-test.html')
  const initial = { id: 'activity-replacement', instruction: '检查当前画布。', status: 'streaming', items: [{ id: 'command', type: 'commandExecution', text: 'pwd', status: 'inProgress' }] }
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), initial)
  await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
  await page.getByRole('button', { name: 'Execution details', exact: true }).click()
  const activity = page.locator('.conversation-activity').last()
  const before = await activity.locator('.conversation-status-viewport').boundingBox()
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), { ...initial, items: [{ ...initial.items[0], status: 'completed' }] })
  const track = activity.locator('.conversation-status-track[data-rolling=true]')
  await expect(track).toHaveCount(1)
  await expect(activity).toContainText('Ran a command')
  await expect(activity.locator('.conversation-status-viewport')).not.toHaveAttribute('aria-live')
  const motion = await track.evaluate(element => {
    const next = element.querySelector<HTMLElement>('.conversation-status-line:last-child')!
    return { animation: getComputedStyle(next).animationName, filter: getComputedStyle(next).filter }
  })
  expect(motion.animation).toBe('conversation-status-shimmer-in')
  expect(motion.filter).not.toBe('none')
  expect((await activity.locator('.conversation-status-viewport').boundingBox())?.height).toBe(before?.height)
})

test('status text shimmers once on entry and replacement without replaying for streamed output', async ({ page }, info) => {
  await page.setViewportSize({ width: 1000, height: 860 })
  await page.goto('/dev/conversation-test.html')
  const initial = { id: 'shimmer', instruction: '检查当前画布。', status: 'streaming', items: [{ id: 'command', type: 'commandExecution', text: 'pwd', status: 'inProgress' }] }
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), initial)
  const footer = page.locator('.composer-conversation .conversation-text-shimmer')
  await expect(footer).toHaveText('Running a command')
  const darkColor = await footer.evaluate(element => getComputedStyle(element).color)
  expect(darkColor).not.toBe('rgba(0, 0, 0, 0)')
  const footerMotion = await footer.evaluate(element => {
    const animation = element.getAnimations().find(item => (item as CSSAnimation).animationName === 'conversation-text-shimmer-in')!
    const duration = Number(animation.effect?.getTiming().duration)
    animation.pause(); animation.currentTime = duration / 2
    const style = getComputedStyle(element)
    return { name: (animation as CSSAnimation).animationName, duration, iterations: animation.effect?.getTiming().iterations, filter: style.filter, opacity: Number(style.opacity) }
  })
  expect(footerMotion.name).toBe('conversation-text-shimmer-in')
  expect(footerMotion.duration).toBe(440)
  expect(footerMotion.iterations).toBe(1)
  expect(footerMotion.filter).toContain('blur(')
  expect(footerMotion.opacity).toBeGreaterThan(0)
  expect(footerMotion.opacity).toBeLessThan(1)
  await page.screenshot({ path: info.outputPath('shimmer-composer.png') })
  await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
  await page.locator('.conversation-presence').evaluate(element => element.getAnimations().forEach(animation => animation.finish()))
  const line = page.locator('.conversation-status-line.conversation-text-shimmer')
  await expect(line).toHaveText('Running a command')
  const initialLine = await line.elementHandle()
  const entry = await line.evaluate(element => {
    const animation = element.getAnimations().find(item => (item as CSSAnimation).animationName === 'conversation-text-shimmer-in')!
    const duration = Number(animation.effect?.getTiming().duration)
    animation.pause(); animation.currentTime = duration / 2
    const style = getComputedStyle(element)
    return { duration, iterations: animation.effect?.getTiming().iterations, baseColor: style.color, filter: style.filter, transform: style.transform }
  })
  expect(entry.duration).toBe(440)
  expect(entry.iterations).toBe(1)
  expect(entry.baseColor).not.toBe('rgba(0, 0, 0, 0)')
  expect(entry.filter).toContain('blur(')
  expect(entry.transform).not.toBe('none')
  const before = await line.boundingBox()
  await page.screenshot({ path: info.outputPath('shimmer-entry.png') })
  await line.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.finish()))
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), { ...initial, items: [{ ...initial.items[0], output: '/tmp/creative' }] })
  await expect(line).toHaveText('Running a command')
  expect(await line.evaluate((element, previous) => element === previous, initialLine)).toBe(true)
  expect(await line.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' || animation.playState === 'paused').length)).toBe(0)

  await page.evaluate(turn => (window as any).__conversationTest.set(turn), { ...initial, items: [{ ...initial.items[0], status: 'completed' }] })
  const replacementLine = page.locator('.conversation-status-line:last-child')
  await expect(replacementLine).toHaveText('Ran a command')
  expect(await replacementLine.evaluate((element, previous) => element === previous, initialLine)).toBe(false)
  const replacement = await page.locator('.conversation-status-track').evaluate(element => {
    const oldLine = element.querySelector<HTMLElement>('.conversation-status-line:first-child')!
    const newLine = element.querySelector<HTMLElement>('.conversation-status-line:last-child')!
    return { oldName: getComputedStyle(oldLine).animationName, newName: getComputedStyle(newLine).animationName, newText: newLine.textContent }
  })
  expect(replacement).toEqual({ oldName: 'conversation-status-shimmer-out', newName: 'conversation-status-shimmer-in', newText: 'Ran a command' })
  await expect(page.locator('.conversation-status-viewport > .sr-only')).toHaveText('Ran a command')
  await page.screenshot({ path: info.outputPath('shimmer-replacement.png') })
  expect((await replacementLine.boundingBox())?.height).toBe(before?.height)
  await page.locator('.conversation-status-track').evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.finish()))
  await page.screenshot({ path: info.outputPath('shimmer-rest.png') })

  await page.setViewportSize({ width: 360, height: 860 })
  const longLabel = '正在检查画布中每个对象的几何关系与细节。'.repeat(8)
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), { ...initial, items: [{ id: 'command', type: 'dynamicToolCall', tool: 'fixture', text: longLabel, status: 'inProgress' }] })
  const narrowLine = page.locator('.conversation-status-line:last-child')
  await expect(narrowLine).toHaveText(longLabel)
  expect(await narrowLine.evaluate(element => element.scrollWidth > element.clientWidth && getComputedStyle(element).textOverflow === 'ellipsis')).toBe(true)
  expect(await page.locator('.conversation-scroll').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('shimmer-narrow.png') })
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), { ...initial, items: [{ id: 'command', type: 'reasoning', text: 'Thinking', status: 'inProgress' }] })
  await expect(page.locator('.conversation-status-line:last-child')).toHaveText('Thinking through the next step')
  await expect(page.locator('.conversation-status-viewport > .sr-only')).toHaveText('Thinking through the next step')
})

test('static history and accessibility preferences retain ordinary readable text', async ({ page }) => {
  await page.goto('/dev/conversation-test.html')
  const turn = { id: 'shimmer-preferences', instruction: '检查当前画布。', status: 'completed', items: [{ id: 'command', type: 'commandExecution', text: 'pwd', status: 'completed' }] }
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), turn)
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect(page.locator('.conversation-process .conversation-text-shimmer')).toHaveCount(0)
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), { ...turn, status: 'streaming', items: [{ ...turn.items[0], status: 'inProgress' }] })
  const line = page.locator('.conversation-status-line:last-child')
  await expect(line).toHaveText('Running a command')
  for (const preferences of [{ reducedMotion: 'reduce' as const }, { contrast: 'more' as const }, { forcedColors: 'active' as const }]) {
    await page.emulateMedia({ reducedMotion: 'no-preference', contrast: 'no-preference', forcedColors: 'none', ...preferences })
    expect(await line.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
    expect(await line.evaluate(element => getComputedStyle(element).color)).not.toBe('rgba(0, 0, 0, 0)')
    await expect(line).toBeVisible()
  }
})

test('visible progress prose does not add a duplicate thinking row', async ({ page }) => {
  await page.goto('/dev/conversation-test.html')
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), {
    id: 'commentary-only', instruction: '先检查画布。', status: 'streaming',
    items: [{ id: 'progress', type: 'agentMessage', phase: 'commentary', text: '我先确认当前画布状态。' }]
  })
  await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
  await page.getByRole('button', { name: 'Execution details', exact: true }).click()
  await expect(page.locator('.conversation-process-message')).toContainText('我先确认')
  await expect(page.locator('.conversation-process-message button')).toHaveCount(0)
  await expect(page.locator('.conversation-working')).toHaveCount(0)
})

test('a step with nothing more to show is a line, never a disclosure that opens onto nothing', async ({ page }) => {
  await page.goto('/dev/conversation-test.html')
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), {
    id: 'reasoning-without-summary', instruction: '先检查画布。', status: 'completed',
    items: [{ id: 'thought', type: 'reasoning', text: 'Thinking', status: 'completed' }]
  })
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  // A lone reasoning step without a public summary: the segment is its line.
  await expect(page.locator('.conversation-process')).toContainText('Thought through the next step')
  await expect(page.getByRole('button', { name: 'Execution details', exact: true })).toHaveCount(0)
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), {
    id: 'mixed-steps', instruction: '先检查画布。', status: 'completed',
    items: [
      { id: 'thought', type: 'reasoning', text: 'Thinking', status: 'completed' },
      { id: 'summary', type: 'reasoning', text: 'Thinking', status: 'completed', details: '**Checking the composition**' },
      { id: 'look', type: 'dynamicToolCall', tool: 'canvas_inspect', text: 'Canvas: status', status: 'completed' }
    ]
  })
  await page.getByRole('button', { name: 'Execution details', exact: true }).click()
  const process = page.locator('.conversation-process')
  // Only the summarised step opens; the others are lines in the same column.
  await expect(process.locator('.conversation-activity-line')).toHaveCount(2)
  for (const line of ['Thought through the next step', 'Viewed the canvas']) await expect(process.locator('.conversation-activity-line').filter({ hasText: line })).toHaveCount(1)
  await expect(process.getByRole('button', { name: 'Thought through the next step', exact: true })).toHaveCount(1)
  await expect(process.getByRole('button', { name: 'Viewed the canvas', exact: true })).toHaveCount(0)
  const columns = await process.locator('.conversation-activity .conversation-status-viewport').evaluateAll(labels => labels.map(label => Math.round(label.getBoundingClientRect().left)))
  expect(new Set(columns).size).toBe(1)
  await process.getByRole('button', { name: 'Thought through the next step', exact: true }).click()
  await expect(process.locator('.conversation-activity-details')).toContainText('Checking the composition')
})

test('condensed earlier context is a quiet boundary across the transcript, not a step', async ({ page }) => {
  await page.goto('/dev/conversation-test.html')
  const condensing = (status: string) => ({
    id: 'compaction', instruction: '继续整理画布。', status: status === 'inProgress' ? 'streaming' : 'completed', startedAt: Date.now() - 20000,
    items: [
      { id: 'tool', type: 'commandExecution', text: 'pwd', status: 'completed' },
      { id: 'compact', type: 'contextCompaction', text: 'Condensing earlier context', status },
      ...(status === 'completed' ? [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', status: 'completed', text: '整理好了。' }] : [])
    ]
  })
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), condensing('inProgress'))
  await expect(page.locator('.composer-footer')).toContainText('Condensing earlier context')
  await page.getByRole('button', { name: 'Show task progress', exact: true }).click()
  const boundary = page.locator('.conversation-boundary')
  await expect(boundary).toHaveText('Condensing earlier context')
  await expect(boundary).toHaveAttribute('data-active', 'true')
  // The boundary already says the agent is busy; no second "Thinking" row.
  await expect(page.locator('.conversation-working')).toHaveCount(0)
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), condensing('completed'))
  await expect(boundary).toHaveText('Earlier context condensed')
  await expect(boundary).toHaveAttribute('data-active', 'false')
  await expect(boundary.getByRole('button')).toHaveCount(0)
  // It is not counted among the steps of the work before it.
  await expect(page.locator('.conversation-process').first()).not.toContainText('2 steps')
})

test('response navigation reaches the classified final message after unclassified output', async ({ page }) => {
  await page.goto('/dev/conversation-test.html')
  const turn = workingTurn()
  turn.status = 'completed'
  turn.items.unshift({ id: 'legacy', type: 'agentMessage', text: 'A preserved, unclassified message.' })
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), turn)
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Execution details', exact: true }).first().click()
  await expect(page.locator('[data-message-id=legacy]')).toBeVisible()
  await expect(page.locator('.conversation-process-message[data-message-id=legacy]')).toHaveClass(/conversation-commentary/)
  await expect(page.locator('.conversation-process [data-message-id=legacy]')).toHaveCount(1)
  await page.getByRole('button', { name: 'Browse requests', exact: true }).click()
  await page.getByRole('button', { name: 'Jump to response 1', exact: true }).click()
  await expect(page.locator('[data-message-id=answer]')).toBeFocused()
})
