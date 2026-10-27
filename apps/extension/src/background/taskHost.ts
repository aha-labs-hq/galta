let creating: Promise<void> | undefined
let host: chrome.runtime.Port | undefined
const listeners = new Set<() => void>()

export function attachTaskHost(port: chrome.runtime.Port) {
  host = port
  port.onDisconnect.addListener(() => {
    if (host !== port) return
    host = undefined
    // Only the lifetime owner reports a confirmed loss. An empty task snapshot
    // or a focus event cannot establish that a task failed.
    void chrome.runtime.sendMessage({ type: 'task-host-closed' }).catch(() => { /* No open observers; the next one performs durable recovery. */ })
  })
  for (const ready of listeners) ready()
}

export async function ensureTaskHost() {
  if (host) return
  if (creating) return creating
  creating = (async () => {
    const url = chrome.runtime.getURL('tasks/index.html')
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] })
    if (contexts.length) {
      // A restarted worker may have lost its in-memory port while the document
      // survived. The handshake attaches it without restarting any task.
      const result = await chrome.runtime.sendMessage({ type: 'task-host-ping' }).catch(() => null)
      if (result?.ok) return
    }
    const ready = new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timeout); listeners.delete(done); resolve() }
      const timeout = setTimeout(() => { listeners.delete(done); reject(new Error('The background task document did not start.')) }, 15_000)
      listeners.add(done)
      if (host) done()
    })
    // BLOBS covers canvas export/media processing. No visible editor, animation
    // frame loop, audio keepalive, or browser tab is needed by this document.
    if (!contexts.length) await chrome.offscreen.createDocument({ url, reasons: [chrome.offscreen.Reason.BLOBS], justification: 'Process canvas and media Blobs for ongoing agent tasks independently of side panel pages.' }).catch(error => { for (const done of listeners) done(); throw error })
    await ready
  })().finally(() => { creating = undefined })
  return creating
}
