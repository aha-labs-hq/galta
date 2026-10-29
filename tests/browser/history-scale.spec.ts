import { test, expect } from '@playwright/test'

// A version is stored as its change from its parent (packages/storage,
// workspaceRecords.ts): writes and memory grow with what changed, not with the
// size of the canvas, and every version reads back exactly.
test.beforeEach(async ({ page }) => {
  await page.goto(process.env.GALTA_SEMANTICS_URL ?? '/dev/scene-test.html')
  await page.waitForFunction(() => !!(window as any).engineTest)
})

const helpers = () => {
  const w = window as any, t = w.engineTest
  let nonce = 0
  const stroke = (id: string, i: number, version = 1) => {
    const points = Array.from({ length: 24 }, (_, p) => [p * 3, Math.sin((p + i) / 3) * 12])
    return { id, type: 'freedraw', x: (i * 37) % 1200, y: (i * 53) % 900, width: 72, height: 24, angle: 0, strokeColor: '#2f2a26', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, index: null, roundness: null, seed: i + 1, version, versionNonce: ++nonce, isDeleted: false, boundElements: null, updated: version, link: null, locked: false, points, pressures: points.map(() => .5), simulatePressure: false, lastCommittedPoint: null }
  }
  const snapshot = (elements: any[], files: Record<string, unknown> = {}) => ({ engine: 'excalidraw', version: 1, document: { elements, files }, view: { scrollX: 0, scrollY: 0, zoom: 1 } })
  const db = (name: string) => new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
  const all = (database: IDBDatabase, store: string, projectId: string) => new Promise<{ key: any; value: any }[]>(resolve => {
    const rows: { key: any; value: any }[] = [], cursor = database.transaction(store).objectStore(store).openCursor(IDBKeyRange.bound([projectId], [projectId, []]))
    cursor.onsuccess = () => { const c = cursor.result; if (!c) return resolve(rows); rows.push({ key: c.key, value: c.value }); c.continue() }
  })
  return { t, stroke, snapshot, db, all }
}

