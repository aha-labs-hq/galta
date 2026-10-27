import { useEffect, useState } from 'react'
import { sourceTab } from './sourceBrowser'

export type SourcePage = { tabId: number; title: string; url: string }

/** Observe tab identity only. Page contents are read by the agent when needed. */
export function useSourcePage() {
  const [page, setPage] = useState<SourcePage | null>(null)
  useEffect(() => {
    if (!globalThis.chrome?.runtime?.id || !chrome.tabs?.get) return
    let active = true, sequence = 0, observedTab: number | null = null
    const refresh = () => {
      const request = ++sequence
      void sourceTab().then(async id => id === null ? null : chrome.tabs.get(id)).then(tab => {
        if (!active || sequence !== request) return
        observedTab = tab?.id ?? null
        setPage(tab?.id && /^https?:\/\//i.test(tab.url ?? '') ? { tabId: tab.id, title: tab.title ?? new URL(tab.url!).hostname, url: tab.url! } : null)
      }).catch(() => { if (active && sequence === request) setPage(null) })
    }
    const updated = (id: number, change: chrome.tabs.TabChangeInfo) => {
      if (id === observedTab && (change.url !== undefined || change.title !== undefined || change.status !== undefined)) refresh()
    }
    refresh()
    chrome.tabs.onActivated?.addListener(refresh)
    chrome.tabs.onUpdated?.addListener(updated)
    chrome.tabs.onRemoved?.addListener(refresh)
    return () => {
      active = false
      chrome.tabs.onActivated?.removeListener(refresh)
      chrome.tabs.onUpdated?.removeListener(updated)
      chrome.tabs.onRemoved?.removeListener(refresh)
    }
  }, [])
  return { page }
}
