import { validateBrowserInput } from '@galta/canvas'
import { messagePage, PageUnreachable } from '../shared/pageScript'

type BoundPage = { tabId: number; windowId: number; documentId: string }

async function sendToPage(tabId: number, tool: string, args: Record<string, unknown>) {
  try { return await messagePage(tabId, { type: 'galta-page', tool, args }) }
  catch (error) {
    if (error instanceof PageUnreachable) throw new Error(`Galta cannot run on this webpage: ${error.message} Canvas tools remain available.`)
    throw error
  }
}

/** One port owns one source tab for one execution. Focus changes never retarget it. */
export function attachBrowser(port: chrome.runtime.Port) {
  if (port.sender?.id !== chrome.runtime.id || !port.sender.url?.startsWith(chrome.runtime.getURL(''))) { port.disconnect(); return }
  let bound: BoundPage | undefined, alive = true, busy = false
  port.onDisconnect.addListener(() => { alive = false })
  const active = () => { if (!alive) throw new Error('Webpage execution ended') }
  const source = async () => {
    active()
    if (!bound) throw new Error('No source webpage is bound')
    const tab = await chrome.tabs.get(bound.tabId)
    active()
    if (tab.windowId !== bound.windowId || !/^https?:\/\//i.test(tab.url ?? '')) throw new Error('The source tab moved or is no longer an HTTP(S) webpage')
    return tab
  }
  const page = async (tool: string, args: Record<string, unknown>) => {
    await source()
    const result = await sendToPage(bound!.tabId, tool, args)
    active()
    if (!result?.ok) throw new Error(result?.error ?? 'The webpage is unavailable. Reload the source page to connect Galta.')
    if (result.result.documentId !== bound!.documentId) throw new Error('The source document changed. Read the page again.')
    return result.result
  }
  port.onMessage.addListener(message => {
    void (async () => {
      let ownsCall = false
      try {
        active()
        if (busy) throw new Error('A webpage operation is already running')
        busy = true; ownsCall = true
        let result: unknown
        const { args = {} } = message
        if (message.tool !== 'open') validateBrowserInput(message.tool, args)
        if (message.tool === 'open') {
          if (bound) throw new Error('The source webpage is already bound')
          const tab = await chrome.tabs.get(args.tabId)
          active()
          if (!tab.id || !/^https?:\/\//i.test(tab.url ?? '')) throw new Error('Open an HTTP(S) webpage beside Galta first')
          if (args.expectedUrl && tab.url !== args.expectedUrl) throw new Error('The source page changed before submission. Send again from the intended page.')
          const response = await sendToPage(tab.id, 'browser_check', {})
          active()
          if (!response?.ok) throw new Error(response?.error ?? 'Reload the source webpage to connect Galta')
          if (args.expectedUrl && response.result.url !== args.expectedUrl) throw new Error('The source page changed while binding this task.')
          bound = { tabId: tab.id, windowId: tab.windowId, documentId: response.result.documentId }
          result = { ...response.result, tabId: tab.id }
        } else if (message.tool === 'browser_inspect') {
          if (!bound) throw new Error('No source webpage is bound')
          await source()
          // A fresh read may explicitly observe navigation within the same tab.
          const response = await sendToPage(bound.tabId, 'browser_inspect', {})
          active()
          if (!response?.ok) throw new Error(response?.error ?? 'The webpage cannot be read')
          bound.documentId = response.result.documentId
          result = { ...response.result, tabId: bound.tabId }
        } else if (message.tool === 'browser_capture') {
          const before = await page('browser_check', args)
          const [tab] = await chrome.tabs.query({ active: true, windowId: bound!.windowId })
          active()
          if (tab?.id !== bound!.tabId) throw new Error('The source tab is not active. Return to it before viewing its pixels.')
          const dataUrl = await chrome.tabs.captureVisibleTab(bound!.windowId, { format: 'jpeg', quality: 90 })
          const [afterTab] = await chrome.tabs.query({ active: true, windowId: bound!.windowId })
          const after = await page('browser_check', args)
          if (afterTab?.id !== bound!.tabId || JSON.stringify(before) !== JSON.stringify(after)) throw new Error('The source page changed during capture. Read it again.')
          result = { ...before, tabId: bound!.tabId, dataUrl }
        } else if (message.tool === 'browser_act') {
          const checked = await page('browser_check', args)
          const tab = await chrome.tabs.get(bound!.tabId)
          active()
          if (!tab.active || tab.windowId !== bound!.windowId) throw new Error('The source tab is not active. Return to it before acting.')
          if (args.action === 'navigate') {
            const url = new URL(args.url)
            await page('browser_act', args)
            active()
            await chrome.tabs.update(bound!.tabId, { url: url.href })
            result = { ...checked, dispatched: 'navigate', verification: 'Read the page after navigation completes.' }
          } else result = await page('browser_act', args)
        } else throw new Error('Unknown browser tool')
        active(); port.postMessage({ id: message.id, result })
      } catch (error) {
        if (alive) port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) })
      } finally { if (ownsCall) busy = false }
    })()
  })
}
