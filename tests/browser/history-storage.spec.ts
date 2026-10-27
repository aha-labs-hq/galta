import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.GALTA_SEMANTICS_URL ?? '/dev/scene-test.html')
  await page.waitForFunction(() => !!(window as any).engineTest)
})

test('immutable records write incrementally, roll back failures, fence replacement previews and collect removed assets', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const t = (window as any).engineTest, repo = t.repository, projectId = 'records-test'
    t.apply([{ type: 'create_element', id: 'brush', elementType: 'freedraw', x: 10, y: 20, props: { points: [[0, 0], [100, 100]], pressures: [.1, .8] } }])
    const snapshot = (window as any).scene.snapshot()
    const bundle = { project: { id: projectId, title: 'Test', headCommitId: 'a', createdAt: 1, updatedAt: 1 }, captures: [], snapshots: { a: snapshot }, revision: 1 }
    await repo.save(bundle)
    const before = await repo.load(projectId), oldRef = t.snapshotReference(before.snapshots.a)
    const accesses: string[] = [], get = IDBObjectStore.prototype.get, add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.get = function(...args) { accesses.push('get:' + this.name); return get.apply(this, args) }
    IDBObjectStore.prototype.add = function(...args) { accesses.push('add:' + this.name); return add.apply(this, args) }
    try {
      await repo.update(projectId, (current: any) => {
        const a = current.snapshots.a, e = a.document.elements[0]
        return { ...current, project: { ...current.project, headCommitId: 'b' }, snapshots: { ...current.snapshots, b: { ...a, document: { ...a.document, elements: [{ ...e, x: 99 }] } } } }
      })
    } finally { IDBObjectStore.prototype.get = get; IDBObjectStore.prototype.add = add }
    const after = await repo.load(projectId), cold = await new t.IndexedDbWorkspaceRepository('galta-migration-test').load(projectId)
    let failure = ''
    IDBObjectStore.prototype.add = function(...args) { if (this.name === 'canvas-snapshots') throw new DOMException('Test quota failure', 'QuotaExceededError'); return add.apply(this, args) }
    try { await repo.update(projectId, (current: any) => ({ ...current, snapshots: { ...current.snapshots, broken: { ...snapshot, newSnapshot: true } } })) }
    catch (error) { failure = String(error) }
    finally { IDBObjectStore.prototype.add = add }
    const rolledBack = await repo.load(projectId)
    const png = new Blob(['test'], { type: 'image/png' })
    const saved = await repo.savePreview(projectId, 'a', 'test', oldRef, png)
    const other = new t.IndexedDbWorkspaceRepository('galta-migration-test')
    await other.update(projectId, (current: any) => ({ ...current, snapshots: { ...current.snapshots, a: { ...current.snapshots.a, replacement: true } } }))
    const replaced = await repo.load(projectId), stale = await repo.savePreview(projectId, 'a', 'test', oldRef, png), preview = await repo.readPreview(projectId, 'a', 'test')
    await repo.setArchived(projectId, true); await repo.remove(projectId)
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('galta-migration-test'); r.onsuccess = () => resolve(r.result) })
    const counts = await Promise.all(['canvas-snapshots', 'canvas-assets', 'canvas-previews'].map(name => new Promise<number>(resolve => { const r = db.transaction(name).objectStore(name).count(IDBKeyRange.bound([projectId], [projectId, []])); r.onsuccess = () => resolve(r.result) })))
    db.close()
    return { accesses, oldPreserved: JSON.stringify(before.snapshots.a) === JSON.stringify(after.snapshots.a), coldExact: JSON.stringify(after) === JSON.stringify(cold), shared: cold.snapshots.a.document.elements[0].points === cold.snapshots.b.document.elements[0].points,
      failure, rollbackExact: JSON.stringify(after) === JSON.stringify(rolledBack), saved, stale, previewInvalidated: !preview.blob, replaced: replaced.snapshots.a.replacement, counts }
  })
  expect(result.accesses.filter(x => x === 'add:canvas-snapshots')).toHaveLength(1)
  expect(result.accesses).not.toContain('add:canvas-assets')
  expect(result.accesses).not.toContain('get:canvas-snapshots')
  expect(result.accesses).not.toContain('get:canvas-assets')
  expect(result).toMatchObject({ oldPreserved: true, coldExact: true, shared: true, rollbackExact: true, saved: true, stale: false, previewInvalidated: true, replaced: true, counts: [0, 0, 0] })
  expect(result.failure).toContain('QuotaExceededError')
})

