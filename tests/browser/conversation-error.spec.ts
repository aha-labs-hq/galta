import { test, expect } from '@playwright/test'

const providerError = JSON.stringify({ error: {
  message: 'CC Switch local proxy failed while handling Codex endpoint /responses. Provider: Polyrouter; model: gpt-6-astra; upstream_status: HTTP 400; cause: Upstream request failed',
  type: 'upstream_error', code: 'cc_switch_upstream_error', param: null,
  provider: 'Polyrouter', model: 'gpt-6-astra', endpoint: '/responses', upstream_status: 400
} })

test('a turn that has not reached its boundary offers Stop instead of promising a follow-up', async ({ page }) => {
  await page.goto('/dev/conversation-test.html?starting')
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Keep the entrance soft.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  await expect(page.locator('.conversation-sheet')).toBeVisible()
  // The send action waits for the provider boundary; Stop stays available.
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible()
  await expect(input).toHaveAttribute('placeholder', 'Ask Galta…')
  // A draft submitted in this window must not be consumed: it cannot reach the turn.
  await input.fill('Then widen the doorway.')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await input.press('Enter')
  await expect(input).toHaveValue('Then widen the doorway.')
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible()
})

test('a model retry stays visible after a tool completes and reports recovery, failure or stop accurately', async ({ page }) => {
  for (const [status, label] of [['inProgress', 'Reconnecting to the model'], ['completed', 'Model connection resumed'], ['failed', 'Model retry failed']]) {
    await page.goto(`/dev/conversation-test.html?retry=${status}`)
    await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Continue editing.')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const process = page.locator('.conversation-process').last()
    if (status === 'inProgress') await expect(process.locator('.conversation-process-trigger')).toContainText(label)
    await expect(page.locator('.conversation-sheet')).toBeVisible()
    await process.getByRole('button', { name: 'Execution details', exact: true }).click()
    const activity = process.locator('.conversation-activity').filter({ hasText: label })
    await activity.getByRole('button').click()
    await expect(activity).toContainText('Upstream timed out')
    if (status === 'inProgress') {
      await page.getByRole('button', { name: 'Stop generation', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Model retry stopped', exact: true })).toBeVisible()
    }
  }
})

test('tool records distinguish working, success, failure and stop and preserve the failure reason', async ({ page }) => {
  for (const tool of ['canvas_edit', 'browser_act']) {
    const noun = tool === 'canvas_edit' ? 'Canvas' : 'Webpage'
    const active = tool === 'canvas_edit' ? 'Updating the canvas' : 'Operating the webpage'
    const complete = tool === 'canvas_edit' ? 'Updated the canvas' : 'Operated the webpage'
    for (const status of ['inProgress', 'completed', 'failed']) {
      await page.goto(`/dev/conversation-test.html?canvas&mcp&tool=${tool}&tool-status=${status}`)
      await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Check this state.')
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect(page.locator('.conversation-sheet')).toBeVisible()
      const process = page.locator('.conversation-process').last()
      await process.getByRole('button', { name: 'Execution details', exact: true }).click()
      const activity = process.locator('.conversation-activity').last()
      await expect(activity).toContainText(status === 'inProgress' ? active : status === 'completed' ? complete : `${noun} operation failed`)
      if (status === 'failed') {
        await activity.getByRole('button').click()
        await expect(activity).toContainText('Storage unavailable')
        await expect(activity).not.toContainText(complete)
      }
      if (status === 'inProgress') {
        await page.getByRole('button', { name: 'Stop generation', exact: true }).click()
        await expect(activity).toContainText(`${noun} operation stopped`)
      }
    }
  }
})

test('command exit details show evidence without guessing a failure reason', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 })
  for (const [code, output] of [[1, ''], [2, 'rg: missing: No such file or directory\n'.repeat(50)]] as const) {
    await page.goto(`/dev/conversation-test.html?command-exit=${code}&output=${encodeURIComponent(output)}`)
    await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Find files.')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.locator('.conversation-activity')).toHaveCount(0)
    await expect(page.locator('.conversation-error, [role=alert]')).toHaveCount(0)
    const process = page.locator('.conversation-process').last()
    await process.getByRole('button', { name: 'Execution details', exact: true }).click()
    const activity = process.locator('.conversation-activity').last()
    await expect(activity.getByRole('button')).toHaveAccessibleName(`Command exited with code ${code}`)
    await expect(activity.locator('.conversation-status-line:last-child')).toHaveText(`Command exited with code ${code}`)
    await expect(activity.locator('.text-destructive')).toHaveCount(0)
    await expect(activity.locator('pre')).toHaveCount(0)
    await activity.getByRole('button').focus()
    await page.keyboard.press('Enter')
    await expect(activity).toContainText('rg --files')
    await expect(activity).toContainText('Working directory: /tmp/creative')
    await expect(activity).toContainText(`Exit code: ${code}`)
    await expect(activity).toContainText(output ? 'No such file or directory' : 'No output.')
    await expect(activity).not.toContainText('No error details were provided.')
    expect(await page.locator('.conversation-scroll').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true)
    await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeInViewport({ ratio: 1 })
  }
})