test('a large canvas stores each version as its change and reads every version back exactly', async ({ page }) => {
  test.setTimeout(120_000)
  const result = await page.evaluate(async helpers => {
    const { t, stroke, snapshot, db, all } = new Function(`return (${helpers})()`)()
    const name = 'galta-history-scale', projectId = 'scale', repo = new t.IndexedDbWorkspaceRepository(name)
    const commits: Record<string, { parentId: string | null }> = { c0: { parentId: null } }
    let elements = Array.from({ length: 3000 }, (_, i) => stroke(`s${i}`, i))
    const project = (head: string) => ({ id: projectId, title: 'Scale', headCommitId: head, createdAt: 1, updatedAt: 1, commits: { ...commits } })
    const versions: Record<string, any> = { c0: snapshot(elements) }
    await repo.create({ project: project('c0'), captures: [], snapshots: { ...versions }, revision: 1 })
    let files: Record<string, unknown> = {}
    for (let n = 1; n <= 20; n++) {
      const changedAt = (n * 97) % elements.length, removedAt = (n * 31 + 5) % elements.length
      const changed = { ...elements[changedAt], x: elements[changedAt].x + 10, version: elements[changedAt].version + 1, versionNonce: 100000 + n, updated: n + 1 }
      elements = elements.map((element, i) => i === changedAt ? changed : element).filter((_, i) => i !== removedAt)
      elements.push(stroke(`added-${n}`, 5000 + n))
      if (n % 5 === 0) elements = [elements.at(-1), ...elements.slice(0, -1)] // reordered
      if (n % 7 === 0) files = { ...files, [`image-${n}`]: { id: `image-${n}`, mimeType: 'image/png', created: n, blob: new Blob([String(n)], { type: 'image/png' }) } }
      commits[`c${n}`] = { parentId: `c${n - 1}` }
      versions[`c${n}`] = snapshot(elements, files)
      await repo.update(projectId, (current: any) => ({ ...current, project: project(`c${n}`), snapshots: { ...current.snapshots, [`c${n}`]: versions[`c${n}`] } }))
    }
    // A branch from an older version, then a cut of five versions it no longer needs.
    commits.branch = { parentId: 'c10' }
    versions.branch = snapshot([...versions.c10.document.elements.slice(1), stroke('branch', 9000)], versions.c10.document.files)
    await repo.update(projectId, (current: any) => ({ ...current, project: project('branch'), snapshots: { ...current.snapshots, branch: versions.branch } }))
    for (const id of ['c5', 'c6', 'c7', 'c8', 'c9']) { delete commits[id]; delete versions[id] }
    commits.c10 = { parentId: 'c4' }
    await repo.update(projectId, (current: any) => {
      const snapshots = { ...current.snapshots }
      for (const id of ['c5', 'c6', 'c7', 'c8', 'c9']) delete snapshots[id]
      return { ...current, project: project('branch'), snapshots }
    })
    const cold = await new t.IndexedDbWorkspaceRepository(name).load(projectId)
    const database = await db(name)
    const records = await all(database, 'canvas-snapshots', projectId), assets = await all(database, 'canvas-assets', projectId)
    const manifest = await new Promise<any>(resolve => { const r = database.transaction('workspaces').objectStore('workspaces').get(projectId); r.onsuccess = () => resolve(r.result) })
    database.close()
    const sizes = records.map(row => JSON.stringify(row.value).length).sort((a, b) => a - b)
    const referenced = new Set(records.flatMap(row => row.value.assets.map((asset: any) => asset.id)))
    const shared = cold.snapshots.c19.document.elements.filter((element: any) => cold.snapshots.c20.document.elements.includes(element)).length
    const exact = Object.keys(versions).every(id => JSON.stringify(cold.snapshots[id]) === JSON.stringify(versions[id]))
    await repo.setArchived(projectId, true); await repo.remove(projectId)
    return { versions: Object.keys(cold.snapshots).length, exact, shared, total: cold.snapshots.c20.document.elements.length, full: sizes.at(-1), largestDelta: sizes.at(-2), records: records.length,
      deltas: records.filter(row => row.value.base).length, orphans: assets.filter(row => !referenced.has(row.key[1])).length, manifest: manifest.storageVersion, manifestAssets: 'assets' in manifest }
  }, helpers.toString())
  expect(result).toMatchObject({ versions: 17, exact: true, orphans: 0, manifest: 2, manifestAssets: false })
  // The cut versions stay stored only while a kept version is built on them.
  expect(result.records).toBeGreaterThanOrEqual(17)
  expect(result.deltas).toBe(result.records - 1)
  // About 1 MB complete; each change a few kilobytes.
  expect(result.full).toBeGreaterThan(500_000)
  expect(result.largestDelta).toBeLessThan(20_000)
  // Unchanged elements are one object across versions, in memory as on disk.
  expect(result.shared).toBeGreaterThan(result.total - 4)
})

