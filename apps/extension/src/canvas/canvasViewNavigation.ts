import { rememberPanelCanvas } from './panelCanvas'
import { captureSourceView, returnSourceView } from './sourceView'
import type { SourceView } from '../shared/sourceView'
import { hasExtensionSidePanels } from '../shared/sidePanel'

export type FocusViewport = { center: { x: number; y: number }; span: number }
export type CanvasView = { selection: string[]; viewport: FocusViewport }
type Receipt = { token: string; error?: string }
type Presentation = { type: 'present'; target?: string; projectId?: string; token: string; sourceTab: number; view: CanvasView; expiresAt?: number }
type PendingPresentation = Omit<Presentation, 'type'> & { type?: 'present' }
type Address = { tabId: number; viewId: string; sourceView?: SourceView }
type PresentationCapabilities = {
  windows?: { getCurrent(): Promise<{ id?: number }> }
  tabs?: { getCurrent(): Promise<{ id?: number; windowId: number }> }
  storage?: {
    session?: { get(key: string): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void>; remove(key: string): Promise<void> }
    onChanged?: chrome.events.Event<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void>
  }
}
const channelName = 'galta-canvas-presentation'
const timeout = 12_000
const params = () => new URLSearchParams(location.hash.slice(1))
const addressKey = (projectId: string, windowId: number) => `galta-canvas-view:${windowId}:${projectId}`
const panelPresentationKey = (windowId: number) => `galta-panel-presentation:${windowId}`
const presentationKey = (projectId: string, viewId: string) => `galta-canvas-presentation:${projectId}:${viewId}`
const receiptKey = (token: string) => `galta-presentation-receipt:${token}`

async function removePending(key: string, token: string) {
  const session = (globalThis.chrome as unknown as PresentationCapabilities).storage?.session
  if (!session?.get || !session.remove) return
  const stored = await session.get(key)
  if ((stored[key] as PendingPresentation | undefined)?.token === token) await session.remove(key)
}

/** A view handoff can fail without invalidating the canvas that is already
 * usable. Callers should present this as a calm status update, not as a
 * destructive canvas error. */
export class CanvasViewHandoffTimeout extends Error {
  constructor() {
    super('The other view did not finish opening.')
    this.name = 'CanvasViewHandoffTimeout'
  }
}

/** Browser handoff is optional in preview pages and reduced test hosts. Keep
 * the conversation surface usable when those hosts expose runtime messaging
 * without the window/session APIs used for cross-view delivery. */
async function currentWindowId() {
  const browser = globalThis.chrome as unknown as PresentationCapabilities
  if (!browser.windows?.getCurrent) return undefined
  return (await browser.windows.getCurrent()).id
}

export function focusSelection(): string[] {
  const value = params().get('selection')
  if (!value) return []
  const ids: unknown = JSON.parse(value)
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Invalid canvas selection.')
  return ids
}

export function focusViewport(): FocusViewport | undefined {
  const value = params().get('viewport')
  if (!value) return
  const viewport = JSON.parse(value) as FocusViewport
  if (!viewport?.center || ![viewport.center.x, viewport.center.y, viewport.span].every(Number.isFinite) || viewport.span <= 0) throw new Error('Invalid canvas viewport.')
  return viewport
}

export function returnTabId(): number | null {
  const value = params().get('returnTab')
  return value && /^\d+$/.test(value) ? Number(value) : null
}

export type ReturnSource = { id: number; title?: string | undefined; inferred: boolean }

/** The page a full canvas returns beside: the one it was expanded from, else
 * the page last used in its window, such as when Galta for Mac opened the
 * canvas. Another Galta page is never a source. */
export async function returnSource(): Promise<ReturnSource | null> {
  const expanded = returnTabId()
  if (expanded !== null) return { id: expanded, inferred: false }
  // Reduced hosts expose runtime messaging without tabs, and Chromium hosts
  // without extension side panels have no beside to return to.
  if (!globalThis.chrome?.tabs?.getCurrent || !chrome.tabs.query || !hasExtensionSidePanels()) return null
  const current = await chrome.tabs.getCurrent()
  if (!current) return null
  const own = chrome.runtime.getURL('')
  const previous = (await chrome.tabs.query({ windowId: current.windowId }))
    .filter(tab => tab.id !== undefined && tab.id !== current.id && !tab.url?.startsWith(own))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]
  return previous?.id === undefined ? null : { id: previous.id, title: previous.title, inferred: true }
}