test('worker previews match native pixels exactly, preserve inputs, persist PNGs and cancel stale work', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const result = await page.evaluate(async () => {
    const t = (window as any).engineTest, s = (window as any).scene
    t.apply([true, false].flatMap((simulatePressure, i) => [false, true].map((closed, j) => ({ type: 'create_element', id: `stroke-${i}-${j}`, elementType: 'freedraw', x: i * 140, y: j * 140,
      props: { points: [[0, 0], [100, 20], [90, 90], ...(closed ? [[0, 0]] : [[20, 60]])], pressures: [.1, .9, .2, .8], simulatePressure, strokeWidth: 2, backgroundColor: closed ? '#dddddd' : 'transparent' } }))))
    const snapshot = s.snapshot(), original = JSON.stringify(snapshot), elements = snapshot.document.elements, files = snapshot.document.files
    const options = { files, appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false }, exportPadding: 24, maxWidthOrHeight: 1400 }
    const native = await t.exportToCanvas({ ...options, elements: structuredClone(elements) })
    const worker = await t.exportToCanvas({ ...options, elements: elements.map(t.clonePreviewElement), checkpoint: async () => {}, prepareFreeDraw: (e: any) => t.previewGeometry.prepare(e, new AbortController().signal) })
    const pixels = native.toDataURL() === worker.toDataURL()
    const aborted = new AbortController(); aborted.abort(new DOMException('Test cancellation', 'AbortError'))
    let cancel = ''; try { await t.previewGeometry.prepare(elements[0], aborted.signal) } catch (e) { cancel = (e as Error).name }
    const active = new AbortController(), large = { ...elements[0], points: Array.from({ length: 50000 }, (_, i) => [i / 100, Math.sin(i / 10)]), pressures: [], simulatePressure: true }
    const pending = t.previewGeometry.prepare(large, active.signal); active.abort(new DOMException('Seek changed', 'AbortError'))
    let activeCancel = ''; try { await pending } catch (e) { activeCancel = (e as Error).name }
    const resumed = await t.previewGeometry.prepare(elements[0], new AbortController().signal)
    const repo = t.workspaceRepository, projectId = 'preview-test'
    await repo.save({ project: { id: projectId, title: 'Test', headCommitId: 'a', createdAt: 1, updatedAt: 1 }, captures: [], snapshots: { a: snapshot } })
    const stored = await repo.load(projectId), identity = t.previewIdentity(projectId, 'a', stored.snapshots.a)
    const request = t.canvasPreviews.acquire(identity, stored.snapshots.a, 1400)
    const canvas = await request.promise; await request.persisted; request.release()
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('galta-v1'); r.onsuccess = () => resolve(r.result) })
    const rows: any[] = await new Promise(resolve => { const r = db.transaction('canvas-previews').objectStore('canvas-previews').getAll(); r.onsuccess = () => resolve(r.result) }); db.close()
    const fresh = new t.canvasPreviews.constructor()
    const backgroundBitmap = fresh.acquire(identity, stored.snapshots.a, 240, 2)
    const backgroundResult = await backgroundBitmap.promise; backgroundBitmap.release()
    const decoded = await createImageBitmap(rows[0].blob), copy = document.createElement('canvas'); copy.width = decoded.width; copy.height = decoded.height; copy.getContext('2d')!.drawImage(decoded, 0, 0); decoded.close()
    return { activeCancel, resumed: typeof resumed === 'string', backgroundDecoded: !!backgroundResult && Math.max(backgroundResult.width, backgroundResult.height) === 240, pixels, unmodified: JSON.stringify(snapshot) === original, cancel, persisted: rows.length === 1 && rows[0].blob.type === 'image/png', lossless: copy.toDataURL() === canvas.toDataURL() }
  })
  expect(result).toEqual({ activeCancel: 'AbortError', resumed: true, backgroundDecoded: true, pixels: true, unmodified: true, cancel: 'AbortError', persisted: true, lossless: true })
  expect(errors).toEqual([])
})