test('version 1 storage keeps reading, and new versions build on its complete records', async ({ page }) => {
  const result = await page.evaluate(async helpers => {
    const { t, stroke, snapshot, db, all } = new Function(`return (${helpers})()`)()
    const name = 'galta-history-legacy', projectId = 'legacy'
    await new t.IndexedDbWorkspaceRepository(name).load('missing') // creates the current schema
    const elements = Array.from({ length: 40 }, (_, i) => stroke(`s${i}`, i)), points = elements.map((element: any) => element.points)
    const database = await db(name)
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['workspaces', 'canvas-snapshots', 'canvas-assets'], 'readwrite')
      const assets: string[] = []
      const encoded = elements.map((element: any, i: number) => {
        tx.objectStore('canvas-assets').put(points[i], [projectId, `p${i}`]); tx.objectStore('canvas-assets').put(element.pressures, [projectId, `r${i}`]); assets.push(`p${i}`, `r${i}`)
        return { ...element, points: null, pressures: null }
      })
      tx.objectStore('canvas-assets').put([[0, 0]], [projectId, 'orphan']); assets.push('orphan')
      tx.objectStore('canvas-snapshots').put({ value: snapshot(encoded), assets: elements.flatMap((_: any, i: number) => [{ path: ['document', 'elements', i, 'points'], id: `p${i}` }, { path: ['document', 'elements', i, 'pressures'], id: `r${i}` }]) }, [projectId, 'old'])
      tx.objectStore('workspaces').put({ storageVersion: 1, project: { id: projectId, title: 'Legacy', headCommitId: 'a', createdAt: 1, updatedAt: 1, commits: { a: { parentId: null } } }, captures: [], revision: 3, snapshots: { a: 'old' }, assets })
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    })
    database.close()
    const repo = new t.IndexedDbWorkspaceRepository(name), before = await repo.load(projectId)
    const next = snapshot([...before.snapshots.a.document.elements, stroke('new', 99)])
    await repo.update(projectId, (current: any) => ({ ...current, project: { ...current.project, headCommitId: 'b', commits: { ...current.project.commits, b: { parentId: 'a' } } }, snapshots: { ...current.snapshots, b: next } }))
    const cold = await new t.IndexedDbWorkspaceRepository(name).load(projectId)
    const after = await db(name)
    const records = await all(after, 'canvas-snapshots', projectId), assets = await all(after, 'canvas-assets', projectId)
    const manifest = await new Promise<any>(resolve => { const r = after.transaction('workspaces').objectStore('workspaces').get(projectId); r.onsuccess = () => resolve(r.result) })
    after.close()
    return { legacyExact: JSON.stringify(cold.snapshots.a) === JSON.stringify(before.snapshots.a), newExact: JSON.stringify(cold.snapshots.b) === JSON.stringify(next),
      base: records.find((row: any) => row.key[1] !== 'old')?.value.base, oldKept: records.some((row: any) => row.key[1] === 'old'), orphanGone: !assets.some((row: any) => row.key[1] === 'orphan'),
      manifest: manifest.storageVersion, sharedPoints: cold.snapshots.b.document.elements[0].points === cold.snapshots.a.document.elements[0].points }
  }, helpers.toString())
  expect(result).toEqual({ legacyExact: true, newExact: true, base: 'old', oldKept: true, orphanGone: true, manifest: 2, sharedPoints: true })
})

test('captures and versions share unchanged elements with the versions they follow', async ({ page }) => {
  const result = await page.evaluate(() => {
    const { scene, engineTest } = window as any
    engineTest.apply([{ type: 'create_element', id: 'ink', elementType: 'freedraw', x: 10, y: 20, props: { points: [[0, 0], [40, 30]], pressures: [.2, .7] } }, { type: 'create_element', id: 'box', elementType: 'rectangle', x: 100, y: 100 }])
    const find = (snapshot: any, id: string) => snapshot.document.elements.find((element: any) => element.id === id)
    const first = scene.snapshot(), second = scene.snapshot()
    // A native edit replaces only the edited element.
    scene.api.updateScene({ elements: scene.api.getSceneElements().map((element: any) => element.id === 'box' ? { ...element, x: 300, version: element.version + 1, versionNonce: element.versionNonce + 1, updated: element.updated + 1 } : element) })
    const native = scene.snapshot()
    // A tool edit rebuilds every element; its version still shares the unchanged ones.
    engineTest.apply([{ type: 'move', elementId: 'box', x: 500, y: 100 }])
    const tool = engineTest.saveCanvasVersion(scene.snapshot(), native), again = engineTest.saveCanvasVersion(scene.snapshot(), tool)
    return { same: first.document.elements.every((element: any, i: number) => element === second.document.elements[i]),
      nativeInk: find(native, 'ink') === find(first, 'ink'), nativeBox: find(native, 'box') !== find(first, 'box') && find(native, 'box').x === 300,
      toolInk: find(tool, 'ink') === find(native, 'ink'), toolBox: find(tool, 'box').x === 500,
      unchanged: again.document.elements.every((element: any, i: number) => element === tool.document.elements[i]) }
  })
  expect(result).toEqual({ same: true, nativeInk: true, nativeBox: true, toolInk: true, toolBox: true, unchanged: true })
})
