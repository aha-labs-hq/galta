import { seedWorkspace } from '../helpers/stored-workspace'
import { installReturningAccount } from '../helpers/canvas-port'
import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { test, expect, type Page } from '@playwright/test'
import { asBranchId, asCommitId, commit, forkAndCommit } from '../../packages/domain/src/index.js'
import { multiverseLayout } from '../../apps/extension/src/canvas/historyLayout'
import { closeHistory, openHistory, previewHistory, restoreHistory, ruler, stage, storedMoments, timeMachine as dialog, historyWorkspace as workspace } from './history-helpers'

const url = `${acceptanceOrigin}/sidepanel/index.html`
const minute = 60_000
const live = (page: Page) => page.locator('.galta-canvas canvas.excalidraw__canvas.static')
const staged = (page: Page) => page.locator('.history-canvas canvas.excalidraw__canvas.static')

/** The stored record exactly as written, before the repository upgrades it. */
async function rawWorkspace(page: Page) {
  return page.evaluate(() => new Promise<any>((resolve, reject) => {
    const open = indexedDB.open('galta-v1')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => { const get = open.result.transaction('workspaces').objectStore('workspaces').get('default-project'); get.onsuccess = () => { open.result.close(); resolve(get.result) } }
  }))
}

/** Twelve versions three minutes apart (each its own moment), and three
 * futures Galta left behind as other timelines from the second to fourth. */