test('cooperative startup can be cancelled, and zoom settles without changing artwork or history', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const t = (window as any).engineTest, scene = (window as any).scene
    t.apply([{ type: 'create_element', id: 'stroke', elementType: 'freedraw', x: 100, y: 100, props: { points: Array.from({ length: 3000 }, (_, i) => [i / 30, Math.sin(i / 15) * 20]) } }])
    const original = scene.snapshot(), before = JSON.stringify(original.document)
    let cancelled = false
    try { await scene.restoreCooperatively(original, { checkpoint() { throw new DOMException('Closed during startup', 'AbortError') }, check() {} }) }
    catch (error) { cancelled = (error as Error).name === 'AbortError' }
    const preservedAfterCancel = before === JSON.stringify(scene.snapshot().document)
    const zoom = scene.view.zoom
    for (let i = 0; i < 4; i++) { scene.zoomBy(1.25); await new Promise(resolve => setTimeout(resolve, 20)) }
    for (let i = 0; i < 4; i++) { scene.zoomBy(.8); await new Promise(resolve => setTimeout(resolve, 20)) }
    await new Promise(resolve => setTimeout(resolve, 500))
    return { cancelled, preservedAfterCancel, preservedAfterZoom: before === JSON.stringify(scene.snapshot().document), zoom, finalZoom: scene.view.zoom, exactRendering: !scene.api.getAppState().shouldCacheIgnoreZoom }
  })
  expect(result).toMatchObject({ cancelled: true, preservedAfterCancel: true, preservedAfterZoom: true, exactRendering: true })
  expect(result.finalZoom).toBeCloseTo(result.zoom)
})

test('a rendered preview is available before cache persistence and survives a cache write failure', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const t = (window as any).engineTest, repo = t.workspaceRepository
    t.apply([{ type: 'create_element', id: 'preview-pipeline', elementType: 'rectangle', x: 10, y: 20, props: { width: 100, height: 80 } }])
    const snapshot = (window as any).scene.snapshot(), projectId = 'preview-pipeline'
    await repo.save({ project: { id: projectId, title: 'Test', headCommitId: 'a', createdAt: 1, updatedAt: 1 }, captures: [], snapshots: { a: snapshot } })
    const stored = await repo.load(projectId), identity = t.previewIdentity(projectId, 'a', stored.snapshots.a)
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const save = repo.savePreview
    repo.savePreview = async () => { enter(); await gate; throw new DOMException('Test preview cache quota', 'QuotaExceededError') }
    let visible = false, renderFailed = false, persistenceFailed = false
    const request = t.canvasPreviews.acquire(identity, stored.snapshots.a, 280)
    const displayed = request.promise.then((canvas: HTMLCanvasElement) => { visible = canvas.width > 0 }, () => { renderFailed = true })
    const persistence = request.persisted?.catch(() => { persistenceFailed = true })
    try {
      await entered
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const visibleBeforePersistence = visible
      release(); await displayed; await persistence
      const cached = t.canvasPreviews.acquire(identity, stored.snapshots.a, 280)
      const cachedCanvas = await cached.promise.catch(() => null); cached.release()
      return { visibleBeforePersistence, visible, renderFailed, persistenceFailed, cachedAvailable: !!cachedCanvas }
    } finally { release(); repo.savePreview = save; request.release() }
  })
  expect(result).toEqual({ visibleBeforePersistence: true, visible: true, renderFailed: false, persistenceFailed: true, cachedAvailable: true })
})

