import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { restoreHistory, openHistory } from './history-helpers'
import { storedWorkspace as bundle } from '../helpers/stored-workspace'
import { installReturningAccount } from '../helpers/canvas-port'
test('direct browser drag, tools, persisted history, branching, and keyboard-accessible settings', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await installReturningAccount(page)
  await page.goto('/dev/verification.html')
  await expect(page.getByRole('region', { name: 'Galta canvas, 0 objects', exact: true })).toBeVisible()
  await page.locator('#reference-image').dragTo(page.locator('.galta-canvas'), { targetPosition: { x: 450, y: 300 } })
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect.poll(async () => Object.keys((await bundle(page))?.snapshots ?? {}).length).toBe(2)
  const imported = await bundle(page), id = imported.project.headCommitId
  expect(imported.snapshots[id].engine).toBe('excalidraw')
  const el = imported.snapshots[id].document.elements[0]
  expect(el.type).toBe('image'); expect(el.width / el.height).toBeCloseTo(2 / 3)
  await page.getByRole('button', { name: 'Draw — P', exact: true }).click()
  const box = (await page.locator('.galta-canvas').boundingBox())!
  await page.mouse.move(box.x + 660, 260); await page.mouse.down(); await page.mouse.move(box.x + 820, 480, { steps: 20 }); await page.mouse.up()
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  await expect.poll(async () => Object.keys((await bundle(page)).snapshots).length).toBe(3)
  await restoreHistory(page, imported.project.headCommitId)
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Draw — P', exact: true }).click()
  await page.mouse.move(box.x + 680, 300); await page.mouse.down(); await page.mouse.move(box.x + 870, 400, { steps: 20 }); await page.mouse.up()
  await expect.poll(async () => Object.keys((await bundle(page)).project.branches).length).toBe(2)
  await expect.poll(async () => { const w = await bundle(page); return w.snapshots[w.project.headCommitId].document.elements.length }).toBe(2)
  await expect(page.getByRole('button', { name: 'Open Time Machine', exact: true })).toBeVisible()
  const final = await bundle(page)
  await page.reload()
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  expect((await bundle(page)).project.headCommitId).toBe(final.project.headCommitId)
  await page.getByRole('button', { name: /^Model GPT/ }).click()
  await page.getByRole('button', { name: /^Effort / }).click()
  await page.getByRole('menuitemradio', { name: 'Medium', exact: true }).click()
  await expect.poll(async () => (await bundle(page)).runtimeDefaults.effort).toBe('Medium')
  expect(errors).toEqual([])
})
test('legacy document and all historical branches migrate atomically; originals remain exportable', async ({ page }) => {
  await page.goto('/dev/scene-test.html'); await page.waitForFunction(() => Boolean((window as any).engineTest))
  const raw = process.env.GALTA_MIGRATION_FIXTURE ? JSON.parse(readFileSync(process.env.GALTA_MIGRATION_FIXTURE, 'utf8')).workspace : {
    project: { id: 'migration-fixture', headCommitId: 'old-1', commits: { 'old-1': { parentId: null } }, branches: { main: { headCommitId: 'old-1' } } }, captures: [],
    snapshots: { 'old-1': { document: { store: { 'shape:text': { id: 'shape:text', typeName: 'shape', type: 'text', x: 100, y: 100, index: 'a1', parentId: 'page:1', props: { richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ text: 'Preserve this thought' }] }] }, color: 'black', size: 'm', font: 'draw' } } } } } }, codexSessions: [{ id: 'session-1', threadId: 'thread-1', label: 'Creative', turns: [] }]
  }
  // Browser-local migration semantics: fetch real remote bytes in the test
  // runner; the native extension separately verifies host permission access.
  if (process.env.GALTA_MIGRATION_FIXTURE) await page.route('https://i.pinimg.com/**', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } })
  })
  const result = await page.evaluate(async old => {
    const t = (window as any).engineTest, s = (window as any).scene
    const migrated = await t.migrateWorkspace(old)
    await t.repository.saveMigration(old, migrated)
    const backup = await t.repository.loadMigrationBackup(old.project.id), loaded = await t.repository.load(old.project.id)
    let failures = 0
    const invalid = structuredClone(old), key = Object.keys(invalid.snapshots)[0]
    invalid.snapshots[key] = { document: { store: { bad: { id: 'bad', typeName: 'shape', type: 'alien', index: 'a1', props: {} } } } }
    try { await t.migrateWorkspace(invalid) } catch { failures++ }
    const counts: number[] = []
    for (const snapshot of Object.values(migrated.snapshots)) { s.restore(snapshot); counts.push(s.elements.length) }
    await s.preview()
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    return { snapshots: Object.keys(migrated.snapshots).length, originalSnapshots: Object.keys(old.snapshots).length, backup: JSON.stringify(backup) === JSON.stringify(old), loaded: await t.exportWorkspace(loaded, 0), expected: await t.exportWorkspace(migrated, 0), graph: JSON.stringify(migrated.project) === JSON.stringify(old.project), sessions: JSON.stringify(loaded.agentSessions) === JSON.stringify(t.normalizeWorkspace(old).agentSessions), counts, failures }
  }, raw)
  expect(result).toMatchObject({ backup: true, graph: true, sessions: true, failures: 1 })
  expect(result.loaded).toEqual(result.expected)
  expect(result.snapshots).toBe(result.originalSnapshots)
  if (process.env.GALTA_MIGRATION_FIXTURE) await expect.poll(() => page.evaluate(() => {
    const s = (window as any).scene, state = s.api.getAppState(), el = s.elements.find((el: any) => el.type === 'image')
    const c = [...document.querySelectorAll('canvas')].find(c => c.classList.contains('static'))!
    const ctx = c.getContext('2d')!, colors = new Set<string>()
    for (let x = 1; x < 10; x++) for (let y = 1; y < 10; y++) {
      const px = (el.x + el.width * x / 10 + state.scrollX) * state.zoom.value * devicePixelRatio
      const py = (el.y + el.height * y / 10 + state.scrollY) * state.zoom.value * devicePixelRatio
      colors.add([...ctx.getImageData(px, py, 1, 1).data].slice(0,3).join(','))
    }
    return colors.size
  }), { timeout: 5000, intervals: [32,64,128] }).toBeGreaterThan(15)
  if (process.env.GALTA_MIGRATION_FIXTURE) {
    // Run the same legacy workspace through production startup hydration too.
    // This origin is the isolated acceptance server, never the installed panel.
    // Seed with no mounted editor: an app's pagehide flush must not compete
    // with a test replacing its database behind its back.
    await page.goto(`${acceptanceOrigin}/migration-fixture`)
    await page.evaluate(async workspace => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('galta-v1', 2); r.onupgradeneeded = () => { r.result.createObjectStore('workspaces', { keyPath: 'project.id' }); r.result.createObjectStore('migration-backups', { keyPath: 'project.id' }) }; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
      await new Promise<void>((resolve, reject) => { const tx = db.transaction('workspaces', 'readwrite'); tx.objectStore('workspaces').put(workspace); tx.oncomplete = () => { db.close(); resolve() }; tx.onerror = () => reject(tx.error) })
    }, raw)
    await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
    await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
    const productionWorkspace = await bundle(page)
    const productionText = productionWorkspace.snapshots[productionWorkspace.project.headCommitId].document.elements.find((el: any) => el.type === 'text')
    const originalText = Object.values((raw.snapshots[raw.project.headCommitId] as any).document.store).find((el: any) => el.typeName === 'shape' && el.type === 'text') as any
    expect(productionText.width).toBe(originalText.props.w)
    expect(productionText.originalText).toBe('Stone and silence')
    await openHistory(page)
    await page.getByRole('slider', { name: 'History', exact: true }).press('Home')
    await page.getByRole('slider', { name: 'History', exact: true }).press('End')
    await page.getByRole('button', { name: 'Close Time Machine', exact: true }).click()
    await expect.poll(() => page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.static')!
      const ctx = c.getContext('2d')!, colors = new Set<string>()
      for (let x = 0; x < c.width; x += 10) for (let y = 0; y < c.height; y += 10) colors.add([...ctx.getImageData(x, y, 1, 1).data].slice(0, 3).join(','))
      return colors.size
    })).toBeGreaterThan(200)
  }
})

test('managed artifact metadata migrates to portable workspace references', async ({ page }) => {
  await page.goto('/dev/scene-test.html'); await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const t = (window as any).engineTest
    const key = '335782039d9f5dd5d8d37133401787d8'
    const path = `/Users/ada/.local/share/galta/workspaces/${key}/outputs/page.html`
    const workspace = {
      project: { id: 'portable-path', headCommitId: 'one', commits: { one: { id: 'one', parentId: null } }, branches: { main: { id: 'main', headCommitId: 'one' } }, activeBranchId: 'main' }, captures: [],
      snapshots: { one: { engine: 'excalidraw', version: 1, document: { elements: [{ id: 'html', type: 'embeddable', x: 0, y: 0, width: 100, height: 100, angle: 0, link: '/html-preview.html', customData: { htmlDocument: { html: '<!doctype html><html><body>Portable</body></html>' }, generatedPath: path } }], files: {} }, view: { scrollX: 0, scrollY: 0, zoom: 1 } } }
    }
    const migrated = await t.migrateWorkspace(workspace)
    return { changed: migrated !== workspace, path: migrated.snapshots.one.document.elements[0].customData.generatedPath }
  })
  expect(result).toEqual({ changed: true, path: 'galta-workspace:/outputs/page.html' })
})