// One receiving endpoint per mounted canvas. A view is ready only after its
// scene and draft are hydrated, rather than after Chrome creates a tab.
export function receivePresentation(projectId: string, receive: (view: CanvasView) => Promise<void>, onError: (error: string) => void) {
  if (!globalThis.chrome?.runtime?.id) return () => {}
  const channel = new BroadcastChannel(channelName)
  const browser = globalThis.chrome as unknown as PresentationCapabilities
  const session = browser.storage?.session
  const initial = params(), viewId = initial.get('view'), sidebar = location.pathname === '/sidepanel/index.html'
  let active = true
  const completed = new Set<string>(), inFlight = new Map<string, Promise<void>>()
  let pendingKey: string | undefined = !sidebar && viewId ? presentationKey(projectId, viewId) : undefined
  const readPending = async (key: string) => {
    if (!session?.get) return undefined
    const stored = await session.get(key)
    return stored[key] as PendingPresentation | undefined
  }
  const acknowledge = async (receipt: Receipt) => {
    if (!active) return
    // The receipt survives a lost channel message just like the request. The
    // sender owns cleanup after observing it (or its bounded deadline).
    if (pendingKey && session?.set) await session.set({ [receiptKey(receipt.token)]: receipt })
    if (active) channel.postMessage(receipt)
  }
  const consume = async (data: Presentation | PendingPresentation) => {
    if (sidebar ? data.projectId !== projectId : !viewId || data.target !== viewId) return
    if (!active || data.expiresAt !== undefined && data.expiresAt <= Date.now()) return
    if (completed.has(data.token)) { channel.postMessage({ token: data.token } satisfies Receipt); return }
    const existing = inFlight.get(data.token)
    if (existing) { await existing.catch(() => undefined); return }
    if (inFlight.size) { await acknowledge({ token: data.token, error: 'The canvas is receiving another view.' }); return }
    const task = (async () => {
      await receive(data.view)
      if (!active) return
      if (!sidebar) {
        const url = new URL(location.href), state = params()
        state.set('returnTab', String(data.sourceTab))
        state.delete('handoff'); state.delete('selection')
        url.hash = state.toString(); history.replaceState(null, '', url)
        window.dispatchEvent(new Event('galta-presentation-change'))
      }
      completed.add(data.token)
      if (completed.size > 32) completed.delete(completed.values().next().value!)
    })()
    inFlight.set(data.token, task)
    try { await task; await acknowledge({ token: data.token }) }
    catch (error) { await acknowledge({ token: data.token, error: error instanceof Error ? error.message : String(error) }) }
    finally { inFlight.delete(data.token) }
  }
  channel.onmessage = async ({ data }: MessageEvent<Presentation>) => {
    if (data.type === 'present') await consume(data).catch(error => { if (active) onError(String(error)) })
  }
  const changed = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (areaName !== 'session' || !pendingKey) return
    const pending = changes[pendingKey]?.newValue as PendingPresentation | undefined
    if (pending) void consume(pending).catch(error => { if (active) onError(String(error)) })
  }
  browser.storage?.onChanged?.addListener(changed)
  void (async () => {
    if (viewId && location.pathname === '/canvas/index.html' && browser.tabs?.getCurrent && session?.set) {
      const tab = await browser.tabs.getCurrent()
      if (!active || !tab?.id) return
      const key = addressKey(projectId, tab.windowId)
      const saved = session.get ? (await session.get(key))[key] as Address | undefined : undefined
      // Remounting or reloading the same endpoint must retain the source view
      // saved by Expand. Register only a genuinely new endpoint.
      if (saved?.tabId !== tab.id || saved.viewId !== viewId) await session.set({ [key]: { tabId: tab.id, viewId } satisfies Address })
    }
    if (!active) return
    if (sidebar) {
      const windowId = await currentWindowId()
      if (windowId !== undefined) pendingKey = panelPresentationKey(windowId)
    }
    if (active && pendingKey) {
      const pending = await readPending(pendingKey)
      if (pending) await consume(pending)
    }
  })().catch(error => { if (active) onError(String(error)) })
  return () => { active = false; browser.storage?.onChanged?.removeListener(changed); channel.close() }
}

async function withReceipt(pendingKey: string, open: (token: string, channel: BroadcastChannel) => Promise<void>) {
  const channel = new BroadcastChannel(channelName), token = crypto.randomUUID()
  let timer: ReturnType<typeof setTimeout> | undefined
  let changed: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void
  const ready = new Promise<void>((resolve, reject) => {
    const receive = (data: Receipt) => {
      if (data.token !== token) return
      data.error ? reject(new Error(data.error)) : resolve()
    }
    timer = setTimeout(() => reject(new CanvasViewHandoffTimeout()), timeout)
    channel.onmessage = ({ data }: MessageEvent<Receipt>) => receive(data)
    changed = (changes, areaName) => {
      const receipt = changes[receiptKey(token)]?.newValue as Receipt | undefined
      if (areaName === 'session' && receipt) receive(receipt)
    }
    chrome.storage.onChanged?.addListener(changed)
  })
  // An opening error can precede the receipt. Always observe both promises.
  try { await Promise.all([open(token, channel), ready]) }
  finally {
    clearTimeout(timer); chrome.storage.onChanged?.removeListener(changed!); channel.close()
    try {
      await removePending(pendingKey, token)
      await chrome.storage.session.remove(receiptKey(token))
    } catch (error) { console.warn('Galta view handoff cleanup failed', { token, pendingKey, error: String(error) }) }
  }
}

/** Display navigation never stops a task; Return closes only its temporary
 * full-canvas tab, and only after the source has acknowledged hydration. */
