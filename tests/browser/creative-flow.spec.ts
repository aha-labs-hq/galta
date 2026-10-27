import { acceptanceOrigin } from '../../scripts/lib/acceptance'
import { installReturningAccount } from '../helpers/canvas-port'
import { test, expect, type Page } from '@playwright/test'

import { storedWorkspace as workspace, seedWorkspace } from '../helpers/stored-workspace'
const image = (i: number) => ({ name: `reference-${i}.svg`, mimeType: 'image/svg+xml', buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${240 + i * 40}" height="${320 + i * 35}"><rect width="100%" height="100%" fill="${['#becbd4','#dbd0c6','#bdb8cd','#c6ccbf'][i]}"/><circle cx="120" cy="140" r="70" fill="#ffffff" fill-opacity=".5"/></svg>`) })
async function fit(page: Page) {
  await page.getByRole('button', { name: 'Canvas zoom', exact: true }).click()
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await page.getByRole('button', { name: 'Canvas zoom', exact: true }).click()
}

test('real production controls: deselect, local tidy, undo, persistence and compact placement', async ({ page }) => {
  await installReturningAccount(page)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.locator('nav input[type=file]').setInputFiles([image(0), image(1), image(2), image(3)])
  await expect(page.getByRole('region', { name: 'Galta canvas, 4 objects', exact: true })).toBeVisible()
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await expect(page.locator('.selection-actions')).toBeVisible()
  await page.mouse.click(400, 650)
  await expect(page.locator('.selection-actions')).toHaveCount(0)
  await page.keyboard.press('Meta+a')
  await expect(page.getByRole('button', { name: 'Tidy', exact: true })).toBeVisible()
  const before = await workspace(page), old = before.snapshots[before.project.headCommitId].document
  await page.getByRole('button', { name: 'Tidy', exact: true }).click()
  await expect.poll(async () => (await workspace(page)).project.headCommitId).not.toBe(before.project.headCommitId)
  const after = await workspace(page), arranged = after.snapshots[after.project.headCommitId].document
  expect(Object.keys(arranged.files)).toEqual(Object.keys(old.files))
  const bounds = arranged.elements.map((el: any) => ({ x: el.x, y: el.y, w: el.width, h: el.height }))
  expect(new Set(bounds.map((el: any) => Math.round(el.x))).size).toBe(2)
  for (let i = 0; i < bounds.length; i++) for (let j = i + 1; j < bounds.length; j++) {
    const a = bounds[i], b = bounds[j]
    expect(a.x+a.w <= b.x+.01 || b.x+b.w <= a.x+.01 || a.y+a.h <= b.y+.01 || b.y+b.h <= a.y+.01).toBe(true)
  }
  await page.locator('.excalidraw').focus()
  await page.keyboard.press('Meta+z')
  await expect.poll(async () => { const w = await workspace(page); return w.snapshots[w.project.headCommitId].document.elements.map((el: any) => [el.x,el.y,el.width,el.height]) }).toEqual(old.elements.map((el: any) => [el.x,el.y,el.width,el.height]))
  await page.keyboard.press('Meta+Shift+z')
  await expect.poll(async () => { const w = await workspace(page); return w.snapshots[w.project.headCommitId].document.elements.map((el: any) => [el.x,el.y,el.width,el.height]) }).toEqual(arranged.elements.map((el: any) => [el.x,el.y,el.width,el.height]))
  await fit(page)
  for (const width of [700, 480, 360]) {
    await page.setViewportSize({ width, height: 950 })
    await fit(page)
    const actions = page.locator('.selection-actions')
    await expect(actions).toBeVisible()
    const box = (await actions.boundingBox())!, composer = (await page.locator('.conversation-dock').boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(8); expect(box.x + box.width).toBeLessThanOrEqual(width - 8)
    expect(box.y + box.height).toBeLessThan(composer.y)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(page.locator('.galta-canvas')).toHaveJSProperty('clientWidth', 1440)
  await expect.poll(() => page.locator('canvas.excalidraw__canvas.static').evaluate(canvas => (canvas as HTMLCanvasElement).width / devicePixelRatio)).toBe(1440)
  // Deselect on empty canvas: the arranged photos sit near the center, so the
  // right side of a 1440 px canvas is clear whatever the composer height.
  await page.mouse.click(1300, 500)
  await expect(page.locator('.excalidraw')).toBeFocused()
  await expect(page.locator('.selection-actions')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('region', { name: 'Galta canvas, 4 objects', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('slow website import stays at its scene point, finishes before history opens and fails locally', async ({ page }) => {
  await page.goto('/dev/verification.html')
  await page.locator('nav input[type=file]').setInputFiles(image(0))
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect.poll(async () => Object.keys((await workspace(page))?.snapshots ?? {}).length).toBe(2)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('https://images.test/slow.svg', async route => { await held; await route.fulfill({ contentType: 'image/svg+xml', headers: { 'access-control-allow-origin':'*' }, body: image(1).buffer }) })
  const drop = async (url: string) => {
    await page.locator('.galta-canvas').evaluate((el, url) => {
      const rect = el.getBoundingClientRect(), data = new DataTransfer()
      data.setData('application/x-galta-reference', JSON.stringify({ url, sourceUrl: 'https://images.test/gallery' }))
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: rect.x+400, clientY: rect.y+350, dataTransfer: data }))
    }, url)
  }
  await drop('https://images.test/slow.svg')
  await expect(page.locator('.pending-image')).toContainText('Adding media')
  const pending = (await page.locator('.pending-image').boundingBox())!, canvas = (await page.locator('.galta-canvas').boundingBox())!
  expect(pending.x+pending.width/2-canvas.x).toBeCloseTo(400, 0)
  expect(pending.y+pending.height/2-canvas.y).toBeCloseTo(350, 0)
  await expect(page.getByRole('button', { name: 'Open Time Machine', exact: true })).toBeDisabled()
  release()
  await expect(page.getByRole('region', { name: 'Galta canvas, 2 objects', exact: true })).toBeVisible()
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open Time Machine', exact: true })).toBeEnabled()
  await page.route('https://images.test/fail.svg', route => route.fulfill({ status:403, headers: { 'access-control-allow-origin':'*' } }))
  await drop('https://images.test/fail.svg')
  await expect(page.locator('.pending-image')).toContainText('403')
  await page.getByRole('button', { name: 'Dismiss media import' }).click()
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await expect.poll(async () => Object.keys((await workspace(page)).snapshots).length).toBe(3)
})

test('submitted selection and captured bytes stay fixed across live edits and deletion', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const w=window as any, s=w.scene, t=w.engineTest
    const c=document.createElement('canvas');c.width=120;c.height=180;const ctx=c.getContext('2d')!;ctx.fillStyle='#b8c7cd';ctx.fillRect(0,0,120,180)
    const first=c.toDataURL();const [one]=await t.import(first,{x:400,y:400})
    const selected = (id: string) => new Promise<void>(resolve => {
      if (s.selectedIds.includes(id)) { resolve(); return }
      const off=s.api.onChange(() => { if (s.selectedIds.includes(id)) { off(); resolve() } })
    })
    await selected(one)
    const submitted=t.captureSubmittedContext(s)
    const pendingPreview=s.preview()
    ctx.fillStyle='#d9bfb8';ctx.fillRect(0,0,120,180);const [two]=await t.import(c.toDataURL(),{x:700,y:400})
    await selected(two)
    w.testArtifacts.writeImage=async()=>({})
    const tool=t.capturedTool(submitted),scope={executionId:'context-execution',provenance:{providerId:'test',sessionId:'context-thread',turnId:'context-turn'},cwd:'/tmp/context-test',signal:new AbortController().signal}
    const read=JSON.parse((await tool.execute('canvas_inspect',{},scope)).content[0].text)
    const live=[...s.selectedIds]
    s.replace(s.elements.filter((el:any)=>el.id!==one));s.select([])
    const captured=JSON.parse((await tool.execute('canvas_extract',{element:one},scope)).content[0].text)
    let missing='';try{await tool.execute('canvas_extract',{element:'not-on-canvas'},scope)}catch(e){missing=String(e)}
    const preview=await createImageBitmap(await pendingPreview), pixels=document.createElement('canvas');pixels.width=preview.width;pixels.height=preview.height;const p=pixels.getContext('2d')!;p.drawImage(preview,0,0)
    return {one,two, submitted:submitted.selection, read:read.elements.filter((el:any)=>el.selectedAtSubmission).map((el:any)=>el.id), live, bytes:captured.source==='submitted', missing, previewPixel:[...p.getImageData(pixels.width/2,pixels.height/2,1,1).data].slice(0,3)}
  })
  expect(result.submitted).toEqual([result.one]);expect(result.read).toEqual([result.one]);expect(result.live).toEqual([result.two])
  expect(result.bytes).toBe(true);expect(result.missing).toContain('no extractable source')
  result.previewPixel.forEach((v:number,i:number)=>expect(Math.abs(v-[184,199,205][i]!)).toBeLessThan(3))
})

test('saving an imported image can be retried without downloading or duplicating it', async ({ page }) => {
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect.poll(async () => Object.keys((await workspace(page))?.snapshots ?? {}).length).toBe(1)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'workspaces') { IDBObjectStore.prototype.put = put; throw new DOMException('Acceptance storage failure', 'QuotaExceededError') }
      return put.apply(this, args)
    }
  })
  await page.locator('nav input[type=file]').setInputFiles(image(0))
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
  await expect(page.locator('.pending-image')).toContainText('Media added, but not saved')
  expect(Object.keys((await workspace(page)).snapshots)).toHaveLength(1)
  await page.getByRole('button', { name: 'Retry saving media', exact: true }).click()
  await expect(page.locator('.pending-image')).toHaveCount(0)
  await expect.poll(async () => Object.keys((await workspace(page)).snapshots).length).toBe(2)
  await page.reload()
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
})