async function seed(page: Page, change?: (workspace: any, base: number) => void, connected = true, objects = 2) {
  if (connected) await installReturningAccount(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(url)
  await page.locator('nav input[type=file]').setInputFiles(['tests/fixtures/reference-pink.png', 'tests/fixtures/reference-glass.png'])
  await expect(page.locator('.pending-image')).toHaveCount(0)
  const w = await workspace(page), original = w.snapshots[w.project.headCommitId]
  const base = Date.now() - 3 * 60 * minute
  Object.values(w.project.commits).sort((a: any, b: any) => a.createdAt - b.createdAt).forEach((item: any, i: number) => { item.createdAt = base - (10 - i) * minute })
  for (let i = 1; i <= 12; i++) {
    const id = asCommitId(`review-main-${i}`)
    w.project = commit(w.project, { id, now: base + i * 3 * minute, source: 'user', events: [], snapshotRef: id })
    const snapshot = structuredClone(original)
    Object.assign(snapshot.document.elements[0], { x: 150 + i * 10, y: 180, width: 200, height: 280, version: 100 + i, versionNonce: 1000 + i })
    Object.assign(snapshot.document.elements[1], { x: 420, y: 180, width: 200, height: 250 })
    snapshot.view = { scrollX: 0, scrollY: 0, zoom: 1 }
    w.snapshots[id] = snapshot
  }
  const head = w.project.headCommitId, branch = w.project.activeBranchId
  for (let i = 1; i <= 3; i++) {
    const id = asCommitId(`review-alternative-${i}`)
    w.project = forkAndCommit(w.project, { id, historicalCommitId: asCommitId(`review-main-${i + 1}`), newBranchId: asBranchId(`review-alternative-${i}`), now: base + 40 * minute + i * 3 * minute, source: 'agent', events: [], snapshotRef: id })
    w.snapshots[id] = structuredClone(w.snapshots[`review-main-${i}`])
    Object.assign(w.snapshots[id].document.elements[0], { angle: i * Math.PI / 8, version: 200 + i, versionNonce: 2000 + i })
  }
  w.project = { ...w.project, headCommitId: head, activeBranchId: branch }
  w.canvasView = { commitId: head, scrollX: 0, scrollY: 0, zoom: 1 }
  const session = { id: 'history-session', label: 'Studio', threadId: 'original-thread', lastTurnId: 'later-turn', turns: [
    { id: 'first-message', instruction: 'Earlier direction', turnId: 'earlier-turn', status: 'completed', items: [] },
    { id: 'later-message', instruction: 'Later direction', turnId: 'later-turn', status: 'completed', items: [] }
  ] }
  w.agentSessions = [session]
  w.runtimeDefaults = { ...w.runtimeDefaults, sessionId: session.id, sessionLabel: session.label }
  w.agentCheckpoints = { 'review-main-3': { providerId: 'codex-app-server', sessionId: session.id, threadId: session.threadId, turnId: 'earlier-turn' } }
  change?.(w, base)
  await page.goto(`${acceptanceOrigin}/manifest.json`)
  await seedWorkspace(page, w)
  await page.goto(url)
  await expect(page.getByRole('region', { name: `Galta canvas, ${objects} objects`, exact: true })).toBeVisible()
  return w
}

test('Time Machine opens on the live canvas pixel for pixel, only reviews, and returns with selection, draft and undo intact', async ({ page }) => {
  const seeded = await seed(page)
  await page.locator('.excalidraw').first().focus(); await page.keyboard.press('Meta+a')
  await page.getByRole('button', { name: 'Tidy', exact: true }).click()
  await expect.poll(async () => (await workspace(page)).project.headCommitId).not.toBe(seeded.project.headCommitId)
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Keep this draft')
  const pixels = await live(page).evaluate((el: HTMLCanvasElement) => el.toDataURL())
  await openHistory(page)
  await expect(ruler(page)).toBeFocused()
  // The stage is the same canvas under the same camera: opening changes no pixel.
  expect(await staged(page).evaluate((el: HTMLCanvasElement) => el.toDataURL())).toBe(pixels)
  const before = await workspace(page)
  await previewHistory(page, 'review-main-3')
  // Holding Compare shows the current canvas in the same framing; letting go returns.
  const compare = (await page.getByRole('button', { name: 'Compare', exact: true }).boundingBox())!
  await page.mouse.move(compare.x + compare.width / 2, compare.y + compare.height / 2); await page.mouse.down()
  await expect(stage(page)).toHaveAttribute('data-version', before.project.headCommitId)
  await page.mouse.up()
  await expect(stage(page)).toHaveAttribute('data-version', 'review-main-3')
  await ruler(page).focus()
  await page.keyboard.press('Delete')
  await page.keyboard.press('Meta+z')
  await dialog(page).evaluate(el => {
    const data = new DataTransfer()
    data.setData('application/x-galta-reference', JSON.stringify({ url: 'https://images.test/must-not-import.png' }))
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  })
  expect(await live(page).evaluate((el: HTMLCanvasElement) => el.toDataURL())).toBe(pixels)
  await expect(page.locator('.pending-image')).toHaveCount(0)
  const after = await workspace(page)
  expect(after.project).toEqual(before.project)
  expect(after.snapshots).toEqual(before.snapshots)
  expect(after.agentSessions).toEqual(before.agentSessions)
  expect(after.canvasView).toEqual(before.canvasView)
  await page.getByRole('button', { name: 'Close Time Machine', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open Time Machine', exact: true })).toBeFocused()
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('Keep this draft')
  await expect(page.locator('.selection-actions')).toBeVisible()
  await page.locator('.excalidraw').first().focus(); await page.keyboard.press('Meta+z')
  await expect.poll(async () => { const w = await workspace(page); return w.snapshots[w.project.headCommitId].document.elements[0].x }).toBe(270)
})

test('opening never moves the camera, even when the current moment changed something out of view', async ({ page }) => {
  // The current version moved the first image far outside the view.
  await seed(page, w => { const head = w.project.headCommitId; w.snapshots[head] = structuredClone(w.snapshots[head]); Object.assign(w.snapshots[head].document.elements[0], { x: 6000, version: 900, versionNonce: 901 }) }, true, 2)
  const pixels = await live(page).evaluate((el: HTMLCanvasElement) => el.toDataURL())
  await openHistory(page)
  await page.waitForTimeout(600)
  expect(await staged(page).evaluate((el: HTMLCanvasElement) => el.toDataURL())).toBe(pixels)
  await expect(page.locator('.history-mark')).toHaveCount(0)
})

test('an empty current canvas also releases obsolete history preview caches', async ({ page }) => {
  await seed(page, w => { w.snapshots[w.project.headCommitId].document.elements = [] }, true, 0)
  await page.evaluate(() => new Promise<void>(resolve => {
    const open = indexedDB.open('galta-v1')
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('canvas-previews', 'readwrite')
      tx.objectStore('canvas-previews').put({ snapshotRef: 'obsolete', blob: new Blob(['unused']) }, ['default-project', 'review-main-1', 'old-preview'])
      tx.oncomplete = () => { db.close(); resolve() }
    }
  }))
  await page.reload()
  await expect.poll(() => page.evaluate(() => new Promise<boolean>(resolve => {
    const open = indexedDB.open('galta-v1')
    open.onsuccess = () => {
      const db = open.result, read = db.transaction('canvas-previews').objectStore('canvas-previews').getAllKeys(IDBKeyRange.bound(['default-project'], ['default-project', []]))
      read.onsuccess = () => { db.close(); resolve(read.result.every(key => (key as string[])[1] === 'review-main-12')) }
    }
  })), { timeout: 15000 }).toBe(true)
  expect((await workspace(page)).snapshots['review-main-1'].document.elements).toHaveLength(2)
})

test('reviewing with the keyboard cannot rebind a selected arrow on the live canvas', async ({ page }) => {
  await seed(page, w => {
    for (const snapshot of Object.values(w.snapshots) as any[]) {
      if (!snapshot.document.elements.length) continue
      const base = snapshot.document.elements[0]
      snapshot.document.elements = [
        { ...base, id: 'target', type: 'rectangle', x: 400, y: 200, width: 100, height: 100, angle: 0, index: 'a0', boundElements: [{ id: 'connector', type: 'arrow' }] },
        { ...base, id: 'connector', type: 'arrow', x: 200, y: 250, width: 190, height: 0, angle: 0, index: 'a1', points: [[0, 0], [190, 0]], startBinding: null, endBinding: { elementId: 'target', focus: 0, gap: 1 }, startArrowhead: null, endArrowhead: 'arrow', elbowed: false, boundElements: null }
      ]
    }
  })
  const canvas = (await live(page).boundingBox())!
  await page.mouse.click(canvas.x + 300, canvas.y + 250)
  await expect(page.locator('.selection-actions')).toBeVisible()
  const document = () => page.locator('.galta-canvas .excalidraw').evaluate(element => {
    let fiber = (element as any)[Object.keys(element).find(key => key.startsWith('__reactFiber$'))!]
    while (!fiber.stateNode?.scene) fiber = fiber.return
    return JSON.parse(JSON.stringify(fiber.stateNode.scene.getNonDeletedElements()))
  })
  const before = await document()
  expect(before.find((element: any) => element.id === 'connector').endBinding).toEqual({ elementId: 'target', focus: 0, gap: 1 })
  await openHistory(page)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Space')
  await page.keyboard.press('Space')
  expect(await document()).toEqual(before)
  await closeHistory(page)
  await expect(page.locator('.selection-actions')).toBeVisible()
})

test('a burst of edits is one moment, and a Galta request is one moment in its own words', async ({ page }) => {
  await seed(page, (w, base) => {
    const at = (id: string) => w.snapshots[id]
    const move = (from: string, id: string, now: number, source: string, x: number, runtime?: any) => {
      w.project = commit(w.project, { id: asCommitId(id), now, source, events: [], snapshotRef: id, ...(runtime ? { runtime } : {}) })
      w.snapshots[id] = structuredClone(at(from)); Object.assign(w.snapshots[id].document.elements[0], { x, version: x, versionNonce: x + 1 })
    }
    move('review-main-12', 'burst-1', base + 60 * minute, 'user', 500); move('burst-1', 'burst-2', base + 60 * minute + 1000, 'user', 510); move('burst-2', 'burst-3', base + 60 * minute + 2000, 'user', 520)
    const runtime = { sessionId: 'history-session', sessionLabel: 'Studio', modelId: 'gpt-test', effort: 'High', providerId: 'codex-app-server' }
    move('burst-3', 'galta-1', base + 70 * minute, 'agent', 600, runtime); move('galta-1', 'galta-2', base + 70 * minute + 9000, 'agent', 640, runtime)
    w.agentSessions[0].turns.push({ id: 'calmer', instruction: 'Make it calmer', status: 'completed', startedAt: base + 69 * minute, completedAt: base + 71 * minute, items: [] })
    w.canvasView.commitId = 'galta-2'
  })
  const { moments, home } = await storedMoments(page)
  expect(moments.of.get('burst-1')).toBe(moments.of.get('burst-3'))
  expect(moments.of.get('galta-1')).toBe('galta-2')
  await openHistory(page)
  await expect(ruler(page)).toHaveAttribute('aria-valuemax', String(home.length))
  await expect(page.locator('.history-title')).toHaveText('“Make it calmer”')
  await expect(page.locator('.history-detail')).toContainText('Galta')
  await expect(page.locator('.history-detail')).toContainText('Current canvas')
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('.history-title')).toHaveText('Moved an image')
  await expect(stage(page)).toHaveAttribute('data-version', 'burst-3')
  // Option steps through the versions inside a moment.
  await page.keyboard.press('Alt+ArrowLeft')
  await expect(stage(page)).toHaveAttribute('data-version', 'burst-2')
  await expect(page.locator('.history-detail')).toContainText('Step 2 of 3')
})

test('a step that only moved objects glides them there; reduced motion steps at once @serial', async ({ page }) => {
  await seed(page)
  await openHistory(page)
  // Distinct frames the stage paints in the 400 ms after a step.
  const frames = () => page.evaluate(() => new Promise<number>(resolve => {
    const canvas = document.querySelector('.history-canvas canvas.excalidraw__canvas.static') as HTMLCanvasElement
    const seen: number[] = [], start = performance.now()
    const sample = () => {
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let hash = 0; for (let i = 0; i < data.length; i += 251) hash = (hash * 31 + data[i]!) | 0
      if (seen.at(-1) !== hash) seen.push(hash)
      if (performance.now() - start < 400) requestAnimationFrame(sample); else resolve(seen.length)
    }
    requestAnimationFrame(sample)
  }))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  let sampling = frames(); await page.waitForTimeout(30); await page.keyboard.press('ArrowLeft')
  expect(await sampling).toBeGreaterThan(4)
  await expect(stage(page)).toHaveAttribute('data-version', 'review-main-11')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  sampling = frames(); await page.waitForTimeout(30); await page.keyboard.press('ArrowLeft')
  expect(await sampling).toBeLessThanOrEqual(2)
})

test('every control is reachable at desktop and sidebar sizes', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const before = await seed(page)
  for (const [width, height] of [[1440, 1000], [480, 640], [360, 540]]) {
    await page.setViewportSize({ width: width!, height: height! })
    await previewHistory(page, 'review-main-5')
    await expect(stage(page)).toHaveAttribute('data-state', 'ready')
    for (const control of [page.getByRole('button', { name: 'Close Time Machine', exact: true }), page.getByRole('button', { name: 'Play history', exact: true }), page.getByRole('button', { name: 'Compare', exact: true }), page.getByRole('button', { name: 'Trim', exact: true }), page.getByRole('button', { name: 'Restore canvas', exact: true }), ruler(page)]) {
      expect(await control.evaluate(el => { const r = el.getBoundingClientRect(); return r.width >= 32 && r.height >= 32 && r.top >= 0 && r.bottom <= innerHeight && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })).toBe(true)
    }
    expect(await page.locator('.history').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    expect(await page.locator('.history-title > span').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await closeHistory(page)
  }
  const after = await workspace(page)
  expect(after.project).toEqual(before.project); expect(after.snapshots).toEqual(before.snapshots)
  expect(errors).toEqual([])
})

test('the ruler follows a drag, a click and the wheel, and only ever reviews', async ({ page }) => {
  const before = await seed(page)
  await page.setViewportSize({ width: 360, height: 540 })
  await openHistory(page)
  const { home } = await storedMoments(page), at = async () => Number(await ruler(page).getAttribute('aria-valuenow'))
  await expect(ruler(page)).toHaveAttribute('aria-valuemax', String(home.length))
  const start = await at(), box = (await ruler(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20); await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height - 20, { steps: 8 }); await page.mouse.up()
  await expect.poll(at).toBeLessThan(start)
  const dragged = await at()
  // A tick right of the playhead is later in time.
  await page.mouse.click(box.x + box.width / 2 + 24, box.y + box.height - 20)
  await expect.poll(at).toBeGreaterThan(dragged)
  const clicked = await at()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20)
  await page.mouse.wheel(0, -40)
  await expect.poll(at).toBeLessThan(clicked)
  await expect(stage(page)).toHaveAttribute('data-state', 'ready')
  const after = await workspace(page)
  expect(after.project).toEqual(before.project); expect(after.snapshots).toEqual(before.snapshots)
})

test('another timeline is one step up from where it branched, and down returns to the very moment up left', async ({ page }) => {
  await seed(page)
  await previewHistory(page, 'review-alternative-2')
  await expect(page.locator('.history-detail')).toContainText('Other timeline')
  await expect(page.locator('.history-title')).toHaveText('Edited by Galta')
  const there = Number(await ruler(page).getAttribute('aria-valuemax'))
  await page.keyboard.press('ArrowDown')
  await expect(stage(page)).toHaveAttribute('data-version', 'review-main-3')
  expect(Number(await ruler(page).getAttribute('aria-valuemax'))).not.toBe(there)
})

async function crowdedFork(page: Page, named = false) {
  await seed(page, (w, base) => {
    const head = w.project.headCommitId, branch = w.project.activeBranchId
    for (let i = 0; i < 7; i++) {
      const id = asCommitId(`crowded-${i}`)
      w.project = forkAndCommit(w.project, { id, historicalCommitId: asCommitId('review-main-8'), newBranchId: asBranchId(id), now: base + (80 + i) * minute, source: 'agent', events: [], snapshotRef: id })
      w.snapshots[id] = structuredClone(w.snapshots['review-main-8'])
      Object.assign(w.snapshots[id].document.elements[0], { x: 300 + i * 20, version: 300 + i, versionNonce: 3000 + i })
      if (named) (w.namedVersions ??= []).push({ commitId: id, label: `Direction ${i + 1}`, savedAt: base + (80 + i) * minute })
    }
    w.project = { ...w.project, headCommitId: head, activeBranchId: branch }
  })
  await previewHistory(page, 'review-main-8')
}

test('a folded timeline is clickable where its strand is drawn', async ({ page }) => {
  await crowdedFork(page)
  const { moments } = await storedMoments(page)
  const layout = multiverseLayout(moments, moments.current, { gap: 8, session: 16 })
  const folded = layout.strands.filter(strand => strand.bud && strand.fork === 'review-main-8').map(strand => strand.moments.at(-1))
  expect(folded.length).toBeGreaterThan(0)
  const box = (await ruler(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height - 16 - 6 - 5)
  await expect(ruler(page)).toHaveCSS('cursor', 'pointer')
  await page.mouse.down(); await page.mouse.up()
  await expect.poll(async () => folded.includes((await stage(page).getAttribute('data-version'))!)).toBe(true)
})

test('every future at one fork is reachable with the keyboard', async ({ page }) => {
  await crowdedFork(page)
  const { moments } = await storedMoments(page), children = moments.byId.get('review-main-8')!.children
  const visited = new Set<string>()
  for (let i = 0; i < children.length; i++) {
    await page.keyboard.press('ArrowUp')
    visited.add((await stage(page).getAttribute('data-version'))!)
    await page.keyboard.press('ArrowLeft')
    await expect(stage(page)).toHaveAttribute('data-version', 'review-main-8')
  }
  expect([...visited].sort()).toEqual([...children].sort())
})

test('Up pressed again goes on around the same fork, and Down still returns to where Up first left', async ({ page }) => {
  await crowdedFork(page)
  const { moments } = await storedMoments(page), children = moments.byId.get('review-main-8')!.children
  const visited: string[] = []
  for (let i = 0; i < children.length; i++) {
    await page.keyboard.press('ArrowUp')
    visited.push((await stage(page).getAttribute('data-version'))!)
  }
  // Every future once, the most recent first, with no Left in between: the
  // seven alternatives and the continuation.
  expect(visited[0]).toBe('crowded-6')
  expect([...visited].sort()).toEqual([...children].sort())
  expect(new Set(visited).size).toBe(children.length)
  // One more press comes round to the first again.
  await page.keyboard.press('ArrowUp')
  await expect(stage(page)).toHaveAttribute('data-version', visited[0]!)
  // The first departure is the one Down returns to, not an earlier Up.
  await page.keyboard.press('ArrowDown')
  await expect(stage(page)).toHaveAttribute('data-version', 'review-main-8')
  await expect(page.locator('.history-detail')).toContainText('Current timeline')
})

test('the timeline menu reaches folded futures, isolates its keys, and returns to the exact departure', async ({ page }) => {
  await crowdedFork(page, true)
  await page.setViewportSize({ width: 360, height: 540 })
  const before = await workspace(page)
  const picker = () => page.getByRole('button', { name: /choose timeline$/ })
  await picker().click()
  await expect(page.getByRole('menuitemradio')).toHaveCount(11)
  const bounds = (await page.getByRole('menu').boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(12)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(348)
  await page.getByRole('menuitemradio', { name: /^Direction 1 / }).click()
  await expect(stage(page)).toHaveAttribute('data-version', 'crowded-0')
  await expect(picker()).toBeFocused()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(stage(page)).toHaveAttribute('data-version', 'review-main-8')
  await expect(ruler(page)).toBeFocused()
  await picker().press('Enter')
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowUp')
  await expect(stage(page)).toHaveAttribute('data-version', 'review-main-8')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(dialog(page)).toBeVisible()
  await expect(picker()).toBeFocused()
  await picker().press('Enter')
  await expect(page.getByRole('menuitemradio', { name: /^Current canvas / })).toBeFocused()
  await page.keyboard.press('Home')
  await expect(page.getByRole('menuitemradio', { name: /^Current canvas / })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: /^Direction 7 / })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(stage(page)).toHaveAttribute('data-version', 'crowded-6')
  await picker().click()
  await page.getByRole('menuitemradio', { name: /^Current canvas / }).click()
  await expect(stage(page)).toHaveAttribute('data-version', before.project.headCommitId)
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0)
  expect((await workspace(page)).project).toEqual(before.project)
})

test('a moment can be named, renamed and unnamed, and the name survives reload without touching artwork', async ({ page }) => {
  const before = await seed(page)
  await previewHistory(page, 'review-alternative-2')
  await page.locator('.history-title').click()
  await page.getByRole('textbox', { name: 'Moment name', exact: true }).fill('Playful objects')
  await page.keyboard.press('Enter')
  await expect(page.locator('.history-title')).toHaveText('Playful objects')
  await page.reload()
  await previewHistory(page, 'review-alternative-2')
  await expect(page.locator('.history-title')).toHaveText('Playful objects')
  await page.locator('.history-title').click()
  await page.getByRole('textbox', { name: 'Moment name', exact: true }).fill('Objects in motion')
  await page.keyboard.press('Enter')
  await expect(page.locator('.history-title')).toHaveText('Objects in motion')
  expect((await workspace(page)).namedVersions).toEqual([expect.objectContaining({ commitId: 'review-alternative-2', label: 'Objects in motion' })])
  // Escape cancels a rename; an empty name forgets it.
  await page.locator('.history-title').click()
  await page.getByRole('textbox', { name: 'Moment name', exact: true }).fill('Discarded')
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeVisible()
  await expect(page.locator('.history-title')).toHaveText('Objects in motion')
  await page.locator('.history-title').click()
  await page.getByRole('textbox', { name: 'Moment name', exact: true }).fill('')
  await page.keyboard.press('Enter')
  await expect(page.locator('.history-title')).not.toHaveText('Objects in motion')
  const after = await workspace(page)
  expect(after.namedVersions).toEqual([])
  expect(after.project).toEqual(before.project); expect(after.snapshots).toEqual(before.snapshots)
})

test('restoring is explicit, keeps every version and forks the conversation from the restored point', async ({ page }) => {
  const before = await seed(page)
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Try a quieter treatment')
  await previewHistory(page, before.project.headCommitId)
  await expect(page.getByRole('button', { name: 'Restore canvas', exact: true })).toHaveCount(0)
  await restoreHistory(page, 'review-main-3')
  const after = await workspace(page), head = after.project.headCommitId
  expect(after.project.commits[head].parentId).toBe('review-main-3')
  expect(after.snapshots[head].document).toEqual(before.snapshots['review-main-3'].document)
  for (const [id, snapshot] of Object.entries(before.snapshots)) expect(after.snapshots[id]).toEqual(snapshot)
  expect(after.agentSessions[0]).toEqual(before.agentSessions[0])
  expect(after.agentSessions[1].turns).toHaveLength(1)
  expect(after.agentSessions[1].forkFrom).toEqual({ threadId: 'original-thread', lastTurnId: 'earlier-turn' })
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('Try a quieter treatment')
  await page.reload()
  expect((await workspace(page)).project.headCommitId).toBe(head)
  await previewHistory(page, before.project.headCommitId)
  await expect(page.locator('.history-detail')).toContainText('Other timeline')
  await previewHistory(page, head)
  await expect(page.locator('.history-title')).toContainText('Went back to')
})

test('bringing back adds only what the canvas lost, where it was, as one undoable step', async ({ page }) => {
  const before = await seed(page, w => {
    // The latest version no longer has the second image.
    const head = w.project.headCommitId, latest = structuredClone(w.snapshots[head])
    latest.document.elements = latest.document.elements.slice(0, 1)
    w.snapshots[head] = latest
  }, true, 1)
  await previewHistory(page, 'review-alternative-2')
  await expect(page.getByRole('button', { name: /^Bring back/ })).toHaveText('Bring back 1 object')
  await page.setViewportSize({ width: 360, height: 540 })
  for (const control of await page.locator('.history-actions button').all()) {
    const box = (await control.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(360)
  }
  await page.getByRole('button', { name: 'Bring back 1 object', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  const after = await workspace(page), document = after.snapshots[after.project.headCommitId].document
  const lost = before.snapshots['review-alternative-2'].document.elements[1]
  expect(document.elements[0]).toEqual(before.snapshots[before.project.headCommitId].document.elements[0])
  // It comes back as itself.
  expect(document.elements[1].id).toBe(lost.id)
  expect([document.elements[1].x, document.elements[1].y, document.elements[1].angle]).toEqual([lost.x, lost.y, lost.angle])
  for (const [id, snapshot] of Object.entries(before.snapshots)) expect(after.snapshots[id]).toEqual(snapshot)
  expect(after.agentSessions).toEqual(before.agentSessions)
  await expect(page.locator('.galta-canvas .excalidraw')).toBeFocused()
  await page.keyboard.press('Meta+z')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  // When nothing is missing, there is nothing to bring back.
  await previewHistory(page, 'review-main-1')
  await page.getByRole('button', { name: 'Bring back 1 object', exact: true }).waitFor()
  await previewHistory(page, (await workspace(page)).project.headCommitId)
  await expect(page.getByRole('button', { name: /^Bring back/ })).toHaveCount(0)
})

test('an object pointed at in the past comes back as it was, keeping its identity, in one undoable step', async ({ page }) => {
  const before = await seed(page)
  const then = before.snapshots['review-main-3'].document.elements[0], now = before.snapshots[before.project.headCommitId].document.elements[0]
  await previewHistory(page, 'review-main-3')
  const box = (await stage(page).boundingBox())!
  await page.mouse.click(box.x + then.x + then.width / 2, box.y + then.y + then.height / 2)
  await expect(page.getByRole('button', { name: 'Restore canvas', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Bring back 1 object', exact: true })).toHaveAttribute('data-variant', 'default')
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore canvas', exact: true })).toBeVisible()
  expect((await workspace(page)).project).toEqual(before.project)
  await page.mouse.click(box.x + then.x + then.width / 2, box.y + then.y + then.height / 2)
  await page.getByRole('button', { name: 'Bring back 1 object', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(async () => { const w = await workspace(page); return w.snapshots[w.project.headCommitId].document.elements.find((e: any) => e.id === then.id)?.x }).toBe(then.x)
  const after = await workspace(page)
  expect(after.snapshots[after.project.headCommitId].document.elements.filter((e: any) => !e.isDeleted)).toHaveLength(2)
  for (const [id, snapshot] of Object.entries(before.snapshots)) expect(after.snapshots[id]).toEqual(snapshot)
  await expect(page.locator('.galta-canvas .excalidraw')).toBeFocused()
  await page.keyboard.press('Meta+z')
  await expect.poll(async () => { const w = await workspace(page); return w.snapshots[w.project.headCommitId].document.elements.find((e: any) => e.id === then.id)?.x }).toBe(now.x)
})

test('trim cuts a timeline or a range for good when Time Machine closes, can be undone until then, and never cuts the current canvas', async ({ page }) => {
  const before = await seed(page)
  // Another timeline's own moments, cut, undone, cut again.
  await previewHistory(page, 'review-alternative-2')
  await page.getByRole('button', { name: 'Trim', exact: true }).click()
  await expect(page.locator('.history-cut')).toHaveText('Cut moment')
  await page.locator('.history-cut').click()
  await expect(dialog(page).getByRole('status')).toHaveText('1 moment cut. Undo before closing Time Machine.')
  await expect(ruler(page)).toBeFocused()
  await page.getByRole('button', { name: 'Undo cut', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Undo cut', exact: true })).toHaveCount(0)
  expect(Object.keys((await workspace(page)).project.commits)).toContain('review-alternative-2')
  await page.getByRole('button', { name: 'Trim', exact: true }).click()
  await page.locator('.history-cut').click()
  await closeHistory(page)
  let after = await workspace(page)
  expect(after.project.commits['review-alternative-2']).toBeUndefined()
  expect(after.snapshots['review-alternative-2']).toBeUndefined()
  expect(after.project.headCommitId).toBe(before.project.headCommitId)
  for (const [id, snapshot] of Object.entries(before.snapshots)) if (id !== 'review-alternative-2') expect(after.snapshots[id]).toEqual(snapshot)
  // A range that holds the current canvas cannot be cut.
  await previewHistory(page, before.project.headCommitId)
  await page.getByRole('button', { name: 'Trim', exact: true }).click()
  await expect(page.locator('.history-cut')).toBeDisabled()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  // Drag the handles in to the fourth to sixth versions, and cut them.
  await previewHistory(page, 'review-main-6')
  const { home } = await storedMoments(page), selected = home.indexOf('review-main-6')
  await page.getByRole('button', { name: 'Trim', exact: true }).click()
  const box = (await ruler(page).boundingBox())!, middle = box.x + box.width / 2, y = box.y + box.height - 24, gap = 8
  const drag = async (from: number, to: number) => { await page.mouse.move(from, y); await page.mouse.down(); await page.mouse.move(to, y, { steps: 6 }); await page.mouse.up() }
  await drag(middle + (home.length - 1 - selected) * gap + gap / 2, middle + gap / 2)
  await drag(middle - selected * gap - gap / 2, middle + (home.indexOf('review-main-4') - selected) * gap - gap / 2)
  await expect(page.locator('.history-cut')).toHaveText('Cut 3 moments')
  await page.locator('.history-cut').click()
  await closeHistory(page)
  after = await workspace(page)
  for (const id of ['review-main-4', 'review-main-5', 'review-main-6']) expect(after.project.commits[id]).toBeUndefined()
  expect(after.project.commits['review-main-7'].parentId).toBe('review-main-3')
  expect(after.project.commits['review-alternative-3'].parentId).toBe('review-main-3')
  expect(after.agentCheckpoints).toEqual(before.agentCheckpoints)
  expect(after.project.headCommitId).toBe(before.project.headCommitId)
})

test('trim endpoints are keyboard reachable, bounded, and can cut a range without a pointer', async ({ page }) => {
  const before = await seed(page)
  await page.setViewportSize({ width: 360, height: 540 })
  await previewHistory(page, 'review-main-6')
  const { home } = await storedMoments(page)
  await page.getByRole('button', { name: 'Trim', exact: true }).click()
  const start = page.getByRole('slider', { name: 'Trim start', exact: true })
  const end = page.getByRole('slider', { name: 'Trim end', exact: true })
  await expect(start).toHaveCount(1)
  await expect(end).toHaveCount(1)
  await expect(ruler(page)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(start).toBeFocused()
  await page.keyboard.press('Home')
  for (let i = 0; i < home.indexOf('review-main-4'); i++) await page.keyboard.press('ArrowRight')
  await expect(stage(page)).toHaveAttribute('data-version', 'review-main-4')
  await page.keyboard.press('Tab')
  await expect(end).toBeFocused()
  await page.keyboard.press('Home')
  // End cannot precede start; start cannot pass end.
  await expect(end).toHaveValue(String(home.indexOf('review-main-4') + 1))
  await page.keyboard.press('ArrowLeft')
  await expect(end).toHaveValue(String(home.indexOf('review-main-4') + 1))
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowRight')
  await expect(start).toHaveValue(String(home.indexOf('review-main-4') + 1))
  await page.keyboard.press('Tab')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(stage(page)).toHaveAttribute('data-version', 'review-main-6')
  await expect(page.locator('.history-cut')).toHaveText('Cut 3 moments')
  await expect(page.locator('.history-cut')).toBeEnabled()
  // Complete the action and undo it entirely through the keyboard.
  for (let i = 0; i < 10 && !await page.locator('.history-cut').evaluate(el => el === document.activeElement); i++) await page.keyboard.press('Tab')
  await expect(page.locator('.history-cut')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Undo cut', exact: true })).toBeVisible()
  await page.keyboard.press('Meta+z')
  await expect(page.getByRole('button', { name: 'Undo cut', exact: true })).toHaveCount(0)
  await expect(stage(page)).toHaveAttribute('data-version', 'review-main-6')
  await page.getByRole('button', { name: 'Trim', exact: true }).click()
  await page.keyboard.press('Tab')
  await expect(start).toBeFocused()
  // Escape exits Trim and returns focus to the ruler without closing review.
  await page.keyboard.press('Escape')
  await expect(start).toHaveCount(0)
  await expect(ruler(page)).toBeFocused()
  await expect(dialog(page)).toBeVisible()
  expect((await workspace(page)).project).toEqual(before.project)
})

test('the end of a one-moment trim range is draggable without the start stealing its target', async ({ page }) => {
  const before = await seed(page)
  await previewHistory(page, 'review-main-6')
  const { home } = await storedMoments(page), from = home.indexOf('review-main-4') + 1
  await page.getByRole('button', { name: 'Trim', exact: true }).click()
  const start = page.getByRole('slider', { name: 'Trim start', exact: true }), end = page.getByRole('slider', { name: 'Trim end', exact: true })
  await start.focus(); await page.keyboard.press('Home')
  for (let i = 1; i < from; i++) await page.keyboard.press('ArrowRight')
  await end.focus(); await page.keyboard.press('Home')
  await expect(end).toHaveValue(String(from))
  const box = (await ruler(page).boundingBox())!, x = box.x + box.width / 2 + 3, y = box.y + box.height - 28
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 16, y, { steps: 4 }); await page.mouse.up()
  await expect(start).toHaveValue(String(from))
  await expect(end).toHaveValue(String(from + 2))
  await expect(page.locator('.history-cut')).toHaveText('Cut 3 moments')
  expect((await workspace(page)).project).toEqual(before.project)
})

test('a trimmed range exports as a video of the canvas changing', async ({ page }) => {
  await seed(page)
  await previewHistory(page, 'review-main-9')
  await page.getByRole('button', { name: 'Trim', exact: true }).click()
  const download = page.waitForEvent('download', { timeout: 60000 })
  await page.getByRole('button', { name: 'Export video', exact: true }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/ — Time Machine\.(mp4|webm)$/)
  const bytes = (await (await file.createReadStream()).toArray()).reduce((sum: number, chunk: Buffer) => sum + chunk.length, 0)
  expect(bytes).toBeGreaterThan(1000)
  await expect(page.getByRole('button', { name: 'Export video', exact: true })).toBeEnabled()
})

test('a recording failure is reported and releases its media tracks without downloading a broken video', async ({ page }) => {
  await seed(page)
  await previewHistory(page, 'review-main-9')
  await page.getByRole('button', { name: 'Trim', exact: true }).click()
  await page.evaluate(() => {
    const w = window as any
    w.MediaRecorder = class {
      static isTypeSupported() { return true }
      state = 'inactive'
      onerror?: (event: any) => void
      onstop?: () => void
      constructor(stream: MediaStream) { w.recordingTracks = stream.getTracks() }
      start() { this.state = 'recording'; queueMicrotask(() => { this.state = 'inactive'; this.onerror?.({ error: new Error('Encoder failed during recording') }); this.onstop?.() }) }
      stop() { this.state = 'inactive'; this.onstop?.() }
    }
  })
  const downloads: string[] = []; page.on('download', file => downloads.push(file.suggestedFilename()))
  await page.getByRole('button', { name: 'Export video', exact: true }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('Encoder failed during recording')
  await expect(page.getByRole('button', { name: 'Export video', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => (window as any).recordingTracks.map((track: MediaStreamTrack) => track.readyState))).toEqual(['ended'])
  expect(downloads).toEqual([])
})

test('a recording stops when the collection layout removes Time Machine', async ({ page }) => {
  await seed(page)
  await page.locator('.collection-trigger').click()
  await previewHistory(page, 'review-main-9')
  await page.getByRole('button', { name: 'Trim', exact: true }).click()
  await page.evaluate(() => {
    const capture = HTMLCanvasElement.prototype.captureStream
    HTMLCanvasElement.prototype.captureStream = function(...args) {
      const stream = capture.apply(this, args)
      ;(window as any).recordingTracks = stream.getTracks()
      return stream
    }
  })
  await page.getByRole('button', { name: 'Export video', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).recordingTracks?.length ?? 0)).toBe(1)
  await page.setViewportSize({ width: 480, height: 640 })
  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).recordingTracks.map((track: MediaStreamTrack) => track.readyState))).toEqual(['ended'])
})

for (const fails of [false, true]) test(`a cut ${fails ? 'reports a failed save' : 'is saved'} when the collection layout removes Time Machine`, async ({ page }) => {
  const before = await seed(page)
  await page.locator('.collection-trigger').click()
  await previewHistory(page, 'review-alternative-1')
  await page.getByRole('button', { name: 'Trim', exact: true }).click()
  await page.locator('.history-cut').click()
  if (fails) await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(value, ...args) {
      if (this.name === 'workspaces') throw new Error('Detached cut rejected by test')
      return put.call(this, value, ...args)
    }
  })
  // The collection fills a narrow panel, unmounting its canvas header and dialog.
  await page.setViewportSize({ width: 480, height: 640 })
  await expect(dialog(page)).toHaveCount(0)
  if (fails) {
    // The canvas owns the notice; it remains available when leaving the collection.
    await page.locator('.collection-trigger').click()
    await expect(page.getByRole('alert')).toContainText('Unable to finish cutting Time Machine history. Detached cut rejected by test')
    expect((await workspace(page)).project).toEqual(before.project)
  } else {
    await expect.poll(async () => Boolean((await workspace(page)).project.commits['review-alternative-1'])).toBe(false)
    expect((await workspace(page)).project.headCommitId).toBe(before.project.headCommitId)
  }
})

test('links in the past never open, a past document takes no pointer, and right-click does nothing', async ({ page }) => {
  await seed(page, w => { for (let i = 1; i <= 12; i++) w.snapshots[`review-main-${i}`].document.elements[1].link = 'https://example.com/elsewhere' })
  await previewHistory(page, 'review-main-3')
  const pages: string[] = []; page.context().on('page', other => pages.push(other.url()))
  const address = page.url(), box = (await stage(page).boundingBox())!, linked = { x: box.x + 420 + 100, y: box.y + 180 + 125 }
  await page.mouse.click(linked.x, linked.y)
  await page.mouse.move(linked.x, linked.y); await page.mouse.down(); await page.waitForTimeout(450); await page.mouse.up()
  await page.mouse.click(linked.x, linked.y, { button: 'right' })
  await page.waitForTimeout(300)
  expect(pages).toEqual([]); expect(page.url()).toBe(address)
  await expect(page.locator('.history-canvas .context-menu')).toHaveCount(0)
  await expect(dialog(page)).toBeVisible()
  // The click still points at the object; the canvas already has it as it was.
  await expect(page.locator('.history-actions')).toContainText('already has this as it was then')
})

test('the stage keeps to the live canvas through a resize', async ({ page }) => {
  await seed(page)
  await openHistory(page)
  await page.setViewportSize({ width: 900, height: 700 })
  await expect.poll(async () => JSON.stringify(await stage(page).boundingBox())).toBe(JSON.stringify(await page.locator('.galta-canvas .excalidraw').boundingBox()))
})

test('a version named inside a moment becomes a moment of its own and stays on stage', async ({ page }) => {
  await seed(page, (w, base) => {
    for (const [id, from, at, x] of [['burst-1', 'review-main-12', 0, 500], ['burst-2', 'burst-1', 1000, 510], ['burst-3', 'burst-2', 2000, 520]] as const) {
      w.project = commit(w.project, { id: asCommitId(id), now: base + 60 * minute + at, source: 'user', events: [], snapshotRef: id })
      w.snapshots[id] = structuredClone(w.snapshots[from]); Object.assign(w.snapshots[id].document.elements[0], { x, version: x, versionNonce: x + 1 })
    }
    w.canvasView.commitId = 'burst-3'
  })
  await previewHistory(page, 'burst-2')
  await expect(page.locator('.history-detail')).toContainText('Step 2 of 3')
  await page.locator('.history-title').click()
  await page.getByRole('textbox', { name: 'Moment name', exact: true }).fill('Halfway')
  await page.keyboard.press('Enter')
  await expect(page.locator('.history-title')).toHaveText('Halfway')
  await expect(stage(page)).toHaveAttribute('data-version', 'burst-2')
  expect((await storedMoments(page)).moments.byId.has('burst-2')).toBe(true)
})

test('Restore after a cut writes the cut once and closes', async ({ page }) => {
  const before = await seed(page)
  await previewHistory(page, 'review-alternative-2')
  await page.getByRole('button', { name: 'Trim', exact: true }).click()
  await page.locator('.history-cut').click()
  await expect(stage(page)).toHaveAttribute('data-version', 'review-main-3')
  await page.getByRole('button', { name: 'Restore canvas', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  const after = await workspace(page)
  expect(after.project.commits['review-alternative-2']).toBeUndefined()
  expect(after.project.commits[after.project.headCommitId].parentId).toBe('review-main-3')
  expect(after.trimmedVersions).toEqual({ 'review-alternative-2': 'review-main-3' })
  for (const [id, snapshot] of Object.entries(before.snapshots)) if (id !== 'review-alternative-2') expect(after.snapshots[id]).toEqual(snapshot)
})

test('a failed restore leaves the original canvas and Time Machine open', async ({ page }) => {
  const before = await seed(page)
  await previewHistory(page, 'review-main-3')
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'workspaces') throw new Error('History save rejected by test')
      return put.call(this, value, ...args)
    }
  })
  await page.getByRole('button', { name: 'Restore canvas', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('History save rejected by test')
  await expect(dialog(page)).toBeVisible()
  expect((await workspace(page)).project).toEqual(before.project)
  expect((await workspace(page)).snapshots).toEqual(before.snapshots)
})

test('a newer edit in another window prevents history from replacing current work', async ({ page }) => {
  await seed(page)
  await previewHistory(page, 'review-main-3')
  const other = await page.context().newPage()
  await installReturningAccount(other)
  await other.goto(url)
  await expect(other.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeEnabled()
  await other.locator('.excalidraw').first().focus(); await other.keyboard.press('Meta+a')
  await other.getByRole('button', { name: 'Tidy', exact: true }).click()
  await expect.poll(async () => (await workspace(other)).project.headCommitId).not.toBe('review-main-12')
  const updated = await workspace(other)
  await page.getByRole('button', { name: 'Restore canvas', exact: true }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('Another window changed')
  expect((await workspace(page)).project).toEqual(updated.project)
  expect((await workspace(page)).snapshots).toEqual(updated.snapshots)
  await page.getByRole('button', { name: 'Close Time Machine', exact: true }).click()
  await other.close()
})

test('an unreadable historical snapshot is reported without losing the working canvas or the rest of history', async ({ page }) => {
  const before = await seed(page, undefined, false)
  // A newer same-head update can arrive after startup's full snapshot validation.
  const corrupted = { ...before, revision: (before.revision ?? 0) + 1, snapshots: { ...before.snapshots, 'review-main-3': { engine: 'excalidraw', version: 1, document: null } } }
  await seedWorkspace(page, corrupted)
  await page.evaluate(revision => {
    const channel = new BroadcastChannel('galta-workspace-sync'); channel.postMessage({ projectId: 'default-project', writerId: 'test-corruption', revision }); channel.close()
  }, corrupted.revision)
  await previewHistory(page, 'review-main-3')
  await expect(stage(page)).toHaveAttribute('data-state', 'error')
  await expect(page.locator('.history-title')).toHaveText('This moment can’t be shown')
  await page.getByRole('button', { name: 'Restore canvas', exact: true }).click()
  await expect(dialog(page).getByRole('alert').last()).toBeVisible()
  await previewHistory(page, 'review-main-5')
  await expect(stage(page)).toHaveAttribute('data-state', 'ready')
  await closeHistory(page)
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  expect((await workspace(page)).project).toEqual(before.project)
})

test('hundreds of moments stay reachable from one ruler', async ({ page }) => {
  const before = await seed(page, (w, base) => {
    const source = w.snapshots[w.project.headCommitId]
    for (let i = 1; i <= 300; i++) {
      const id = asCommitId(`long-history-${i}`)
      w.project = commit(w.project, { id, now: base + 60 * minute + i * 3 * minute + Math.floor(i / 25) * 40 * minute, source: 'user', events: [], snapshotRef: id })
      w.snapshots[id] = structuredClone(source); Object.assign(w.snapshots[id].document.elements[0], { x: 100 + i, version: 5000 + i, versionNonce: 9000 + i })
    }
    w.canvasView.commitId = 'long-history-300'
  })
  await openHistory(page)
  const { home } = await storedMoments(page)
  expect(home.length).toBeGreaterThan(300)
  await expect(ruler(page)).toHaveAttribute('aria-valuemax', String(home.length))
  await page.keyboard.press('Home'); await expect(ruler(page)).toHaveAttribute('aria-valuenow', '1')
  await page.keyboard.press('End'); await expect(ruler(page)).toHaveAttribute('aria-valuenow', String(home.length))
  await expect(stage(page)).toHaveAttribute('data-version', 'long-history-300')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(async () => Number(await ruler(page).getAttribute('aria-valuenow'))).toBeLessThan(home.length)
  // Focus must bring a trim endpoint back into view even across hundreds of moments.
  await page.setViewportSize({ width: 360, height: 540 })
  await page.getByRole('button', { name: 'Trim', exact: true }).click()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Home')
  await expect(ruler(page)).toHaveAttribute('aria-valuenow', '1')
  await page.keyboard.press('Tab')
  const end = page.getByRole('slider', { name: 'Trim end', exact: true })
  await expect(end).toBeFocused()
  await expect(ruler(page)).toHaveAttribute('aria-valuenow', await end.inputValue())
  expect((await workspace(page)).project).toEqual(before.project)
})

test('playback walks the ruler to the last moment, pauses on a seek, and never edits the document', async ({ page }) => {
  const before = await seed(page)
  await previewHistory(page, 'review-main-9')
  const { home } = await storedMoments(page)
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Play history', exact: true })).toBeVisible({ timeout: 10000 })
  await expect(ruler(page)).toHaveAttribute('aria-valuenow', String(home.length))
  await expect(stage(page)).toHaveAttribute('data-version', before.project.headCommitId)
  const after = await workspace(page)
  expect(after.project).toEqual(before.project); expect(after.snapshots).toEqual(before.snapshots); expect(after.canvasView).toEqual(before.canvasView)
  // From the end, play starts over; a seek pauses it.
  await page.getByRole('button', { name: 'Play history', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await ruler(page).focus(); await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('button', { name: 'Play history', exact: true })).toBeVisible()
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await closeHistory(page)
  await openHistory(page)
  await expect(page.getByRole('button', { name: 'Play history', exact: true })).toBeVisible()
})

test('history kept by the retired tools shows every version again and keeps every version when upgraded', async ({ page }) => {
  const before = await seed(page)
  // The stored record still carries the retired names, clip and hidden marks.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('galta-v1')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('workspaces', 'readwrite'), store = tx.objectStore('workspaces'), get = store.get('default-project')
      get.onsuccess = () => store.put({ ...get.result, savedDirections: [{ commitId: 'review-alternative-1', label: 'Older idea', savedAt: 1 }], historyClips: { 'review-main-12': { from: 'review-main-3', to: 'review-main-6' } }, historyTrash: { 'review-main-4': 2, 'review-main-5': 2 } })
      tx.oncomplete = () => { open.result.close(); resolve() }
    }
  }))
  await page.reload()
  await openHistory(page)
  const { home } = await storedMoments(page)
  await expect(ruler(page)).toHaveAttribute('aria-valuemax', String(home.length))
  await previewHistory(page, 'review-main-5')
  await expect(stage(page)).toHaveAttribute('data-state', 'ready')
  await previewHistory(page, 'review-alternative-1')
  await expect(page.locator('.history-title')).toHaveText('Older idea')
  await page.locator('.history-title').click()
  await page.getByRole('textbox', { name: 'Moment name', exact: true }).fill('Older idea, kept')
  await page.keyboard.press('Enter')
  await expect(page.locator('.history-title')).toHaveText('Older idea, kept')
  const raw = await rawWorkspace(page)
  expect(raw.savedDirections).toBeUndefined(); expect(raw.historyClips).toBeUndefined(); expect(raw.historyTrash).toBeUndefined()
  expect(raw.namedVersions).toEqual([{ commitId: 'review-alternative-1', label: 'Older idea, kept', savedAt: 1 }])
  const after = await workspace(page)
  expect(after.project).toEqual(before.project); expect(after.snapshots).toEqual(before.snapshots)
})

test('a box taken back brings the arrow that holds on to it along', async ({ page }) => {
  const shape = (id: string, x: number, extra: object = {}) => ({ id, type: 'rectangle', x, y: 520, width: 200, height: 100, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, index: null, roundness: null, seed: 7, version: 3, versionNonce: x, isDeleted: false, boundElements: [{ id: 'link', type: 'arrow' }], updated: 1, link: null, locked: false, ...extra })
  const arrow = (from: number) => ({ ...shape('link', from + 204, { boundElements: null, versionNonce: from + 1 }), type: 'arrow', y: 570, width: 520 - from - 204, height: 0, points: [[0, 0], [520 - from - 204, 0]], startBinding: { elementId: 'box', focus: 0, gap: 4 }, endBinding: { elementId: 'post', focus: 0, gap: 4 }, startArrowhead: null, endArrowhead: 'arrow', elbowed: false, lastCommittedPoint: null })
  const before = await seed(page, w => {
    for (const [id, snapshot] of Object.entries(w.snapshots) as [string, any][]) {
      if (!id.startsWith('review-')) continue
      const x = id === 'review-main-12' ? 260 : 60
      snapshot.document.elements = [...snapshot.document.elements, shape('box', x), shape('post', 724, { versionNonce: 99 }), arrow(x)]
    }
  }, true, 5)
  await previewHistory(page, 'review-main-3')
  const box = (await stage(page).boundingBox())!
  await page.mouse.click(box.x + 60 + 100, box.y + 520 + 50)
  await page.getByRole('button', { name: 'Bring back 1 object', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(async () => { const w = await workspace(page); return w.snapshots[w.project.headCommitId].document.elements.find((e: any) => e.id === 'box')?.x }).toBe(60)
  const after = await workspace(page), elements = after.snapshots[after.project.headCommitId].document.elements
  const link = elements.find((e: any) => e.id === 'link'), start = link.x + link.points[0][0]
  // The arrow left the box's later place and holds on to it where it returned.
  expect(start).toBeGreaterThan(60); expect(start).toBeLessThan(60 + 200 + 20)
  expect(link.startBinding.elementId).toBe('box')
  for (const [id, snapshot] of Object.entries(before.snapshots)) expect(after.snapshots[id]).toEqual(snapshot)
})

test('up enters the one future that branched at the current canvas', async ({ page }) => {
  await seed(page, w => { w.project.headCommitId = 'review-main-11'; w.canvasView.commitId = 'review-main-11' })
  await openHistory(page)
  await page.keyboard.press('ArrowUp')
  await expect(stage(page)).toHaveAttribute('data-version', 'review-main-12')
  await expect(page.locator('.history-detail')).toContainText('Other timeline')
})