export async function expandCanvas(projectId: string, view: CanvasView) {
  const [source] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!source?.id) throw new Error('The source page is no longer available. Your canvas is still here.')
  const key = addressKey(projectId, source.windowId)
  const saved = (await chrome.storage.session.get(key))[key] as Address | undefined
  let target: chrome.tabs.Tab | undefined
  if (saved) {
    try {
      const candidate = await chrome.tabs.get(saved.tabId)
      // Tab URLs are withheld without the broad tabs permission. The extension
      // context registry exposes only our own documents and survives worker sleep.
      const [context] = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB], tabIds: [candidate.id!] })
      const url = context?.documentUrl ? new URL(context.documentUrl) : undefined
      if (url?.protocol === 'chrome-extension:' && url.host === chrome.runtime.id && url.pathname === '/canvas/index.html' && url.searchParams.get('project') === projectId && new URLSearchParams(url.hash.slice(1)).get('view') === saved.viewId) target = candidate
    } catch (error) { if (!/No tab with id/i.test(String(error))) throw error }
  }
  const viewId = target && saved ? saved.viewId : crypto.randomUUID()
  const sourceView = await captureSourceView(source.id)
  await withReceipt(presentationKey(projectId, viewId), async (token, channel) => {
    const pending: Presentation = { type: 'present', target: viewId, projectId, token, sourceTab: source.id!, view, expiresAt: Date.now() + timeout }
    await chrome.storage.session.set({ [presentationKey(projectId, viewId)]: pending })
    if (target && saved) {
      channel.postMessage(pending)
      return
    }
    const state = new URLSearchParams({ selection: JSON.stringify(view.selection), viewport: JSON.stringify(view.viewport), returnTab: String(source.id), view: viewId, handoff: token })
    target = await chrome.tabs.create({ windowId: source.windowId, active: false, url: chrome.runtime.getURL(`canvas/index.html?project=${encodeURIComponent(projectId)}#${state}`) })
    if (!target?.id) throw new Error('Chrome could not open the canvas. Your work is still here.')
    await chrome.storage.session.set({ [key]: { tabId: target.id, viewId } satisfies Address })
    // Storage is the durable handoff; the channel is only a prompt for an
    // already-mounted receiver and may legitimately arrive before it exists.
    channel.postMessage(pending)
  })
  if (!target?.id) throw new Error('The canvas tab is no longer available.')
  const destination = target
  await chrome.storage.session.set({ [key]: { tabId: destination.id!, viewId, ...(sourceView ? { sourceView } : {}) } satisfies Address })
  await chrome.sidePanel.setOptions({ tabId: destination.id!, enabled: false })
  await chrome.tabs.update(destination.id!, { active: true })
  await chrome.windows.update(destination.windowId, { focused: true })
  await chrome.sidePanel.close({ windowId: source.windowId })
}

export async function returnToPage(projectId: string, view: CanvasView, id: number) {
  let source: chrome.tabs.Tab
  try { source = await chrome.tabs.get(id) }
  catch (error) {
    if (/No tab with id/i.test(String(error))) throw new Error('The original page was closed. Your canvas is still open.')
    throw error
  }
  const current = await chrome.tabs.getCurrent()
  const key = addressKey(projectId, source.windowId)
  const address = (await chrome.storage.session.get(key))[key] as Address | undefined
  let activated = false
  await rememberPanelCanvas(projectId, source.windowId)
  const pendingKey = panelPresentationKey(source.windowId)
  try {
    await withReceipt(pendingKey, async (token, channel) => {
      const pending: PendingPresentation = { token, projectId, sourceTab: id, view, expiresAt: Date.now() + timeout }
      await chrome.storage.session.set({ [pendingKey]: pending })
      // The workbench is window-scoped. The manifest owns its stable entry
      // point; session storage and the channel carry the handoff payload.
      await chrome.sidePanel.open({ windowId: source.windowId })
      // The full canvas disables the panel; activate the source before delivery.
      await chrome.tabs.update(id, { active: true }); activated = true
      await chrome.windows.update(source.windowId, { focused: true })
      channel.postMessage({ type: 'present', ...pending } satisfies Presentation)
    })
    // The return receipt means the source page has hydrated the scene, draft,
    // selection and viewport. Only then is it safe to dispose of the full
    // canvas tab that owns this document. Before the receipt, closing it would
    // turn a slow panel wake-up into a data-loss path.
    if (address && address.tabId === current?.id && address.sourceView) await returnSourceView(id, address.sourceView)
    if (current?.id !== undefined && current.id !== id) {
      try { await chrome.tabs.remove(current.id) }
      catch (error) {
        // A concurrent close is already the desired end state. Other browser
        // errors leave the source usable but keep the workbench available for
        // an explicit retry, so surface the failure at the owning boundary.
        if (!/No tab with id/i.test(String(error))) throw error
      }
      if (address?.tabId === current.id) await chrome.storage.session.remove(key)
    }
  } catch (error) {
    // Failed hydration must leave the error beside the still-usable artwork.
    if (activated && current?.id) {
      await chrome.tabs.update(current.id, { active: true }).catch(() => undefined)
      await chrome.windows.update(current.windowId, { focused: true }).catch(() => undefined)
    }
    throw error
  }
}
