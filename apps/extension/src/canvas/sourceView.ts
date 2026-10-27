import { validateSourceView, type SourceView } from '../shared/sourceView'
import { messagePage, PageUnreachable } from '../shared/pageScript'

async function send(tabId: number, request: object) {
  // Reduced hosts have no page integration, and internal browser pages cannot
  // carry it; their view is simply not kept.
  if (!chrome.tabs.sendMessage) return undefined
  try { return await messagePage(tabId, { type: 'galta-source-view', ...request }) }
  catch (error) {
    if (!(error instanceof PageUnreachable)) throw error
    console.info('[Galta] Source page view unavailable', { tabId, reason: error.message })
    return undefined
  }
}

export async function captureSourceView(tabId: number): Promise<SourceView | undefined> {
  const response = await send(tabId, { action: 'capture' })
  if (!response) return undefined
  if (!response.ok) throw new Error(response.error)
  validateSourceView(response.result)
  return response.result
}

export async function returnSourceView(tabId: number, view: SourceView) {
  const response = await send(tabId, { action: 'restore', view })
  if (!response) return
  if (!response.ok) throw new Error(response.error)
  if (!['changed', 'restored'].includes(response.result?.status)) throw new Error('Invalid source page restoration receipt.')
}
