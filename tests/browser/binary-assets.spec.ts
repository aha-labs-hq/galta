import { test, expect } from '@playwright/test'

test('v5 asset upgrade preserves exact source bytes and snapshot identity while removing stored base64', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8uoAAAAASUVORK5CYII='
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('binary-upgrade-test', 5)
      r.onupgradeneeded = () => {
        r.result.createObjectStore('workspaces', { keyPath: 'project.id' })
        r.result.createObjectStore('canvas-catalog', { keyPath: 'id' })
        for (const name of ['canvas-views', 'canvas-snapshots', 'canvas-assets', 'canvas-previews']) r.result.createObjectStore(name)
      }
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['workspaces', 'canvas-assets', 'canvas-snapshots'], 'readwrite')
      tx.objectStore('workspaces').put({ storageVersion: 1, project: { id: 'upgrade', headCommitId: 'a' }, revision: 7, snapshots: { a: 'snapshot', b: 'snapshot' }, assets: ['asset'], captures: [] })
      tx.objectStore('canvas-assets').put({ id: 'image', mimeType: 'image/png', created: 1, dataURL: png }, ['upgrade', 'asset'])
      tx.objectStore('canvas-snapshots').put({ value: { document: { elements: [], files: { image: null } } }, assets: [{ path: ['document', 'files', 'image'], id: 'asset' }] }, ['upgrade', 'snapshot'])
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    })
    db.close()
    const t = (window as any).engineTest, bundle = await new t.IndexedDbWorkspaceRepository('binary-upgrade-test').load('upgrade')
    const file = bundle.snapshots.a.document.files.image
    const data = await (await fetch(png)).arrayBuffer()
    return { binary: file.blob instanceof Blob, noURL: !('dataURL' in file), sameBytes: Array.from(new Uint8Array(await file.blob.arrayBuffer())).join() === Array.from(new Uint8Array(data)).join(), shared: bundle.snapshots.a === bundle.snapshots.b, revision: bundle.revision, snapshotRef: t.snapshotReference(bundle.snapshots.a) }
  })
  expect(result).toEqual({ binary: true, noURL: true, sameBytes: true, shared: true, revision: 7, snapshotRef: 'snapshot' })
})