for (const width of [1000, 360]) test(`tool failures stay quiet after completion while a failed request stays visible at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 640 })
  await page.goto('/dev/conversation-test.html?command-exit=1')
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('查询未来一周的天气。')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const completed = {
    id: 'component-fixture', instruction: '查询未来一周的天气。', status: 'completed', startedAt: 1, completedAt: 2001,
    items: [
      { id: 'attempt', type: 'commandExecution', text: "date -j -f '%Y-%m-%d' -v+5d '+%Y-%m-%d %A'", status: 'failed', exitCode: 1, output: 'usage: date [-j] [-f input_fmt] [new_date] [+output_fmt]' },
      { id: 'corrected', type: 'commandExecution', text: "date -v+5d '+%Y-%m-%d %A'", status: 'completed', exitCode: 0, output: '2026-10-04 Sunday' },
      { id: 'answer', type: 'agentMessage', phase: 'final_answer', status: 'completed', text: '已核对未来一周的日期，接下来可以查看天气预报。' }
    ]
  }
  await page.evaluate(turn => (window as any).__conversationTest.set(turn), completed)
  await expect(page.locator('.conversation-reply')).toContainText('已核对未来一周的日期')
  await expect(page.getByRole('button', { name: 'Execution details', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.conversation-activity, .conversation-error, [role=alert]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Collapse conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect(page.locator('.conversation-activity')).toHaveCount(0)
  await page.locator('.conversation-dock').screenshot({ path: info.outputPath('completed-with-tool-attempt.png'), animations: 'disabled' })
  const details = page.getByRole('button', { name: 'Execution details', exact: true })
  await details.focus(); await page.keyboard.press('Enter')
  await expect(page.locator('.conversation-activity')).toHaveCount(2)
  const failed = page.getByRole('button', { name: 'Command exited with code 1', exact: true })
  await failed.focus(); await page.keyboard.press('Enter')
  await expect(page.locator('.conversation-activity pre')).toContainText('usage: date')
  await expect(page.locator('.conversation-activity .text-destructive')).toHaveCount(0)
  await page.locator('.conversation-dock').screenshot({ path: info.outputPath('tool-attempt-details.png'), animations: 'disabled' })
  // A terminal failure without an explicit error item must still be prominent.
  await details.click()
  await page.evaluate(turn => (window as any).__conversationTest.set({ ...turn, status: 'failed', items: turn.items.slice(0, 1) }), completed)
  await expect(page.locator('.conversation-status')).toHaveText('This request could not be completed.')
  await expect(page.locator('.conversation-status')).toHaveClass(/text-destructive/)
  await expect(page.locator('.conversation-activity')).toHaveCount(0)
})

test('live, restored and standalone errors keep diagnostics behind keyboard-accessible details', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  for (const [mode, width] of [['live', 1000], ['history', 360], ['standalone', 480]] as const) {
    await page.setViewportSize({ width, height: 640 })
    await page.goto(`/dev/conversation-test.html?${mode}=1&error=${encodeURIComponent(providerError)}`)
    await expect(page.getByRole('alert')).toHaveText('The model provider rejected this request.')
    await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
    const error = page.locator('.conversation-error')
    await expect(error).toHaveCount(1)
    await expect(error).toContainText('Provider request failed')
    await expect(error).toContainText('Polyrouter · HTTP 400')
    const raw = error.getByLabel('Original error')
    await expect(raw).not.toBeVisible()
    await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Keep this draft.')
    await error.locator('summary').focus()
    await page.keyboard.press('Enter')
    await expect(raw).toBeVisible()
    expect(await raw.textContent()).toBe(providerError)
    expect(await page.locator('.conversation-scroll').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true)
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Enter')
    await expect(raw).not.toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('Keep this draft.')
  }
  expect(errors).toEqual([])
})

test('plain and malformed errors remain readable without interpreting diagnostics as markup', async ({ page }) => {
  const cases = [
    { text: 'The browser connection closed.', message: 'The browser connection closed.', details: false },
    { text: '{"error":' + '<img src=x onerror=alert(1)>'.repeat(20), message: 'The request could not be completed. See the details below.', details: true },
    { text: JSON.stringify({ error: { message: 'This model is unavailable.' } }), message: 'This model is unavailable.', details: true }
  ]
  for (const sample of cases) {
    await page.goto(`/dev/conversation-test.html?standalone=1&error=${encodeURIComponent(sample.text)}`)
    await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
    const error = page.locator('.conversation-error')
    await expect(error.getByRole('alert')).toContainText(sample.message)
    await expect(error.locator('img')).toHaveCount(0)
    await expect(error.locator('summary')).toHaveCount(sample.details ? 1 : 0)
    if (sample.details) {
      await error.locator('summary').click()
      expect(await error.getByLabel('Original error').textContent()).toBe(sample.text)
    }
  }
})