test('preview consumers share work, release independently and fence late persistence after replacement', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const t = (window as any).engineTest, repo = t.workspaceRepository, projectId = 'preview-fence'
    t.apply([{ type: 'create_element', id: 'preview-fence', elementType: 'rectangle', x: 10, y: 20, props: { width: 100, height: 80 } }])
    const snapshot = (window as any).scene.snapshot()
    await repo.save({ project: { id: projectId, title: 'Test', headCommitId: 'a', createdAt: 1, updatedAt: 1 }, captures: [], snapshots: { a: snapshot } })
    const stored = await repo.load(projectId), identity = t.previewIdentity(projectId, 'a', stored.snapshots.a)
    let enter!: () => void, release!: () => void, writes = 0
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const save = repo.savePreview
    repo.savePreview = async (...args: any[]) => { writes++; enter(); await gate; return save.apply(repo, args) }
    const first = t.canvasPreviews.acquire(identity, stored.snapshots.a, 1400), second = t.canvasPreviews.acquire(identity, stored.snapshots.a, 280)
    const completion = second.persisted.then(() => false, () => true)
    first.release()
    try {
      const firstResult = await first.promise, canvas = await second.promise
      await entered
      await repo.update(projectId, (current: any) => ({ ...current, snapshots: { ...current.snapshots, a: { ...current.snapshots.a, replaced: true } } }))
      release()
      const fenced = await completion
      const saved = await repo.load(projectId)
      const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('galta-v1'); r.onsuccess = () => resolve(r.result) })
      const count = await new Promise<number>(resolve => { const r = db.transaction('canvas-previews').objectStore('canvas-previews').count(IDBKeyRange.bound([projectId], [projectId, []])); r.onsuccess = () => resolve(r.result) }); db.close()
      return { firstReleased: firstResult === null, secondRendered: canvas.width > 0 && Math.max(canvas.width, canvas.height) <= 280, writes, fenced, replacementPreserved: saved.snapshots.a.replaced, stalePreviews: count }
    } finally { release(); repo.savePreview = save; second.release() }
  })
  expect(result).toEqual({ firstReleased: true, secondRendered: true, writes: 1, fenced: true, replacementPreserved: true, stalePreviews: 0 })
})

test('slow persistence does not stall newer frames or retain an unbounded bitmap queue', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const t = (window as any).engineTest, repo = t.workspaceRepository, projectId = 'preview-backpressure'
    t.apply([{ type: 'create_element', id: 'large-preview', elementType: 'rectangle', x: 0, y: 0, props: { width: 1400, height: 1400 } }])
    const snapshot = (window as any).scene.snapshot()
    const snapshots = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i), { ...snapshot, document: { ...snapshot.document, elements: snapshot.document.elements.map((e: any) => ({ ...e, x: i })) } }]))
    await repo.save({ project: { id: projectId, title: 'Test', headCommitId: '11', createdAt: 1, updatedAt: 1 }, captures: [], snapshots })
    const stored = await repo.load(projectId), service = new t.canvasPreviews.constructor()
    let enter!: () => void, release!: () => void, active = 0, maxActive = 0
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const save = repo.savePreview
    repo.savePreview = async (...args: any[]) => { active++; maxActive = Math.max(maxActive, active); enter(); await gate; try { return await save.apply(repo, args) } finally { active-- } }
    const requests: any[] = [], results: Promise<string>[] = []
    let rendered = 0
    const acquire = (i: number) => {
      const request = service.acquire(t.previewIdentity(projectId, String(i), stored.snapshots[i]), stored.snapshots[i], 1400)
      requests.push(request); results.push(request.persisted.then(() => 'saved', (e: Error) => e.name))
      return request.promise.then((canvas: HTMLCanvasElement) => { if (canvas.width > 0) rendered++; canvas.width = canvas.height = 0 })
    }
    try {
      await acquire(0); await entered
      const remaining = Promise.all(Array.from({ length: 11 }, (_, i) => acquire(i + 1)))
      let timer: ReturnType<typeof setTimeout>
      const responsive = await Promise.race([remaining.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3000) })])
      clearTimeout(timer!)
      const beforeRelease = rendered
      release(); await remaining
      const outcomes = await Promise.all(results), preserved = await repo.load(projectId)
      return { responsive, beforeRelease, maxActive, budgetReclaimed: outcomes.includes('AbortError'), saved: outcomes.filter(x => x === 'saved').length, artworkCount: Object.keys(preserved.snapshots).length }
    } finally { release(); repo.savePreview = save; for (const request of requests) request.release() }
  })
  expect(result).toMatchObject({ responsive: true, beforeRelease: 12, maxActive: 1, budgetReclaimed: true, artworkCount: 12 })
  expect(result.saved).toBeGreaterThan(0)
  expect(result.saved).toBeLessThanOrEqual(5)
})

