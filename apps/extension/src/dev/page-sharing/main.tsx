// A local design prototype. Not imported by production or any build entry.
import { useCallback, useEffect, useRef, useState } from 'react'
import { CaptureUpdateAction, getCommonBounds, newElementWith } from '@excalidraw/excalidraw'
import type { AppState } from '@excalidraw/excalidraw/types'
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, Ellipsis, Globe2, History, Monitor, PanelRight, RotateCcw, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ExcalidrawCanvas } from '../../canvas/ExcalidrawCanvas'
import type { CanvasScene } from '../../canvas/scene'
import { CollectionPanel } from '../../canvas/CollectionPanel'
import { CanvasChromeButton, CanvasChromeSurface } from '../../canvas/CanvasChrome'
import { CanvasViewControls } from '../../canvas/CanvasViewControls'
import { DrawingTools } from '../../canvas/DrawingTools'
import { SelectionActions } from '../../canvas/SelectionActions'
import { ConversationDock } from '../../canvas/ConversationDock'
import { ConversationStore } from '../../canvas/conversationStore'
import { htmlDocument } from '../../canvas/htmlEmbed'
import { placeImage, prepareImage } from '../../canvas/imageImport'
import { UnpublishDialog, type ShareModel } from './SharePage'
import { ElementActions } from './ElementActions'
import { fixtureLabels, loadFixture, type FixtureKind } from './fixtures'
import { PAGE_ID, pageHtml, publishedUrl, storageKey, type Revision } from './artwork'
import '../../styles.css'
import '../../canvas/canvas.css'
import './prototype.css'

type Saved = { live: Revision | null; draft: Revision; everPublished: boolean }
const initial: Saved = { live: null, draft: 1, everPublished: false }
const documents = { 1: pageHtml(1), 2: pageHtml(2) }
function readSaved(): Saved {
  const raw = localStorage.getItem(storageKey)
  if (!raw) return initial
  const value = JSON.parse(raw) as Saved
  if (![null, 1, 2].includes(value.live) || ![1, 2].includes(value.draft) || typeof value.everPublished !== 'boolean') throw new Error('This prototype has invalid saved state.')
  return value
}

