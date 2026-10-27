/** A browsing window keeps one canvas while the user visits different source
 * tabs. Full canvas tabs carry their own explicit project in the URL. */
async function panelWindow(): Promise<number | undefined> {
  if (!globalThis.chrome?.runtime?.id || !chrome.storage?.session || !chrome.tabs?.query) return
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.windowId
}

export async function rememberPanelCanvas(projectId: string | null, windowId?: number) {
  if (!globalThis.chrome?.runtime?.id || !chrome.storage?.session) return
  const id = windowId ?? await panelWindow()
  if (id === undefined) return
  await chrome.storage.session.set({ [`galta-panel-canvas:${id}`]: projectId })
}

/** A deleted canvas leaves no browsing window pointing at it. */
export async function forgetPanelCanvas(projectId: string) {
  if (!globalThis.chrome?.runtime?.id || !chrome.storage?.session) return
  const stored = await chrome.storage.session.get(null)
  const keys = Object.keys(stored).filter(key => key.startsWith('galta-panel-canvas:') && stored[key] === projectId)
  if (keys.length) await chrome.storage.session.remove(keys)
}

export async function initialCanvasId(explicit: string | null): Promise<string | null> {
  if (location.pathname !== '/sidepanel/index.html') return explicit
  const windowId = await panelWindow()
  if (windowId === undefined) return explicit
  const key = `galta-panel-canvas:${windowId}`
  const stored = await chrome.storage.session.get(key)
  return key in stored ? typeof stored[key] === 'string' ? stored[key] : null : explicit
}
