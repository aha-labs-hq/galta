/** Galta's page script is declared for every page, but a browser runs declared
 * scripts only in pages that load after the extension does. A tab already open
 * when Galta installs, updates or reloads has no script until the page itself
 * reloads, and a message to it finds no receiver. A message to a page therefore
 * brings the script first when it is missing: once per tab, logged, and only to
 * the top frame the message is for. Pages Galta may not script, such as the
 * browser's own, stay unreachable and say why. */
const adding = new Map<number, Promise<void>>()

function missingPageScript(error: unknown) {
  return /Receiving end does not exist|Could not establish connection/i.test(String(error))
}

/** Galta cannot run on this page; the reason is the browser's. */
export class PageUnreachable extends Error {}

export async function messagePage<T = any>(tabId: number, message: unknown): Promise<T> {
  try { return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 }) }
  catch (error) { if (!missingPageScript(error)) throw error }
  let pending = adding.get(tabId)
  if (!pending) {
    pending = chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] })
      .then(() => { console.info('[Galta] Page script added to an open tab', { tabId }) })
      .finally(() => adding.delete(tabId))
    adding.set(tabId, pending)
  }
  try { await pending }
  catch (error) { throw new PageUnreachable(error instanceof Error ? error.message : String(error)) }
  return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 })
}
