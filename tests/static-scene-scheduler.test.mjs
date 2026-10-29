import { test, expect } from 'bun:test'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../apps/extension/package.json', import.meta.url))
const { staticSceneScheduler } = await import(require.resolve('@excalidraw/excalidraw/staticTiles'))

function frames(run) {
  const request = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame
  const queued = new Map(); let id = 0
  globalThis.requestAnimationFrame = callback => { queued.set(++id, callback); return id }
  globalThis.cancelAnimationFrame = id => { queued.delete(id) }
  const step = () => { const next = [...queued.values()]; queued.clear(); for (const callback of next) callback(0) }
  try { run(step) } finally { globalThis.requestAnimationFrame = request; globalThis.cancelAnimationFrame = cancel }
}

test('exports draw synchronously when the throttle argument is omitted', () => frames(step => {
  const drawn = [], canvas = { isConnected: false }
  const render = staticSceneScheduler(config => drawn.push(config.value))
  render({ canvas, value: 'export' })
  expect(drawn).toEqual(['export'])
  step(); expect(drawn).toEqual(['export'])
}))

test('presentation redraws always use the latest native scene', () => frames(step => {
  const drawn = [], canvas = { isConnected: true }
  const render = staticSceneScheduler(config => { drawn.push(config.value); render.redraw(canvas) })
  render({ canvas, value: 'old' }, true)
  render({ canvas, value: 'new' }, true)
  step(); expect(drawn).toEqual(['new'])
  render({ canvas, value: 'undo' }, true)
  step(); expect(drawn).toEqual(['new', 'undo'])
}))

test('destroying a history renderer does not cancel a live canvas drawing', () => frames(step => {
  const drawn = [], live = { isConnected: true }, history = { isConnected: true }
  const render = staticSceneScheduler(config => drawn.push(config.value))
  render({ canvas: live, value: 'live' }, true)
  render({ canvas: history, value: 'history' }, true)
  // React calls Renderer.destroy before removing its DOM. The native destroy
  // calls this shared scheduler's cancel with no canvas argument.
  render.cancel(); history.isConnected = false
  step(); expect(drawn).toEqual(['live'])
}))
