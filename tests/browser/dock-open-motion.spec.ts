import { test, expect, type Page } from '@playwright/test'
import { installDockCodex } from '../helpers/dock-codex'

// Sending from a closed dock opens the reading sheet while the request is
// still on its way into it. The sheet is measured the moment it opens, and the
// request's first lines arrive after: sampled per frame in the production
// build, the sheet must follow them without a snap, and the transcript must not
// scroll inside a sheet that is too short for it.

type Frame = { t: number; sheet: number; scrollTop: number }

/** Presses Send and samples the sheet's height on every frame for a second. */
async function sendAndSample(page: Page, text: string): Promise<Frame[]> {
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill(text)
  await page.evaluate(() => {
    const w = window as any, frames: Frame[] = w.__frames = []
    document.querySelector('.composer-submit')!.addEventListener('pointerdown', () => {
      const start = performance.now()
      const sample = (now: number) => {
        const sheet = document.querySelector('.conversation-presence'), scroll = document.querySelector('.conversation-scroll')
        frames.push({ t: now - start, sheet: sheet ? sheet.getBoundingClientRect().height : 0, scrollTop: scroll ? scroll.scrollTop : 0 })
        if (now - start < 1000) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    }, { capture: true, once: true })
  })
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.waitForTimeout(1200)
  return page.evaluate(() => (window as any).__frames)
}

/** What a reader sees of the sheet while it opens. */
function opening(frames: Frame[]) {
  const sheet = frames.map(frame => frame.sheet)
  const velocity = sheet.slice(1).map((height, i) => (height - sheet[i]!) / (frames[i + 1]!.t - frames[i]!.t))
  const run = velocity.slice(0, velocity.findLastIndex(v => Math.abs(v) > .003) + 1)
  // Once the sheet is clearly slowing it only settles: a frame that moves it
  // faster than the one before is the sheet snapping to content it did not
  // lead to. 0.3 px/ms is 5 px between two 60 Hz frames; following content that
  // arrives late stays well under it, and a snap of tens of pixels is far over.
  let top = 0, slowing = false, lurch = 0
  run.forEach((v, i) => {
    top = Math.max(top, v)
    if (top - v > .3) slowing = true
    if (slowing && i) lurch = Math.max(lurch, v - run[i - 1]!)
  })
  return { final: sheet.at(-1)!, shrank: Math.min(0, ...run), lurch, scrolled: Math.max(...frames.map(frame => frame.scrollTop)) }
}

for (const delay of [0, 160]) {
  test(`the sheet opening from a first request follows it without snapping, host ${delay} ms @serial`, async ({ page }) => {
    await installDockCodex(page, delay)
    const motion = opening(await sendAndSample(page, 'Study the light.'))
    expect(motion.final).toBeGreaterThan(150)
    expect(motion.shrank).toBeGreaterThan(-.003)
    expect(motion.lurch).toBeLessThan(.3)
    expect(motion.scrolled).toBe(0)
  })
}

test('the sheet reopening on a conversation with history follows the new request without snapping @serial', async ({ page }) => {
  await installDockCodex(page, 60)
  await sendAndSample(page, 'Study the light.')
  await page.evaluate(() => (window as any).dockFixture.finish('The light is balanced. The original image is unchanged.\n\nThe warm edge now reads as sun, and the shadow side keeps its depth.'))
  await expect(page.locator('.conversation-reply')).toBeVisible()
  await page.getByRole('button', { name: 'Collapse conversation' }).click()
  await expect(page.locator('.conversation-presence')).toHaveCount(0)
  const motion = opening(await sendAndSample(page, 'Make it warmer.'))
  expect(motion.shrank).toBeGreaterThan(-.003)
  expect(motion.lurch).toBeLessThan(.3)
})

test('a sheet held short by the window opens to that height and no further @serial', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 520 })
  await installDockCodex(page, 60)
  await sendAndSample(page, 'Study the light.')
  await page.evaluate(() => (window as any).dockFixture.finish(Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long answer.`).join('\n\n')))
  await expect(page.locator('.conversation-reply')).toBeVisible()
  await page.getByRole('button', { name: 'Collapse conversation' }).click()
  await expect(page.locator('.conversation-presence')).toHaveCount(0)
  const frames = await sendAndSample(page, 'Make it warmer.')
  const motion = opening(frames)
  const dock = await page.locator('.conversation-dock').boundingBox(), workspace = await page.locator('.conversation-dock').evaluate(element => element.parentElement!.getBoundingClientRect().height)
  expect(dock!.height).toBeLessThanOrEqual(workspace)
  expect(motion.shrank).toBeGreaterThan(-.003)
  expect(motion.lurch).toBeLessThan(.3)
})