test('previews other than the kept version are released, and no other canvas is touched', async ({ page }) => {
  const left = await page.evaluate(async () => {
    const t = (window as any).engineTest, repo = new t.IndexedDbWorkspaceRepository('galta-prune-test')
    await repo.open().then((db: IDBDatabase) => db.close())
    const db: IDBDatabase = await new Promise(resolve => { const r = indexedDB.open('galta-prune-test'); r.onsuccess = () => resolve(r.result) })
    await new Promise<void>(resolve => {
      const tx = db.transaction('canvas-previews', 'readwrite'), store = tx.objectStore('canvas-previews')
      for (const [project, commit, appearance] of [['p', 'a', 'x'], ['p', 'b', 'x'], ['p', 'b', 'y'], ['p', 'c', 'x'], ['q', 'a', 'x']]) store.put({ snapshotRef: commit }, [project, commit, appearance])
      tx.oncomplete = () => resolve()
    })
    db.close()
    await repo.prunePreviews('p', 'b')
    const again: IDBDatabase = await new Promise(resolve => { const r = indexedDB.open('galta-prune-test'); r.onsuccess = () => resolve(r.result) })
    const keys = await new Promise<unknown[]>(resolve => { const r = again.transaction('canvas-previews').objectStore('canvas-previews').getAllKeys(); r.onsuccess = () => resolve(r.result) })
    again.close()
    return keys
  })
  expect(left).toEqual([['p', 'b', 'x'], ['p', 'b', 'y'], ['q', 'a', 'x']])
})

test('every canvas keeps only its current version’s previews when all are released at once', async ({ page }) => {
  const left = await page.evaluate(async () => {
    const t = (window as any).engineTest, repo = new t.IndexedDbWorkspaceRepository('galta-prune-all-test')
    await repo.list()
    const db: IDBDatabase = await new Promise(resolve => { const r = indexedDB.open('galta-prune-all-test'); r.onsuccess = () => resolve(r.result) })
    await new Promise<void>(resolve => {
      const tx = db.transaction(['canvas-catalog', 'canvas-previews'], 'readwrite'), catalog = tx.objectStore('canvas-catalog'), previews = tx.objectStore('canvas-previews')
      catalog.put({ id: 'p', title: 'P', createdAt: 1, updatedAt: 1, lastOpenedAt: 1, headCommitId: 'b' }); catalog.put({ id: 'q', title: 'Q', createdAt: 1, updatedAt: 1, lastOpenedAt: 1, headCommitId: 'a' })
      for (const [project, commit, appearance] of [['p', 'a', 'x'], ['p', 'b', 'x'], ['p', 'c', 'x'], ['q', 'a', 'y'], ['q', 'z', 'y']]) previews.put({ snapshotRef: commit }, [project, commit, appearance])
      tx.oncomplete = () => resolve()
    })
    db.close()
    await repo.pruneAllPreviews()
    const again: IDBDatabase = await new Promise(resolve => { const r = indexedDB.open('galta-prune-all-test'); r.onsuccess = () => resolve(r.result) })
    const keys = await new Promise<unknown[]>(resolve => { const r = again.transaction('canvas-previews').objectStore('canvas-previews').getAllKeys(); r.onsuccess = () => resolve(r.result) })
    again.close()
    return keys
  })
  expect(left).toEqual([['p', 'b', 'x'], ['q', 'a', 'y']])
})

