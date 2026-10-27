import type { CanvasScene } from '../canvas/scene'
import { CanvasTool, canvasRevision } from '../canvas/canvasTool'
import { captureSubmittedContext } from '../canvas/context'
import { applyCreativeOperations } from '../canvas/patchExecutor'
import { placeImage, prepareImage } from '../canvas/imageImport'
import type { CanvasArtifacts, ToolResult } from '@galta/canvas'
import { CANVAS_PAGE_MAX } from '@galta/canvas'

// Test-only browser entry: exercises the real renderer and public canvas-tool
// boundary in a disposable scene. No extension workspace is opened or written.
export async function runCapabilityChecks(scene: CanvasScene) {
  const scope = { executionId: 'capability-check', provenance: { providerId: 'test', sessionId: 'capability-check', turnId: 'check' }, cwd: '/tmp/galta-capability-check', signal: new AbortController().signal }
  const checks: Array<{ name: string; passed: boolean; evidence?: unknown; error?: string }> = []
  const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const state = (result: ToolResult) => JSON.parse(result.content.find(item => item.type === 'text')!.text)
  const blank = scene.snapshot()
  const writes: Array<{ path: string; dataBase64: string }> = []
  let replacement = '', duringWrite = () => {}
  const artifacts: CanvasArtifacts = {
    writeImage: async (path, dataBase64) => { writes.push({ path, dataBase64 }); duringWrite() },
    readImage: async () => ({ dataUrl: replacement }),
    readHtml: async () => ({ html: '<!doctype html><html><body><button>Visible only in browser</button></body></html>' }),
    deliver: async () => { throw new Error('Delivery is unavailable in the renderer-only capability fixture') }
  }
  const tool = new CanvasTool(scene, artifacts, async mutation => mutation.apply())
  const call = (name: string, args: unknown) => tool.execute(name, args, scope)
  const write = (operations: unknown[]) => call('canvas_edit', { revision: canvasRevision(scene), operations })
  const check = async (name: string, run: () => Promise<unknown>) => {
    try { checks.push({ name, passed: true, evidence: await run() }) }
    catch (error) { checks.push({ name, passed: false, error: String(error) }) }
  }
  const rejects = async (run: () => Promise<unknown>, pattern: RegExp) => {
    try { await run() } catch (error) { assert(pattern.test(String(error)), `Unexpected failure: ${error}`); return }
    throw new Error('Expected an explicit failure')
  }
  const select = async (ids: string[]) => {
    scene.select(ids)
    const deadline = performance.now() + 2000
    // Excalidraw commits selection in its render cycle, not updateScene itself.
    while (scene.selectedIds.length !== ids.length || ids.some(id => !scene.selectedIds.includes(id))) {
      assert(performance.now() < deadline, `Selection did not settle: expected ${JSON.stringify(ids)}, received ${JSON.stringify(scene.selectedIds)}`)
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    }
  }
  const pixels = async (result: ToolResult) => {
    const item = result.content.find(item => item.type === 'image')!
    const bitmap = await createImageBitmap(await (await fetch(`data:${item.mimeType};base64,${item.data}`)).blob())
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close()
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    let magenta = 0
    for (let i = 0; i < data.length; i += 4) if (data[i]! > 190 && data[i + 1]! < 80 && data[i + 2]! > 190) magenta++
    return { width: canvas.width, height: canvas.height, magenta, coverage: state(result) }
  }

  await check('exact text styles, geometry, axis-aligned paths and atomic rejection', async () => {
    await write([
      { type: 'create_text', text: '精确 typography', x: 10.125, y: 20.375, rotation: .123, props: { fontSize: 31.5, fontFamily: 2, opacity: 63, locked: true, strokeColor: '#123456' } },
      { type: 'create_element', elementType: 'line', x: 30, y: 100, props: { width: 200, height: 0, points: [[0, 0], [200, 0]] } },
      { type: 'create_element', elementType: 'arrow', x: 300, y: 100, props: { width: 0, height: 120, points: [[0, 0], [0, 120]] } },
      { type: 'create_element', elementType: 'rectangle', x: 400, y: 100, props: { width: 100, height: 100 } }
    ])
    const text = scene.elements.find(el => el.type === 'text')!, box = scene.elements.find(el => el.type === 'rectangle')!
    const record = state(await call('canvas_inspect', { ids: [text.id], detail: 'elements' }))
    const actual = record.elements[0]
    assert(record.elementCount === 4 && record.coverage.total === 1 && record.coverage.returned === 1 && record.coverage.nextOffset === null, 'Targeted status must retain canvas count and exact coverage')
    for (const [key, value] of Object.entries({ type: 'text', x: 10.125, y: 20.375, rotation: .123, fontSize: 31.5, fontFamily: 2, opacity: 63, locked: true, strokeColor: '#123456' })) assert(actual[key] === value, `${key}: ${actual[key]} !== ${value}`)
    assert(scene.elements.find(el => el.type === 'line')!.height === 0, 'Horizontal line must remain horizontal')
    assert(scene.elements.find(el => el.type === 'arrow')!.width === 0, 'Vertical arrow must remain vertical')
    const before = canvasRevision(scene)
    await rejects(() => write([{ type: 'move', elementId: text.id, x: 999, y: 999 }, { type: 'update_element', elementId: box.id, props: { height: 0 } }]), /zero dimension/)
    assert(before === canvasRevision(scene), 'A rejected batch must preserve the whole document')
    await rejects(() => call('canvas_inspect', { ids: ['missing'] }), /No canvas elements/)
    await rejects(() => call('canvas_inspect', { ids: [] }), /1 to 64/)
    return { text: actual, horizontalHeight: 0, verticalWidth: 0, atomic: true }
  })

  await check('131-element view includes the final sentinel despite submitted selection', async () => {
    scene.restore(blank)
    const operations = Array.from({ length: 131 }, (_, i) => ({ type: 'create_element', elementType: 'rectangle', x: (i % 12) * 80, y: Math.floor(i / 12) * 65, props: { width: 60, height: 45, roughness: 0, strokeColor: i === 130 ? '#ff00ff' : '#999999', backgroundColor: i === 130 ? '#ff00ff' : '#dddddd', fillStyle: 'solid' } }))
    await write(operations)
    await select([scene.elements[0]!.id])
    const submitted = captureSubmittedContext(scene)
    assert(submitted.selection.length === 1, 'Fixture must have a submitted selection')
    const captured = new CanvasTool(scene, artifacts, async mutation => mutation.apply(), submitted)
    const low = await pixels(await captured.execute('canvas_capture', { scope: 'canvas' }, scope))
    const high = await pixels(await captured.execute('canvas_capture', { scope: 'canvas', detail: 'high' }, scope))
    const selection = await pixels(await captured.execute('canvas_capture', { scope: 'selection' }, scope))
    assert(low.magenta > 300, 'Whole view omitted the final magenta sentinel')
    // Rendering and identity retention are separate limits. This view renders
    // every requested element and names as many as the page bound allows. The
    // identity cap is stated in the limitation, never reported as omission.
    assert(low.coverage.elementCount === 131, 'Coverage must render all 131 elements')
    assert(low.coverage.complete === false && low.coverage.limitation?.includes(`names only ${CANVAS_PAGE_MAX} identities`) === true, 'A truncated identity list must be reported, not hidden')
    assert(low.coverage.evidence.totalElementCount === 131 && low.coverage.evidence.coveredElementCount === CANVAS_PAGE_MAX && low.coverage.evidence.elementIds.length === CANVAS_PAGE_MAX, 'Evidence must separate rendered total from retained identities')
    assert(low.coverage.elementIds.length === CANVAS_PAGE_MAX, 'The reported identities must match the record')
    assert(high.coverage.evidence.totalElementCount === 131, 'Detail must not change what the view covers')
    assert(high.width >= low.width * 1.9, 'High detail must increase render scale')
    assert(selection.coverage.elementCount === 1 && selection.magenta === 0, 'Selection must stay local')
    await select([])
    await rejects(() => call('canvas_capture', { scope: 'selection' }), /selection is empty/)
    return { low, high, selection }
  })

  await check('HTML view shows a poster and is never reported as visually complete', async () => {
    await write([{ type: 'create_element', elementType: 'html', x: 1100, y: 0, props: { htmlPath: '/tmp/galta-capability-check/example.html', width: 300, height: 200 } }])
    const element = scene.elements.at(-1)!.id
    const coverage = state(await call('canvas_capture', { element }))
    assert(coverage.complete === false && coverage.htmlPosterIds[0] === element && !coverage.unrenderedElementIds.length && /poster/.test(coverage.limitation), 'HTML must show as a poster and never be reported as visually complete')
    return coverage
  })

  await check('current export verifies replacement while the submitted original and path remain intact', async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 100
    const context = canvas.getContext('2d')!
    context.fillStyle = '#ff0000'; context.fillRect(0, 0, 100, 100)
    const original = canvas.toDataURL(), [id] = placeImage(scene, await prepareImage(scene, { url: original }), { x: 1300, y: 400 })
    await select([id!])
    const submitted = captureSubmittedContext(scene)
    assert(submitted.images.length === 1, 'Image must be captured at submission')
    const captured = new CanvasTool(scene, artifacts, async mutation => mutation.apply(), submitted)
    context.fillStyle = '#00ff00'; context.fillRect(0, 0, 100, 100); replacement = canvas.toDataURL()
    await captured.execute('canvas_place', { revision: canvasRevision(scene), path: '/tmp/galta-capability-check/green.png', replace: id }, scope)
    writes.length = 0
    const frozen = state(await captured.execute('canvas_extract', { element: id }, scope))
    const current = state(await captured.execute('canvas_extract', { element: id, source: 'current' }, scope))
    assert(writes[0]!.dataBase64 === original.split(',')[1], 'Default export changed submitted bytes')
    assert(writes[1]!.dataBase64 === replacement.split(',')[1], 'Current export returned old bytes')
    assert(frozen.path !== current.path && !frozen.revision && current.revision === canvasRevision(scene), 'Source paths and revisions must distinguish frozen and live data')
    duringWrite = () => applyCreativeOperations(scene, [{ type: 'move', elementId: id!, x: 1301, y: 400 }])
    await rejects(() => captured.execute('canvas_extract', { element: id, source: 'current' }, scope), /changed while exporting/)
    duringWrite = () => {}
    applyCreativeOperations(scene, [{ type: 'delete', elementId: id! }])
    await rejects(() => captured.execute('canvas_extract', { element: id, source: 'current' }, scope), /no extractable source/)
    const removed = state(await captured.execute('canvas_extract', { element: id }, scope))
    assert(removed.source === 'submitted', 'Deleted submitted target must retain its original')
    await rejects(() => captured.execute('canvas_extract', { element: id }, { ...scope, signal: AbortSignal.abort(new Error('Stopped')) }), /Stopped/)
    return { frozen, current, retainedAfterDeletion: true, concurrentChangeRejected: true, stoppedRejected: true }
  })
  return { passed: checks.every(check => check.passed), checks, verifiedAt: new Date().toISOString() }
}
