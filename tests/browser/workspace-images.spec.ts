import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

test('image-heavy history compacts on write and survives a durable image import and reload', async ({ page }) => {
  test.setTimeout(120_000)
  const fixture = process.env.GALTA_IMAGE_HISTORY_FIXTURE ? JSON.parse(readFileSync(process.env.GALTA_IMAGE_HISTORY_FIXTURE, 'utf8')) : null
  const preview = process.env.GALTA_IMAGE_HISTORY_PREVIEW
    ? 'data:image/png;base64,' + readFileSync(process.env.GALTA_IMAGE_HISTORY_PREVIEW).toString('base64')
    : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8uoAAAAASUVORK5CYII='
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async ({ fixture, preview }) => {
    const w = window as any, scene = w.scene, repo = w.engineTest.repository
    const workspaceModule = '/canvas/workspace.ts', toolModule = '/canvas/canvasTool.ts'
    const { createInitialWorkspace, defaultRuntime, stageAgentSnapshot, activateCanvasSnapshot } = await import(workspaceModule)
    const { CanvasTool, canvasRevision } = await import(toolModule)
    let bundle: any
    if (fixture) {
      bundle = fixture.workspace
      for (const snapshot of Object.values(bundle.snapshots) as any[]) {
        snapshot.document.files = Object.fromEntries(Object.entries(snapshot.document.files).map(([id, index]) => [id, structuredClone(fixture.images[index as number])]))
      }
    } else {
      bundle = createInitialWorkspace('image-history-test')
      const snapshot = scene.snapshot(), file = { id: 'history-image', dataURL: 'data:image/png;base64,' + btoa(atob(preview.split(',')[1]!) + 'a'.repeat(48_000)), mimeType: 'image/png', created: 1 }
      // Unreferenced historical bytes exercise storage sharing without decoding
      // the padded fixture as artwork. Real-incident runs use the actual images.
      snapshot.document.files = { [file.id]: file }
      bundle.snapshots = Object.fromEntries(Array.from({ length: 176 }, (_, index) => [String(index), structuredClone(snapshot)]))
      bundle.snapshots[bundle.project.headCommitId] = scene.snapshot()
    }
    const head = bundle.project.headCommitId, revision = bundle.revision ?? 0
    const originalIds = Object.keys(bundle.snapshots), originals: Record<string, string> = {}
    const digest = async (value: unknown) => {
      const copy = structuredClone(value) as any
      for (const file of Object.values(copy?.document?.files ?? {}) as any[]) if (file.blob instanceof Blob) {
        const bytes = new Uint8Array(await file.blob.arrayBuffer()), chunks = []
        for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)))
        file.dataURL = `data:${file.mimeType};base64,${btoa(chunks.join(''))}`; delete file.blob
      }
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(copy, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v))))).map(b => b.toString(16).padStart(2, '0')).join('')
    }
    for (const id of originalIds) originals[id] = await digest(bundle.snapshots[id])
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('galta-migration-test', 2)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('workspaces', { keyPath: 'project.id' })
        request.result.createObjectStore('migration-backups', { keyPath: 'project.id' })
      }
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    // Ordinary-origin IndexedDB rejects the incident's old 776 MB value before
    // storage (133 MB limit). Exercise the fixed writer for that full fixture;
    // the bounded synthetic case also covers reads of the old representation.
    if (fixture) await repo.save(bundle)
    else await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('workspaces', 'readwrite'); tx.objectStore('workspaces').put(bundle)
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error)
    })
    const projectId = bundle.project.id
    bundle = null
    db.close() // Release the v2 seeding connection before the repository upgrades storage.
    const compact = await repo.update(projectId, (current: any) => current)
    if (compact.project.headCommitId !== head || (compact.revision ?? 0) !== revision) throw Error('Compaction changed logical state')
    const reread = await repo.load(projectId)
    const files = Object.values(reread.snapshots).flatMap((snapshot: any) => Object.values(snapshot.document.files))
    const distinctFiles = new Set(files).size
    if (distinctFiles >= files.length) throw Error('IndexedDB did not retain shared image records')
    scene.restore(compact.snapshots[head])
    let candidateId: string | undefined
    const tool = new CanvasTool(scene, { readImage: async () => ({ dataUrl: preview }) }, async (mutation: any) => {
      await repo.update(projectId, (current: any) => {
        mutation.assertCurrent()
        const staged = stageAgentSnapshot(current, head, mutation.before, mutation.snapshot, defaultRuntime)
        candidateId = staged.candidateId
        return staged.workspace
      })
      mutation.apply()
      await repo.update(projectId, (current: any) => activateCanvasSnapshot(current, candidateId, scene.snapshot().view))
    })
    const placed = await tool.execute('canvas_place', { revision: canvasRevision(scene), path: '/tmp/preview.png' }, { executionId: 'memory-test', cwd: '/tmp', signal: new AbortController().signal })
    const saved = await repo.load(projectId)
    for (const id of originalIds) if (originals[id] !== await digest(saved.snapshots[id])) throw Error(`Historical pixels or artwork changed: ${id}`)
    if (!saved.snapshots[candidateId!].document.files) throw Error('Missing imported bytes')
    sessionStorage.setItem('memory-test-project', projectId)
    sessionStorage.setItem('memory-test-head', candidateId!)
    return { originalSnapshots: originalIds.length, savedSnapshots: Object.keys(saved.snapshots).length, distinctFiles, fileReferences: files.length, placed: JSON.parse(placed.content[0].text).placed, allOriginalSnapshotsPreserved: true, elements: scene.elements.length }
  }, { fixture, preview })
  expect(result.placed).toBe(true)
  expect(result.allOriginalSnapshotsPreserved).toBe(true)
  expect(result.savedSnapshots).toBeGreaterThan(result.originalSnapshots)
  expect(result.distinctFiles).toBeLessThan(result.fileReferences / 5)
  await page.reload()
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const reopened = await page.evaluate(async () => {
    const w = window as any, saved = await w.engineTest.repository.load(sessionStorage.getItem('memory-test-project'))
    if (saved.project.headCommitId !== sessionStorage.getItem('memory-test-head')) throw Error('Imported version was not reopened')
    w.scene.restore(saved.snapshots[saved.project.headCommitId])
    return { elements: w.scene.elements.length, snapshots: Object.keys(saved.snapshots).length }
  })
  expect(reopened.elements).toBe(result.elements)
  expect(reopened.snapshots).toBe(result.savedSnapshots)
  expect(errors).toEqual([])
  await page.screenshot({ path: test.info().outputPath('imported-preview.png') })
  console.log('Image history verification:', JSON.stringify({ ...result, reopened }))
})
