import { test, expect } from 'bun:test'
import { initialCanvasId, rememberPanelCanvas } from '../apps/extension/src/canvas/panelCanvas.ts'

test('a browsing window retains its canvas across source tabs while full tabs keep explicit identities', async () => {
  const previousChrome = globalThis.chrome, previousLocation = globalThis.location
  const stored = {}; let windowId = 7
  globalThis.chrome = { runtime: { id: 'fixture' }, tabs: { query: async () => [{ windowId }] },
    storage: { session: { get: async key => key in stored ? { [key]: stored[key] } : {}, set: async value => Object.assign(stored, value) } } }
  globalThis.location = { pathname: '/sidepanel/index.html' }
  try {
    expect(await initialCanvasId('first')).toBe('first')
    await rememberPanelCanvas('second')
    expect(await initialCanvasId('stale-source-tab')).toBe('second')
    windowId = 8
    expect(await initialCanvasId('another-window')).toBe('another-window')
    await rememberPanelCanvas('third', 8)
    expect(await initialCanvasId(null)).toBe('third')
    globalThis.location.pathname = '/canvas/index.html'
    expect(await initialCanvasId('first')).toBe('first')
    globalThis.location.pathname = '/sidepanel/index.html'
    await rememberPanelCanvas(null)
    expect(await initialCanvasId('archived-source-tab')).toBeNull()
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome; else globalThis.chrome = previousChrome
    if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation
  }
})
