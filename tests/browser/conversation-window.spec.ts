import { test, expect, type Page } from '@playwright/test'
import { installDockCodex, buildHistory } from '../helpers/dock-codex'

// A long history opens with its latest turns and brings the earlier ones in
// behind them (ConversationTranscript). The reader has arrived at the latest, so
// the turns brought in above must not move what they see, and nothing that is
// not mounted yet may be out of reach.

const TURNS = 16

const turns = (page: Page) => page.locator('.conversation-turn')

async function closedWithHistory(page: Page) {
  await installDockCodex(page)
  await buildHistory(page, TURNS)
  await page.getByRole('button', { name: 'Collapse conversation' }).click()
  await expect(page.locator('.conversation-presence')).toHaveCount(0)
}

/** Opens the sheet and reads how many turns the first frame that shows it mounted. */
async function openAndCount(page: Page) {
  const first = page.evaluate(() => new Promise<number>(resolve => {
    const look = () => document.querySelector('.conversation-sheet') ? resolve(document.querySelectorAll('.conversation-turn').length) : requestAnimationFrame(look)
    look()
  }))
  await page.locator('.composer-conversation').click()
  return first
}

test('a long history opens with its latest turns, then brings in the rest without moving the reader', async ({ page }) => {
  await closedWithHistory(page)
  // Where the latest turn sits in the view: every frame from the click on, and
  // right after each change of the transcript's size, which is before the
  // reading position has had a frame to correct a view that was moved.
  await page.evaluate(() => {
    const places: number[] = (window as any).__places = []
    let watching: Element | null = null
    const place = () => {
      const scroll = document.querySelector<HTMLElement>('.conversation-scroll'), latest = [...document.querySelectorAll('.conversation-turn')].at(-1)
      if (scroll && latest) places.push(Math.round(latest.getBoundingClientRect().bottom - scroll.getBoundingClientRect().bottom))
    }
    const resized = new ResizeObserver(place)
    const look = () => {
      const content = document.querySelector('.conversation-scroll > div')
      if (content && content !== watching) { watching = content; resized.observe(content) }
      place()
      requestAnimationFrame(look)
    }
    look()
  })
  const opening = await openAndCount(page)
  expect(opening).toBeGreaterThanOrEqual(2)
  expect(opening).toBeLessThan(TURNS / 2)
  await expect.poll(() => turns(page).count(), { timeout: 10000 }).toBe(TURNS)
  await page.waitForTimeout(400)
  const places = await page.evaluate(() => (window as any).__places as number[])
  // The latest reply holds the place it rests at while the sheet opens and the history arrives behind it.
  expect(places.length).toBeGreaterThan(TURNS)
  const rest = places.at(-1)!
  expect(Math.max(...places.map(place => Math.abs(place - rest)))).toBeLessThanOrEqual(1)
  expect(await page.locator('.conversation-scroll').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(1)
})

test('an earlier request is reachable from Requests before it has been brought in', async ({ page }) => {
  await closedWithHistory(page)
  expect(await openAndCount(page)).toBeLessThan(TURNS / 2)
  await page.getByRole('button', { name: 'Browse requests' }).click()
  await page.locator('.request-index-trigger').first().click()
  await expect(turns(page).first()).toBeFocused()
  await expect(turns(page)).toHaveCount(TURNS)
  const [view, first] = await Promise.all([page.locator('.conversation-scroll').boundingBox(), turns(page).first().boundingBox()])
  expect(first!.y).toBeGreaterThanOrEqual(view!.y - 1)
  expect(first!.y).toBeLessThan(view!.y + view!.height)
})

test('a reader at the top of what is mounted never meets its edge', async ({ page }) => {
  await closedWithHistory(page)
  const opening = await openAndCount(page)
  expect(opening).toBeLessThan(TURNS / 2)
  const scroll = page.locator('.conversation-scroll')
  // The reader leaves the latest at once, before anything is brought in behind it.
  await scroll.evaluate(element => { element.scrollTop = 0 })
  await expect.poll(() => turns(page).count()).toBeGreaterThan(opening)
  expect(await scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  // The turn they were reading has not moved: it is still at the top of the view.
  const reading = turns(page).nth(await turns(page).count() - opening)
  const [view, turn] = await Promise.all([scroll.boundingBox(), reading.boundingBox()])
  expect(Math.abs(turn!.y - view!.y)).toBeLessThan(view!.height)
})

test('a reader who scrolled up finds their place when the sheet closes and opens', async ({ page }) => {
  await closedWithHistory(page)
  await page.locator('.composer-conversation').click()
  await expect(turns(page)).toHaveCount(TURNS, { timeout: 10000 })
  const scroll = page.locator('.conversation-scroll')
  await scroll.evaluate(element => { element.scrollTop = 300 })
  await page.waitForTimeout(100)
  await page.getByRole('button', { name: 'Collapse conversation' }).click()
  await expect(page.locator('.conversation-presence')).toHaveCount(0)
  // Their place is in the whole history, so the whole history is mounted for it.
  expect(await openAndCount(page)).toBe(TURNS)
  await expect.poll(() => scroll.evaluate(element => Math.round(element.scrollTop))).toBeCloseTo(300, -1)
})

test('a short history opens whole', async ({ page }) => {
  await installDockCodex(page)
  await buildHistory(page, 5)
  await page.getByRole('button', { name: 'Collapse conversation' }).click()
  await expect(page.locator('.conversation-presence')).toHaveCount(0)
  expect(await openAndCount(page)).toBe(5)
})
