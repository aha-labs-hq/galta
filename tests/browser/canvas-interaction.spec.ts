import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.GALTA_SEMANTICS_URL ?? '/dev/scene-test.html')
  await page.waitForFunction(() => !!(window as any).engineTest)
})

test('cached brush hit geometry follows native mutations, selection, fill and restore', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { scene: s, engineTest: t } = window as any
    t.apply([{ type: 'create_element', id: 'stroke', elementType: 'freedraw', x: 100, y: 100, props: { points: [[0, 0], [200, 0], [200, 200]], strokeWidth: 1 } }])
    const el = document.querySelector('.excalidraw') as any
    let f = el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))!]
    while (!f.stateNode?.scene) f = f.return
    const app = f.stateNode, hit = (x: number, y: number) => app.hitElement(x, y, s.elements[0])
    const threshold = app.getElementHitThreshold()
    const initial = [hit(200, 100), hit(200, 100 + threshold * .9), hit(200, 100 + threshold * 1.1), hit(200, 200), hit(600, 600)]
    s.select(['stroke'])
    await new Promise(requestAnimationFrame)
    const selected = hit(200, 200)
    s.select([])
    await new Promise(requestAnimationFrame)
    // Native mutation retains object identity and increments version. A cache
    // keyed only by object identity would leave all these queries stale.
    const identity = s.elements[0]
    t.mutateElement(identity, { angle: Math.PI / 2 })
    const rotated = [hit(200, 100), hit(300, 180)]
    t.mutateElement(identity, { x: 500 })
    const moved = [hit(300, 180), hit(700, 180)]
    t.mutateElement(identity, { angle: 0, x: 100, points: [[0, 0], [200, 0], [200, 200], [0, 0]], backgroundColor: '#cccccc' })
    const filled = hit(260, 160)
    t.mutateElement(identity, { backgroundColor: 'transparent' })
    const unfilled = hit(260, 160)
    const before = s.snapshot(); s.restore(before)
    const restored = [hit(200, 100), hit(260, 160)]
    return { initial, selected, rotated, moved, filled, unfilled, restored }
  })
  expect(result).toEqual({ initial: [true, true, false, false, false], selected: true, rotated: [false, true], moved: [false, true], filled: true, unfilled: false, restored: [true, false] })
})

test('IndexedDB shares immutable brush payloads while preserving distinct historical geometry', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { scene: s, engineTest: t } = window as any
    t.apply([{ type: 'create_element', id: 'stroke', elementType: 'freedraw', x: 100, y: 100,
      props: { points: Array.from({ length: 2001 }, (_, i) => [i / 10, Math.sin(i / 20) * 30]), pressures: [], simulatePressure: true } }])
    const snapshot = s.snapshot()
    const snapshots: Record<string, any> = Object.fromEntries(Array.from({ length: 50 }, (_, i) => {
      const next = structuredClone(snapshot); next.document.elements[0].x += i
      return [String(i), next]
    }))
    snapshots.edit = structuredClone(snapshots['0']); snapshots.edit.document.elements[0].points[1000][1] += 1
    const originals = Object.fromEntries(Object.entries(snapshots).map(([id, snapshot]) => [id, JSON.stringify(snapshot)]))
    const bundle = { project: { id: 'brush-history', title: 'Brushes', headCommitId: '49', createdAt: 1, updatedAt: 1 }, snapshots, captures: [], revision: 1 }
    await t.repository.save(bundle)
    await t.repository.update(bundle.project.id, (current: any) => ({ ...current, canvasView: { commitId: '49', scrollX: 5, scrollY: 8, zoom: 1.25 } }))
    const stored = await t.repository.load('brush-history')
    const arrays = Object.values(stored.snapshots).map((snapshot: any) => snapshot.document.elements[0].points)
    const preserved = Object.entries(stored.snapshots).every(([id, snapshot]) => JSON.stringify(snapshot) === originals[id])
    s.restore(stored.snapshots['49'])
    t.mutateElement(s.elements[0], { points: [[0, 0], [1, 1]] })
    return { preserved, arrays: arrays.length, uniqueArrays: new Set(arrays).size, originalLength: stored.snapshots['49'].document.elements[0].points.length, view: (await t.repository.load('brush-history')).canvasView }
  })
  expect(result).toEqual({ preserved: true, arrays: 51, uniqueArrays: 2, originalLength: 2001, view: { commitId: '49', scrollX: 5, scrollY: 8, zoom: 1.25 } })
})

test('v3 camera migration is lossless and view writes never read history or replace a newer head', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { scene: s, engineTest: t } = window as any
    const before = { project: { id: 'view-migration', title: 'Camera', headCommitId: 'old', createdAt: 1, updatedAt: 1 }, captures: [], snapshots: { old: s.snapshot() }, revision: 7,
      canvasView: { commitId: 'old', scrollX: 20, scrollY: 30, zoom: .65 } }
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('galta-migration-test', 3)
      r.onupgradeneeded = () => { r.result.createObjectStore('workspaces', { keyPath: 'project.id' }); r.result.createObjectStore('migration-backups', { keyPath: 'project.id' }); r.result.createObjectStore('canvas-catalog', { keyPath: 'id' }) }
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = legacy.transaction(['workspaces', 'canvas-catalog'], 'readwrite')
      tx.objectStore('workspaces').put(before)
      tx.objectStore('canvas-catalog').put({ id: before.project.id, headCommitId: 'old' })
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error)
    }); legacy.close()
    const migrated = await t.repository.load(before.project.id)
    const view = { ...before.canvasView, scrollX: 99 }
    const get = IDBObjectStore.prototype.get, put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.get = function(...args) { if (this.name === 'workspaces') throw Error('Camera read artwork'); return get.apply(this, args) }
    IDBObjectStore.prototype.put = function(...args) { if (this.name === 'workspaces') throw Error('Camera rewrote artwork'); return put.apply(this, args) }
    let saved: boolean
    try { saved = await t.repository.saveView(before.project.id, view) }
    finally { IDBObjectStore.prototype.get = get; IDBObjectStore.prototype.put = put }
    const after = await t.repository.load(before.project.id)
    await t.repository.update(before.project.id, (current: any) => ({ ...current, project: { ...current.project, headCommitId: 'new' } }))
    const stale = await t.repository.saveView(before.project.id, { ...view, scrollX: -999 })
    await t.repository.setArchived(before.project.id, true)
    const archived = await t.repository.saveView(before.project.id, { ...view, commitId: 'new' })
    return { before, migrated, saved, after, stale, archived }
  })
  expect(result.migrated).toEqual(result.before)
  expect(result.saved).toBe(true)
  expect(result.after).toEqual({ ...result.before, canvasView: { ...result.before.canvasView, scrollX: 99 } })
  expect(result.stale).toBe(false)
  expect(result.archived).toBe(false)
})