test('tidy preserves rotation, aspect ratio and unselected objects', async ({ page }) => {
  await page.goto('/dev/scene-test.html')
  await page.waitForFunction(() => Boolean((window as any).engineTest))
  const result = await page.evaluate(async () => {
    const { scene: s, engineTest: t } = window as any
    const c=document.createElement('canvas');c.width=200;c.height=300;const ctx=c.getContext('2d')!;ctx.fillRect(0,0,200,300)
    const ids:string[]=[]
    for (let i=0;i<3;i++) ids.push(...await t.import(c.toDataURL(),{x:400+i*50,y:300+i*40}))
    t.apply([{type:'update_element',elementId:ids[0],rotation:Math.PI/4}])
    s.select(ids.slice(0,2))
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))
    const before=structuredClone(s.elements), files=JSON.stringify(s.files)
    t.tidySelectedImages(s)
    const after=structuredClone(s.elements)
    s.select([])
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))
    let invalid='';try {t.tidySelectedImages(s)}catch(e){invalid=String(e)}
    return {before,after,sameFiles:files===JSON.stringify(s.files),invalid}
  })
  expect(result.after[2]).toEqual(result.before[2]);expect(result.sameFiles).toBe(true)
  for (let i=0;i<2;i++) { expect(result.after[i].angle).toBe(result.before[i].angle);expect(result.after[i].width/result.after[i].height).toBeCloseTo(result.before[i].width/result.before[i].height) }
  expect(result.invalid).toContain('at least two images')
})