export function Prototype() {
  const [saved] = useState(readSaved)
  const [scene, setScene] = useState<CanvasScene | null>(null)
  const [draft, setDraft] = useState<Revision>(saved.draft), [live, setLive] = useState<Revision | null>(saved.live)
  const [everPublished, setEverPublished] = useState(saved.everPublished)
  const [signedIn, setSignedIn] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [panel, setPanel] = useState(false), [notice, setNotice] = useState('')
  const [fixture, setFixture] = useState<FixtureKind>('image'), [fixtureOpen, setFixtureOpen] = useState(false), [loadingFixture, setLoadingFixture] = useState(false)
  const [unpublishOpen, setUnpublishOpen] = useState(false), [accountOpen, setAccountOpen] = useState(false), [signInOpen, setSignInOpen] = useState(false)
  const [conversationOpen, setConversationOpen] = useState(false), [historyOpen, setHistoryOpen] = useState(false)
  const [scenarioOpen, setScenarioOpen] = useState(false), [failNext, setFailNext] = useState(false)
  const [boundary, setBoundary] = useState<HTMLElement | null>(null)
  const timer = useRef<number | null>(null)
  const [conversation] = useState(() => new ConversationStore())
  const [command] = useState(() => {
    let text = ''; const listeners = new Set<() => void>()
    return { getSnapshot: () => text, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, set: (next: string) => { text = next; listeners.forEach(fn => fn()) } }
  })
  const reference = new URLSearchParams(location.search).has('reference')
  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify({ live, draft, everPublished })) }, [live, draft, everPublished])
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
  useEffect(() => { if (!notice) return; const id = window.setTimeout(() => setNotice(''), 3_000); return () => clearTimeout(id) }, [notice])

  const fit = useCallback((editor: CanvasScene, size?: { width: number; height: number }) => {
    const s = size ?? editor.api.getAppState()
    const elements = editor.elements.filter(el => !el.isDeleted)
    if (!elements.length) return
    const [x1, y1, x2, y2] = getCommonBounds(elements)
    const zoom = Math.max(.1, Math.min((s.width - (s.width < 700 ? 96 : 220)) / (x2 - x1), (s.height - 250) / (y2 - y1), .85))
    editor.api.updateScene({ appState: { scrollX: s.width / zoom / 2 - (x1 + x2) / 2, scrollY: 155 / zoom - y1, zoom: { value: zoom as AppState['zoom']['value'] } }, captureUpdate: CaptureUpdateAction.NEVER })
  }, [])
  const mount = useCallback(async (editor: CanvasScene) => {
    const ids = await loadFixture(editor, 'image', saved.draft)
    setScene(editor); fit(editor); editor.select(ids)
    return editor.api.onChange(() => {
      const source = editor.elements.find(el => el.id === PAGE_ID)
      const html = source ? htmlDocument(source)?.html : undefined
      if (html === documents[1]) setDraft(1)
      else if (html === documents[2]) setDraft(2)
    })
  }, [fit, saved.draft])
  const showFixture = async (kind: FixtureKind) => {
    if (!scene || loadingFixture) return
    setFixtureOpen(false); setLoadingFixture(true)
    try { const ids = await loadFixture(scene, kind, draft); setFixture(kind); fit(scene); scene.select(ids) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'This example could not be opened.') }
    finally { setLoadingFixture(false) }
  }
  useEffect(() => {
    if (!scene || !boundary) return
    const viewport = boundary.querySelector('.galta-canvas')
    if (!viewport) return
    const observer = new ResizeObserver(entries => {
      const size = entries[0]?.contentRect
      if (size) fit(scene, size)
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [scene, boundary, fit])

  const edit = (revision: Revision) => {
    if (!scene?.elements.some(el => el.id === PAGE_ID)) return
    scene.replace(scene.elements.map(el => el.id === PAGE_ID ? newElementWith(el, { customData: { ...el.customData, htmlDocument: { html: documents[revision] } } }) : el))
    scene.select([PAGE_ID]); setError('')
  }
  const publish = () => {
    if (busy) return
    if (!signedIn) { setSignInOpen(true); return }
    const frozen = draft, willFail = failNext
    setBusy(true); setError(''); setFailNext(false)
    timer.current = window.setTimeout(() => {
      if (willFail) setError(live === null ? 'The page could not be published. Try again.' : 'The update did not go through. Your previous page is still live. Try again.')
      else { setLive(frozen); setEverPublished(true) }
      setBusy(false); timer.current = null
    }, 1_100)
  }
  const unpublish = () => { setLive(null); setUnpublishOpen(false); setError(''); setNotice('Page unpublished. Your canvas is unchanged.') }
  const requestUnpublish = () => { if (signedIn) setUnpublishOpen(true); else setSignInOpen(true) }
  const returnToShare = () => document.querySelector<HTMLButtonElement>('.page-share-trigger')?.focus()
  const returnFromUnpublish = () => {
    if (accountOpen) document.querySelector<HTMLButtonElement>('[data-published-unpublish], [data-published-pages] [data-dialog-close]')?.focus()
    else returnToShare()
  }
  const model: ShareModel = { live, draft, everPublished, signedIn, busy, error, publish, unpublish, signIn: () => setSignInOpen(true) }
  const reset = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; setBusy(false); setLive(null); setDraft(1); setEverPublished(false); setError(''); setSignedIn(true); setFailNext(false); edit(1); setScenarioOpen(false) }

  return <TooltipProvider><div className="sharing-prototype" data-panel={panel}>
    <div className="prototype-stage"><main ref={setBoundary} className="galta-shell prototype-canvas">
      <CollectionPanel onUse={async item => { if (scene) await placeImage(scene, await prepareImage(scene, { url: item.mediaUrl }), { x: 0, y: 0 }) }} canvasContext={<CanvasChromeSurface className="galta-document pointer-events-auto flex w-fit min-w-0 max-w-full items-center gap-1">
        <Popover><PopoverTrigger asChild><CanvasChromeButton aria-label="Tide light study"><span className="prototype-canvas-title">Tide light study</span><ChevronDown /></CanvasChromeButton></PopoverTrigger><PopoverContent align="start" className="p-1"><Button variant="ghost" className="w-full justify-start" onClick={() => { if (scene) fit(scene) }}>Fit artwork</Button><Button variant="ghost" className="w-full justify-start" onClick={() => setAccountOpen(true)}><ArrowUpRight />Published pages</Button></PopoverContent></Popover>
        <Popover open={historyOpen} onOpenChange={setHistoryOpen}><PopoverTrigger asChild><CanvasChromeButton aria-label="Time Machine"><History /><span className="prototype-history-label">Time Machine</span></CanvasChromeButton></PopoverTrigger><PopoverContent align="start" className="p-2"><p className="prototype-menu-label">On this canvas</p>{([1, 2] as const).map(revision => <Button key={revision} variant="ghost" className="w-full justify-between" onClick={() => { edit(revision); setHistoryOpen(false) }}>{revision === 1 ? 'Original wording' : 'Softer evening'}{draft === revision && <Check />}</Button>)}<p className="prototype-menu-note">Restoring your canvas leaves the published page unchanged.</p></PopoverContent></Popover>
      </CanvasChromeSurface>} viewControls={scene && <><CanvasViewControls scene={scene} /><Tooltip><TooltipTrigger asChild><CanvasChromeButton aria-label={panel ? 'Expand canvas' : 'Show side panel'} onClick={() => setPanel(!panel)}>{panel ? <Monitor /> : <PanelRight />}</CanvasChromeButton></TooltipTrigger><TooltipContent>{panel ? 'Expand canvas' : 'Side panel'}</TooltipContent></Tooltip></>}>
        <section className="galta-canvas" aria-label="Tide canvas">
          <ExcalidrawCanvas onMount={mount} />
          {scene && (reference ? <SelectionActions scene={scene} onOpenPage={async () => { window.open(`${location.pathname}?view=preview`, '_blank', 'noopener') }} onEdit={fn => fn()} onReplace={async () => {}} onError={setNotice} /> : <ElementActions scene={scene} model={model} onUnpublish={requestUnpublish} onError={setNotice} boundary={boundary} />)}
        </section>
        {scene && <DrawingTools scene={scene} onImport={async files => { for (const file of files) await placeImage(scene, await prepareImage(scene, { file, url: '' }), { x: 0, y: 0 }) }} />}
        <ConversationDock title="Tide light study" turns={[]} conversation={conversation} state="idle" error="" question={null} command={command} onSubmit={() => { if (fixture === 'page') edit(draft === 1 ? 2 : 1); command.set(''); setConversationOpen(false); setNotice('This is a local interaction study. No request was sent to an agent.') }} onStop={() => {}} open={conversationOpen} onOpen={setConversationOpen} preview={false} runtime={<span className="prototype-runtime-label">Design preview</span>} />
      </CollectionPanel>
      <Tooltip><TooltipTrigger asChild><Button className="prototype-settings" variant="ghost" size="icon-compact" aria-label="Account and published pages" onClick={() => setAccountOpen(true)}><Settings2 /></Button></TooltipTrigger><TooltipContent>Published pages</TooltipContent></Tooltip>
      {notice && <div className="prototype-notice glass-surface" role="status">{notice}</div>}
    </main></div>
    <footer className="prototype-review-bar"><div className="prototype-review-caption"><span className="prototype-label">Selection study</span><span className="prototype-review-detail">One canvas. Every kind of element.</span></div><div className="prototype-review-actions">
      <Popover open={fixtureOpen} onOpenChange={setFixtureOpen}><PopoverTrigger asChild><Button variant="ghost" size="compact" disabled={loadingFixture} aria-label="Choose example element">{loadingFixture ? 'Loading…' : fixtureLabels[fixture]}<ChevronDown /></Button></PopoverTrigger><PopoverContent side="top" align="end" className="element-menu">{Object.entries(fixtureLabels).map(([kind, label]) => <Button key={kind} variant="ghost" className="element-menu-row" onClick={() => void showFixture(kind as FixtureKind)}>{label}{kind === fixture && <span className="element-current">Current</span>}</Button>)}</PopoverContent></Popover>
      <div className="prototype-layout-controls"><Button variant="ghost" size="icon-compact" aria-label="Full canvas layout" aria-pressed={!panel} onClick={() => setPanel(false)}><Monitor /></Button><Button variant="ghost" size="icon-compact" aria-label="Narrow side panel layout" aria-pressed={panel} onClick={() => setPanel(true)}><PanelRight /></Button></div>
      <Button variant="ghost" size="compact" onClick={() => { if (fixture === 'page') { edit(draft === 1 ? 2 : 1); setNotice('The canvas changed. Your published page stays as it was.') } else void showFixture(fixture) }}>{fixture === 'page' ? 'Try an edit' : 'Reset example'}</Button>
      <Popover open={scenarioOpen} onOpenChange={setScenarioOpen}><PopoverTrigger asChild><Button variant="ghost" size="icon-compact" aria-label="Prototype scenarios"><Ellipsis /></Button></PopoverTrigger><PopoverContent side="top" align="end" className="p-1"><Button variant="ghost" className="w-full justify-start" onClick={() => { setSignedIn(!signedIn); setScenarioOpen(false); setNotice(signedIn ? 'Previewing the signed-out state.' : 'Previewing the signed-in state.') }}>{signedIn ? 'Try signed out' : 'Try signed in'}</Button><Button variant="ghost" className="w-full justify-start" onClick={() => { setFailNext(true); setScenarioOpen(false); setNotice('The next publish will fail, so you can try recovery.') }}>Fail the next publish</Button><Button variant="ghost" className="w-full justify-start" onClick={reset}><RotateCcw />Reset prototype</Button></PopoverContent></Popover>
    </div></footer>
    <UnpublishDialog open={unpublishOpen} onOpenChange={setUnpublishOpen} onConfirm={unpublish} onReturnFocus={returnFromUnpublish} />
    <Dialog open={signInOpen} onOpenChange={setSignInOpen}><DialogContent className="page-share-dialog" onCloseAutoFocus={event => { event.preventDefault(); returnFromUnpublish() }}><DialogTitle className="page-share-dialog-title">A home for your published pages.</DialogTitle><DialogDescription className="page-share-dialog-description">Sign in with Aha Labs to publish and manage your links. Downloading and your canvas stay available without an account.</DialogDescription><Button className="w-full" onClick={() => { setSignedIn(true); setSignInOpen(false); setNotice('Signed in for this preview. Your page is ready to publish.') }}>Continue with Aha Labs<ArrowUpRight /></Button><p className="prototype-menu-note">Sign-in is simulated in this prototype.</p></DialogContent></Dialog>
    <Dialog open={accountOpen} onOpenChange={setAccountOpen}><DialogContent className="page-share-dialog" data-published-pages onOpenAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLElement>('[data-published-heading]')?.focus() }} onCloseAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLButtonElement>('.prototype-settings')?.focus() }}><DialogTitle className="page-share-dialog-title outline-none" data-published-heading tabIndex={-1}>Published pages</DialogTitle><DialogDescription className="page-share-dialog-description">Your links, even after a canvas is put away.</DialogDescription>
      {live !== null ? <div className="prototype-published-item"><Globe2 /><div><strong>Tide</strong><span>Anyone with the link</span></div><Button asChild variant="ghost" size="icon-compact"><a href={publishedUrl()} target="_blank" rel="noreferrer" aria-label="Visit Tide"><ArrowUpRight /></a></Button><Button variant="ghost" size="compact" data-published-unpublish disabled={busy} onClick={requestUnpublish}>Unpublish</Button></div> : <div className="prototype-published-empty"><Globe2 /><p>No published pages yet.</p><span>Select a webpage on your canvas and choose Share.</span></div>}
    </DialogContent></Dialog>
  </div></TooltipProvider>
}

export function PublishedPreview() {
  const preview = new URLSearchParams(location.search).get('view') === 'preview'
  const published = preview ? readSaved().draft : readSaved().live
  return <div className="published-prototype"><div className="published-prototype-bar"><a href={location.pathname}><ArrowLeft />Back to canvas</a><span>{preview ? 'Page preview' : 'Local publish preview'}</span><Button variant="ghost" size="compact" onClick={() => location.reload()}><RotateCcw />Refresh</Button></div>{published === null ? <main className="prototype-unpublished"><Globe2 /><h1>This page is no longer published.</h1><p>Its creator can publish it again when it is ready.</p></main> : <iframe className="published-prototype-page" title="Published Tide webpage" sandbox="allow-scripts allow-forms allow-downloads" srcDoc={documents[published]} />}</div>
}
