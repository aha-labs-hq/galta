import { sourcePage } from './page'
import { isHttpImage, startCollector } from './collector'
import type { GaltaMessage } from '../shared/messages'
import { restoreSourceView, type SourceView } from '../shared/sourceView'

/* A tab open before Galta loaded receives this script on demand, and two
   demands can race; one live instance per page serves them all. An instance
   left by a reloaded extension is no longer live, so a new one starts. */
const host = globalThis as typeof globalThis & { __galtaPageLive?: () => boolean }
if (!host.__galtaPageLive?.()) start()

function start() {
  /* Reloading/disabling the extension leaves the old document's DOM listeners
     alive. Their runtime binding is terminal; a fresh script owns recovery. */
  const lifetime = new AbortController()
  const invalidated = (error: unknown) => error instanceof Error && error.message === 'Extension context invalidated.'
  const cancelledCollection = () => new DOMException('Refresh this page to resume Galta collection.', 'AbortError')

  function stopPage() {
    if (lifetime.signal.aborted) return
    lifetime.abort()
    collector.stop()
    console.info('[Galta] Page integration stopped: extension context invalidated. Refresh this page to resume.')
  }

  function contextActive() {
    if (lifetime.signal.aborted) return false
    try { if (globalThis.chrome?.runtime?.id) return true }
    catch (error) { if (!invalidated(error)) throw error }
    stopPage()
    return false
  }

  host.__galtaPageLive = contextActive

  const page = sourcePage()
  globalThis.chrome?.runtime?.onMessage?.addListener((message, sender, respond) => {
    if (!contextActive() || sender.id !== chrome.runtime.id) return false
    if (message?.type === 'galta-source-view') {
      const current = (): SourceView => {
        const { documentId, url, viewport } = page('browser_check', {})
        return { documentId, url, viewport, windowWidth: outerWidth }
      }
      if (message.action === 'capture') { respond({ ok: true, result: current() }); return false }
      if (message.action !== 'restore') { respond({ ok: false, error: 'Unknown source view action.' }); return false }
      void restoreSourceView(message.view, current).then(result => respond({ ok: true, result }), error => respond({ ok: false, error: String(error) }))
      return true
    }
    if (message?.type !== 'galta-page') return false
    try { respond({ ok: true, result: page(message.tool, message.args ?? {}) }) }
    catch (error) { respond({ ok: false, error: error instanceof Error ? error.message : String(error) }) }
    return false
  })

  // Preserve native drag behavior. Add only our image/provenance MIME payload.
  // Do not mutate every link/image or infer drags from ordinary pointer clicks.
  document.addEventListener('dragstart', (event) => {
    if (!contextActive()) return
    const target = event.target instanceof Element ? event.target : null
    if (!target || !event.dataTransfer) return
    const link = target.closest('a')
    const image = target instanceof HTMLImageElement ? target : target.querySelector('img') ?? link?.querySelector('img')
    const url = image?.currentSrc || image?.src
    if (!url || !isHttpImage(url)) return
    event.dataTransfer.setData('application/x-galta-reference', JSON.stringify({ url, sourceUrl: link?.href ?? location.href }))
  }, { capture: true, signal: lifetime.signal })

  // Check before a stale mark can consume a click or schedule another hover.
  // No polling, persistent port, or automatic page/extension reload is needed.
  for (const type of ['pointerover', 'pointermove', 'click']) {
    document.addEventListener(type, contextActive, { capture: true, passive: true, signal: lifetime.signal })
  }

  /* The collect affordance. It is mounted from the same document-level pass as the
     drag listener above, for the same reason: one delegated listener set serves
     the whole page, and nothing per image is ever created. */
  const collector = startCollector(document, {
    onCollected: async item => {
      if (!contextActive()) throw cancelledCollection()
      try {
        if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('The Galta collection background is unavailable.')
        const response = await chrome.runtime.sendMessage({ type: 'collection-add', item } satisfies GaltaMessage)
        if (response?.ok !== true) throw new Error(typeof response?.error === 'string' ? response.error : 'The collection was not saved.')
        contextActive()
      } catch (error) {
        // A reload can race the preflight or invalidate an already submitted save.
        if (invalidated(error)) stopPage()
        else contextActive()
        if (lifetime.signal.aborted) throw cancelledCollection()
        throw error
      }
    },
  })

  /* Development only. The surface is a closed shadow root — correctly, since a
     host page must not script it — so nothing outside the module can observe the
     affordance, and an interaction that cannot be observed cannot be verified.
     This attaches the read-only state view to the page in a development build and
     is compiled out of a release build entirely. */
  if (__GALTA_BUILD__.mode === 'development') {
    Object.assign(globalThis, { __galtaCollector: collector })
  }
}