test('draft text survives session changes and reopening', async ({ page }) => {
  await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await page.locator('nav input[type=file]').setInputFiles(image(0))
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('Keep the composition; soften the light.')
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await page.getByRole('button', { name: 'New conversation', exact: true }).click()
  await expect(page.locator('.conversation-sheet')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toBeFocused()
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Ask Galta', exact: true }).fill('A different direction.')
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Switch conversation', exact: true }).click()
  await page.getByRole('menuitemradio', { name: /New conversation Draft: Keep the composition/ }).click()
  await expect(page.getByRole('button', { name: 'Switch conversation', exact: true })).toBeFocused()
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('Keep the composition; soften the light.')
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Ask Galta', exact: true })).toHaveValue('Keep the composition; soften the light.')
  await expect(page.getByRole('region', { name: 'Galta canvas, 1 objects', exact: true })).toBeVisible()
})

test('text drafts survive the upgrade that drops retained reference images', async ({ page }) => {
  await installReturningAccount(page)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  const input = page.getByRole('textbox', { name: 'Ask Galta', exact: true })
  await input.fill('Keep this draft through the upgrade.')
  const saved = async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('galta-message-drafts'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    const rows = await new Promise<any[]>((resolve, reject) => { const r = db.transaction('messages').objectStore('messages').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    db.close(); return rows
  })
  await expect.poll(async () => (await saved()).map(row => row.command)).toEqual(['Keep this draft through the upgrade.'])
  const [row] = await saved()
  // Rebuild the version 1 layout: a retained reference image and its removal journal.
  await page.goto(`${acceptanceOrigin}/draft-upgrade-fixture`)
  await page.evaluate(async ({ projectId, sessionId, command }) => {
    await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase('galta-message-drafts'); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error) })
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('galta-message-drafts', 1)
      r.onupgradeneeded = () => {
        r.result.createObjectStore('messages', { keyPath: ['projectId', 'sessionId'] }).createIndex('projectId', 'projectId')
        r.result.createObjectStore('references', { keyPath: 'id' })
      }
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['messages', 'references'], 'readwrite')
      tx.objectStore('messages').put({ projectId, sessionId, command, references: ['reference-1'] })
      tx.objectStore('references').put({ id: 'reference-1', sourceShapeId: 'shape', width: 1, height: 1, file: { id: 'file', mimeType: 'image/png', blob: new Blob(['image']) } })
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error)
    })
    db.close()
    localStorage.setItem(`galta-message-draft-pending:${projectId}:${sessionId}`, JSON.stringify({ removedReferenceIds: ['reference-0'] }))
  }, row)
  await page.goto(`${acceptanceOrigin}/sidepanel/index.html`)
  await expect(input).toHaveValue('Keep this draft through the upgrade.')
  await page.goto(`${acceptanceOrigin}/draft-upgrade-fixture`)
  const upgraded = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('galta-message-drafts'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    const result = { version: db.version, stores: [...db.objectStoreNames], journal: Object.keys(localStorage).filter(key => key.startsWith('galta-message-draft-pending:')) }
    db.close(); return result
  })
  expect(upgraded).toEqual({ version: 2, stores: ['messages'], journal: [] })
})
