import { useEffect, useState } from 'react'
import { Maximize2, PanelLeftClose, LoaderCircle } from 'lucide-react'
import { CanvasViewHandoffTimeout, expandCanvas, returnSource, returnToPage, returnTabId, type CanvasView, type ReturnSource } from './canvasViewNavigation'
import { CanvasChromeButton, CanvasChromeSurface } from './CanvasChrome'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function CanvasFocus({ projectId, onError, onNotice, prepare, resume, capture, disabled, unavailable, onPending }: {
  projectId: string
  onError: (message: string) => void
  onNotice?: (message: string) => void
  prepare: () => Promise<unknown>
  resume: () => void
  capture: () => CanvasView
  disabled?: boolean
  unavailable?: string | undefined
  onPending: (pending: boolean) => void
}) {
  const [pending, setPending] = useState(false)
  const [source, setSource] = useState<ReturnSource | null>(() => { const id = returnTabId(); return id === null ? null : { id, inferred: false } })
  const [sourceClosed, setSourceClosed] = useState(false)
  const native = Boolean(globalThis.chrome?.runtime?.id)
  const sidebar = location.pathname === '/sidepanel/index.html'
  useEffect(() => {
    if (!native || sidebar) return
    let active = true
    // A canvas opened on its own returns beside the page last used in its
    // window, which can change while it stays open.
    const resolve = () => { void returnSource().then(found => { if (active) setSource(found) }, error => { if (active) onError(`Unable to find a page to return to. ${String(error)}`) }) }
    resolve()
    window.addEventListener('galta-presentation-change', resolve)
    window.addEventListener('focus', resolve)
    return () => { active = false; window.removeEventListener('galta-presentation-change', resolve); window.removeEventListener('focus', resolve) }
  }, [native, sidebar, onError])
  const expanded = source && !source.inferred ? source.id : null
  useEffect(() => {
    if (!native || sidebar || expanded === null) return
    let active = true
    setSourceClosed(false)
    void chrome.tabs.get(expanded).catch(error => {
      if (!active) return
      if (/No tab with id/i.test(String(error))) setSourceClosed(true)
      else onError(`Unable to find the original page. ${String(error)}`)
    })
    const removed = (id: number) => { if (id === expanded) setSourceClosed(true) }
    chrome.tabs.onRemoved.addListener(removed)
    return () => { active = false; chrome.tabs.onRemoved.removeListener(removed) }
  }, [native, sidebar, expanded, onError])

  // A standalone workbench already has the whole tab. Browser fullscreen stays
  // a browser command, not a different behavior behind the same Galta action.
  if (!sidebar && (!native || source === null)) return null
  const label = sidebar ? 'Expand canvas' : 'Back to page'
  const hint = sourceClosed ? 'The original page was closed' : unavailable ?? (pending ? 'Opening canvas…' : !sidebar && source?.title ? `Back to ${source.title}` : label)
  const toggle = async () => {
    if (pending) return
    setPending(true); onPending(true)
    try {
      await prepare()
      const view = capture()
      const runningInExtension = Boolean(globalThis.chrome?.runtime?.id)
      if (runningInExtension) await (sidebar ? expandCanvas(projectId, view) : returnToPage(projectId, view, source!.id))
      else {
        const state = new URLSearchParams({ selection: JSON.stringify(view.selection), viewport: JSON.stringify(view.viewport) })
        window.open(`/canvas/index.html?project=${encodeURIComponent(projectId)}#${state}`, '_blank', 'noopener')
      }
    } catch (error) {
      if (error instanceof CanvasViewHandoffTimeout) onNotice?.("Your canvas is still here. The view switch didn't finish.")
      else onError(error instanceof Error ? error.message : 'Unable to open the canvas.')
    }
    finally { resume(); setPending(false); onPending(false) }
  }
  return <Tooltip><TooltipTrigger asChild><CanvasChromeSurface className="canvas-presentation-control pointer-events-auto inline-flex"><CanvasChromeButton className="canvas-presentation-button" aria-label={label} aria-description={hint} aria-busy={pending} disabled={disabled || Boolean(unavailable) || pending || sourceClosed} onClick={() => void toggle()}>
    {pending ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : sidebar ? <Maximize2 className="size-3.5" /> : <PanelLeftClose className="size-3.5" />}<span className="canvas-presentation-label hidden sm:inline" aria-hidden="true">{sidebar ? 'Expand' : 'Return'}</span>
  </CanvasChromeButton></CanvasChromeSurface></TooltipTrigger><TooltipContent side="bottom" align="end">{hint}</TooltipContent></Tooltip>
}
