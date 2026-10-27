/** The files Galta's native host keeps for a deleted canvas (its agent
 * working directory and delivered artifacts). Without the extension runtime
 * or an installed host there are none to remove; any other failure is
 * reported to the caller with its reason. */
export async function removeCanvasFiles(projectId: string, timeout = 60_000): Promise<'removed' | 'kept' | 'none'> {
  if (!globalThis.chrome?.runtime?.id) return 'none'
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: `galta-canvas:files-${crypto.randomUUID()}` })
    const id = crypto.randomUUID()
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      try { port.disconnect() } catch { /* already closed */ }
      action()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('Removing them did not finish in time; some may remain.'))), timeout)
    port.onMessage.addListener(message => {
      if (message?.method === 'canvas/disconnected') {
        const reason = String(message.params?.message ?? '')
        finish(() => /native messaging host not found/i.test(reason) ? resolve('none') : reject(new Error(`The app could not be reached: ${reason}`)))
      } else if (message?.id === id) {
        // A host older than this request answers with its lease error.
        const outdated = /Canvas execution is not active|Unknown canvas bridge request/.test(String(message.error?.message))
        finish(() => message.error ? reject(new Error(outdated ? 'The app is older than this browser extension; update it, then remove the files from Galta\'s data folder.' : String(message.error.message))) : resolve(message.result?.removed === false ? 'kept' : 'removed'))
      }
    })
    port.onDisconnect.addListener(() => finish(() => reject(new Error(chrome.runtime.lastError?.message ?? 'The app closed the connection.'))))
    port.postMessage({ id, method: 'workspace/remove', params: { projectId } })
  })
}
