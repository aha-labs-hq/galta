import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Dialog } from 'radix-ui'
import { ChevronDown, History, Pause, PenLine, Play, Undo2, X } from 'lucide-react'
import type { BinaryFiles } from '@excalidraw/excalidraw/types'
import type { CanvasAssets } from '@galta/canvas'
import type { WorkspaceBundle } from '@galta/storage'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { themeEasing, themeLength, themeTime } from '../design/theme'
import { CanvasChromeButton } from './CanvasChrome'
import { HistoryStage, elementBounds, type Bounds, type HistoryStageHandle, type LiveView, type StageCamera } from './HistoryStage'
import { HistoryRuler, clockLabel, dayLabel, type TrimRange } from './HistoryRuler'
import { historyMoments, historyTimeline, readableDocument, type Moment, type Moments } from './historyTimeline'
import { MAX_LANES, latestTip, multiverseLayout, pathTo } from './historyLayout'
import { documentChanges, shownObjects, summarizeChanges } from './historyChanges'
import { missingObjects, takeBackCount } from './historyRecovery'
import { trimHistory } from './historyTrim'
import { recordHistory } from './historyExport'
import type { SceneSnapshot } from './scene'
import './history.css'

type Motion = 'step' | 'play' | 'cut'

function Hint({ label, children }: { label: string; children: React.ReactElement }) {
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
}

/** A moment in the user's words: what happened, who did it, and when. */
function describe(moment: Moment, title: string, summary: string) {
  const when = `${dayLabel(moment.end)}, ${clockLabel(moment.end)}`
  const who = moment.source === 'agent' ? 'Galta' : moment.source === 'start' ? 'Start' : 'You'
  return { title: moment.name ?? title, detail: [who, when, moment.name ? summary : undefined].filter(Boolean).join(' · ') }
}

/** The session around a moment on the path: where a trim starts. */
function sessionAround(path: readonly string[], starts: ReadonlySet<string>, index: number): TrimRange {
  let from = index, to = index
  while (from > 0 && !starts.has(path[from]!)) from--
  while (to < path.length - 1 && !starts.has(path[to + 1]!)) to++
  return { from, to }
}

/**
 * Time Machine: every moment of the canvas on one ruler, with every other
 * future it has had growing from where it branched. The stage is the canvas
 * as it was, under the same camera; nothing here edits the canvas until the
 * user restores a moment, takes objects back, names one, or cuts a range.
 * The working editor stays mounted underneath with its camera, selection,
 * draft and undo stack.
 */
export function HistoryBrowser({ workspace, currentId, title, disabled, onOpen, onClose, onResume, onRestore, onBringBack, onName, onCut, onError, liveView, files }: {
  workspace: WorkspaceBundle; currentId: string; title: string; disabled: boolean
  onOpen: () => Promise<string>; onClose: () => void
  /** After adopting history, focus the working canvas for continued editing. */
  onResume: () => void
  onRestore: (id: string, expectedHead: string, camera: StageCamera) => Promise<void>
  onBringBack: (id: string, expectedHead: string, objects: readonly string[] | undefined, camera: StageCamera) => Promise<void>
  onName: (id: string, label: string) => Promise<void>
  onCut: (ids: readonly string[]) => Promise<void>
  /** Report a failed pending cut if the layout removed the dialog. */
  onError: (message: string) => void
  /** The live editor's camera and box, which the stage opens over and returns to. */
  liveView: () => LiveView | undefined
  files: (assets: CanvasAssets) => BinaryFiles
}) {
  const [open, setOpen] = useState(false)
  const [opening, setOpening] = useState(false)
  const [arrived, setArrived] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [entryHead, setEntryHead] = useState(currentId)
  const [tip, setTip] = useState<string | undefined>(undefined)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  /** A version inside the selected moment, reached with Option and the arrows;
   * null is the moment itself, its last version. */
  const [step, setStep] = useState<number | null>(null)
  const [motion, setMotion] = useState<Motion>('step')
  const [comparing, setComparing] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [trim, setTrim] = useState<TrimRange | null>(null)
  /** A cut waiting for the visit to end, and where the user stood before it, which Undo returns to. */
  const [cut, setCut] = useState<{ commits: string[]; moments: number; before: { tip: string | undefined; selected: string | undefined } } | null>(null)
  const [exporting, setExporting] = useState<AbortController | null>(null)
  const [objects, setObjects] = useState<string[]>([])
  const [insets, setInsets] = useState({ top: 0, bottom: 0 })
  const trigger = useRef<HTMLButtonElement>(null), surface = useRef<HTMLDivElement>(null), backdrop = useRef<HTMLDivElement>(null)
  const ruler = useRef<HTMLDivElement>(null), caption = useRef<HTMLElement>(null), controls = useRef<HTMLElement>(null)
  const stage = useRef<HistoryStageHandle>(null)
  const returnToCanvas = useRef(false)
  /** Where the user travelled from: Down returns to that timeline and moment. */
  const submitting = useRef(false), back = useRef<{ tip: string | undefined; selected: string | undefined }[]>([])
  const closeHandler = useRef(onClose), cutHandler = useRef(onCut), errorHandler = useRef(onError), pending = useRef(cut)
  const cutting = useRef<Promise<void> | null>(null)
  closeHandler.current = onClose; cutHandler.current = onCut; errorHandler.current = onError; pending.current = cut

  // A cut waits for the visit to end, so it can be undone until then. Another
  // window may already have cut some of it; only what is still there is cut.
  const view = useMemo(() => cut ? trimHistory(workspace, cut.commits) : workspace, [workspace, cut])
  const message = (failure: unknown) => failure instanceof Error ? failure.message : String(failure)
  // Building history must never take the canvas down: a failure is shown.
  const history = useMemo(() => {
    if (!open) return undefined
    try { return { moments: historyMoments(view, historyTimeline(view, entryHead)) } }
    catch (failure) { return { failure: message(failure) } }
  }, [open, view.project, view.snapshots, view.namedVersions, view.agentSessions, view.agentCheckpoints, entryHead])
  const moments = history && 'moments' in history ? history.moments : undefined
  const lanes = useMemo(() => moments && [...moments.byId.values()].some(moment => moment.children.length > 1) ? MAX_LANES : 0, [open, Boolean(moments)])
  const spacing = useMemo(() => open ? { gap: themeLength('--history-tick-gap'), session: themeLength('--history-session-gap') } : { gap: 8, session: 16 }, [open])
  const travelTip = tip && moments?.byId.has(tip) ? tip : moments?.current
  const arranged = useMemo(() => {
    try { return { layout: moments && travelTip ? multiverseLayout(moments, travelTip, spacing) : undefined } }
    catch (failure) { return { layout: undefined, failure: message(failure) } }
  }, [moments, travelTip, spacing])
  const layout = arranged.layout
  const home = useMemo(() => new Set(moments ? pathTo(moments, moments.current) : []), [moments])
  const path = layout?.path ?? []
  const found = selectedId ? path.indexOf(selectedId) : -1
  const index = found >= 0 ? found : Math.max(0, path.length - 1)
  const moment = moments?.byId.get(path[index] ?? '')
  const stepAt = moment && step !== null && moment.commits.length > 1 ? Math.min(step, moment.commits.length - 1) : null
  const version = moment && (stepAt === null ? moment.id : moment.commits[stepAt]!)
  /** What the shown version continues from: the version before it in its moment, or the moment before. */
  const previous = moment && (stepAt ? moment.commits[stepAt - 1]! : moment.parent)
  const snapshot = (id: string) => view.snapshots[id] as SceneSnapshot | undefined
  const current = moments ? snapshot(moments.current) : undefined
  const shown = comparing ? current : version ? snapshot(version) : undefined
  const doc = (id: string | null | undefined) => id ? readableDocument(view.snapshots[id]) : undefined
  const changes = useMemo(() => { const after = doc(version); return after && (!previous || doc(previous)) ? documentChanges(doc(previous), after) : [] }, [version, previous, view.snapshots])
  const focus = useMemo((): Bounds | null => {
    const document = doc(version)
    if (!moment || !document || !previous) return null
    const after = shownObjects(document), parent = doc(previous), before = parent ? shownObjects(parent) : new Map()
    return elementBounds(changes.map(change => after.get(change.id) ?? before.get(change.id)).filter(Boolean))
  }, [version, previous, changes])
  const summary = summarizeChanges(changes)
  const titleOf = (m: Moment) => m.source === 'agent' ? (m.turn ? `“${m.turn.instruction.replace(/\s+/g, ' ').trim()}”` : 'Edited by Galta')
    : !doc(m.id) ? 'This moment can’t be shown'
    : m.source === 'start' ? (doc(m.id)!.elements.some(element => !element.isDeleted) ? 'Start' : 'Empty canvas')
    : m.restored && !changes.length ? `Went back to ${m.parent ? `${dayLabel(moments!.byId.get(m.parent)!.end)}, ${clockLabel(moments!.byId.get(m.parent)!.end)}` : 'the start'}`
    : m.source === 'import' ? summary.replace(/^Added/, 'Imported') : summary
  const described = moment && moments ? describe(moment, titleOf(moment), summary) : { title: 'Time Machine', detail: '' }
  const text = moment && stepAt !== null ? { ...described, detail: `${described.detail} · Step ${stepAt + 1} of ${moment.commits.length}` } : described
  const target = version
  const isCurrent = target === view.project.headCommitId
  const timelineLabel = travelTip !== moments?.current ? 'Other timeline' : isCurrent ? 'Current canvas' : 'Current timeline'
  // A timeline is a path to a tip. The menu exposes even the futures folded
  // into buds, without adding another source of selection or branch state.
  const timelines = useMemo(() => moments ? [moments.byId.get(moments.current)!, ...[...moments.byId.values()]
    .filter(m => !m.children.length && m.id !== moments.current).sort((a, b) => b.end - a.end)]
    .map(m => ({ id: m.id, when: `${dayLabel(m.end)}, ${clockLabel(m.end)}`, label: m.id === moments.current ? 'Current canvas' : m.name
      ?? (m.turn ? `“${m.turn.instruction.replace(/\s+/g, ' ').trim()}”` : doc(m.id) ? summarizeChanges(documentChanges(doc(m.parent), doc(m.id)!)) : 'This moment can’t be shown') })) : [], [moments, view.snapshots])
  const bringBackCount = useMemo(() => {
    if (!open || !target || !current) return 0
    const document = doc(target)
    if (!document) return 0
    try { return objects.length ? takeBackCount(document, current.document, objects) : isCurrent ? 0 : missingObjects(document, current.document).length }
    catch { return 0 }
  }, [open, target, objects, current, isCurrent])
  const trimCount = trim ? trim.to - trim.from + 1 : 0
  const trimHoldsCurrent = Boolean(trim && moments && path.slice(trim.from, trim.to + 1).includes(moments.current))

  const select = (id: string, how: Motion = 'step') => {
    if (how !== 'play') setPlaying(false)
    setMotion(how); setSelectedId(id); setStep(null); setComparing(false); setNaming(false); setError(null); setObjects([])
  }
  const seek = (i: number, how: Motion = 'step') => { const id = path[Math.max(0, Math.min(path.length - 1, i))]; if (id) select(id, how) }
  /** `again` goes on around a fork Up already left: Down still returns to the first departure. */
  const travel = (id: string, again = false) => {
    if (!moments) return
    if (!again) back.current.push({ tip: travelTip, selected: path[index] })
    setTip(latestTip(moments, id)); setTrim(null); select(id)
  }
  const goHome = () => { if (moments) { back.current = []; setTip(moments.current); setTrim(null); select(moments.current) } }
  const goBack = () => {
    const previous = back.current.pop()
    if (previous?.selected && moments?.byId.has(previous.selected)) { setTip(previous.tip); setTrim(null); select(previous.selected) } else goHome()
    ruler.current?.focus()
  }

  const failure = (history && 'failure' in history ? history.failure : undefined) ?? arranged.failure
  // A visit that cannot show its history still arrives, so its error is seen.
  useEffect(() => { if (failure) { setError(failure); setArrived(true) } }, [failure])
  useEffect(() => { if (!open || busy || naming || comparing) setPlaying(false) }, [open, busy, naming, comparing])
  useEffect(() => () => exporting?.abort(), [exporting])
  useEffect(() => {
    const pause = () => setPlaying(false)
    document.addEventListener('visibilitychange', pause)
    return () => document.removeEventListener('visibilitychange', pause)
  }, [])
  // A layout change can unmount the visit without Dialog's close event; a
  // pending cut is still written then, as closing would have.
  useEffect(() => () => {
    if (pending.current) void (cutting.current ?? cutHandler.current(pending.current.commits)).catch(failure => {
      errorHandler.current(`Unable to finish cutting Time Machine history. ${message(failure)}`)
    })
    closeHandler.current()
  }, [])

  // The caption and controls cover the stage's edges; the camera keeps
  // changes clear of them.
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const live = liveView(), top = caption.current?.getBoundingClientRect().bottom ?? 0, bottom = controls.current?.getBoundingClientRect().top ?? innerHeight
      if (live) setInsets({ top: Math.max(0, top - live.offsetTop), bottom: Math.max(0, live.offsetTop + live.height - bottom) })
    }
    const observer = new ResizeObserver(measure)
    for (const element of [caption.current, controls.current]) if (element) observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [open, arrived])

  // Playback walks the path (or the trimmed range) at an even step, waiting
  // for a moment's ink to be drawn.
  useEffect(() => {
    if (!playing || !layout) return
    const end = trim ? trim.to : path.length - 1
    if (index >= end) { setPlaying(false); return }
    let cancelled = false
    const timer = setTimeout(() => void (stage.current?.drawn() ?? Promise.resolve()).then(() => { if (!cancelled) seek(index + 1, 'play') }), themeTime('--motion-history-step'))
    return () => { cancelled = true; clearTimeout(timer) }
  }, [playing, index, layout, trim])

  const play = () => {
    if (playing) { stage.current?.finishDrawing(); setPlaying(false); return }
    if (path.length < 2) return
    const start = trim ? trim.from : 0, end = trim ? trim.to : path.length - 1
    if (index >= end || index < start) seek(start, 'play')
    setPlaying(true)
  }
  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError(null); setPlaying(false)
    try { await action(); return true }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to complete this action.'); return false }
    finally { setBusy(false) }
  }
  /** A pending cut is written before Restore or Bring back change the canvas. */
  const commitCut = () => {
    if (!pending.current) return Promise.resolve()
    if (!cutting.current) cutting.current = cutHandler.current(pending.current.commits)
      .then(() => { pending.current = null; setCut(null) })
      .finally(() => { cutting.current = null })
    return cutting.current
  }

  const finish = () => { setOpen(false); setLeaving(false); setArrived(false); setPlaying(false); setComparing(false); setTrim(null); setError(null); onClose() }
  /** `adopted` means the live canvas already shows what the stage shows. A
   * pending cut is written first; if that fails, the visit stays open. */
  const close = (adopted = false) => {
    if (busy || leaving) return
    if (cut) { void act(commitCut).then(done => { if (done) leave(adopted) }); return }
    leave(adopted)
  }
  const leave = (adopted: boolean) => {
    exporting?.abort()
    returnToCanvas.current = adopted
    setLeaving(true); setPlaying(false)
    const duration = themeTime('--motion-sheet-exit'), easing = themeEasing('--ease-settle')
    if (!adopted && moments && target !== moments.current) select(moments.current)
    const flight = adopted ? undefined : stage.current?.fly('live', duration, easing)
    const fading = [caption.current, controls.current].map(element => duration ? element?.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing, fill: 'both' }).finished : undefined)
    // The field stays until the camera has nearly landed, so the live canvas
    // is never seen beside the returning artwork.
    const field = duration ? backdrop.current?.animate([{ opacity: 1 }, { opacity: 1, offset: .6 }, { opacity: 0 }], { duration, easing: 'linear', fill: 'both' }).finished : undefined
    void Promise.all([flight, field, ...fading]).catch(() => {}).then(finish)
  }

  const startTrim = () => {
    if (!layout || !moments) return
    setPlaying(false); setObjects([])
    // On another timeline, its own moments; at home, the session around the moment.
    const divergence = path.findIndex(id => !home.has(id))
    setTrim(divergence >= 0 && index >= divergence ? { from: divergence, to: path.length - 1 } : sessionAround(path, layout.sessionStarts, index))
    ruler.current?.focus()
  }
  const finishTrim = () => { setTrim(null); ruler.current?.focus() }
  const applyCut = () => {
    if (!trim || !moments || trimHoldsCurrent) return
    const ids = path.slice(trim.from, trim.to + 1), commits = ids.flatMap(id => moments.byId.get(id)!.commits)
    const neighbour = path[trim.to + 1] ?? path[trim.from - 1]
    setCut(previous => ({ commits: [...previous?.commits ?? [], ...commits], moments: (previous?.moments ?? 0) + ids.length, before: previous?.before ?? { tip: travelTip, selected: path[index] } }))
    setTrim(null)
    if (neighbour) select(neighbour, 'cut'); else goHome()
    ruler.current?.focus()
  }
  /** Undo returns history and the user to where they were before the cut. */
  const undoCut = () => {
    if (!cut) return
    const { tip: before, selected } = cut.before
    setCut(null); setTip(before)
    if (selected) select(selected)
    ruler.current?.focus()
  }
  const exportRange = async () => {
    if (!trim || !layout || exporting) return
    const controller = new AbortController(), range = path.slice(trim.from, trim.to + 1)
    setExporting(controller); setPlaying(false); setError(null)
    try {
      const file = await recordHistory({ stage: () => stage.current, moments: range, show: id => select(id, 'play'), step: themeTime('--motion-history-step') * 2, signal: controller.signal })
      const anchor = document.createElement('a'), url = URL.createObjectURL(file.blob)
      anchor.href = url; anchor.download = `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Canvas'} — Time Machine.${file.extension}`; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to export this video.') }
    finally { setExporting(null) }
  }

  const cutNote = cut ? `${cut.moments} ${cut.moments === 1 ? 'moment' : 'moments'} cut. Undo before closing Time Machine.` : null
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) close() }}>
    <Hint label="Time Machine"><CanvasChromeButton ref={trigger} className="history-entry" aria-label="Open Time Machine" disabled={disabled || opening} onClick={() => {
      setOpening(true); setError(null)
      void onOpen().then(id => {
        setArrived(false); back.current = []; returnToCanvas.current = false
        // Arriving is not a step: the camera and the light wait for the user's first move.
        setEntryHead(id); setTip(undefined); setSelectedId(undefined); setMotion('cut'); setComparing(false); setNaming(false); setPlaying(false); setTrim(null); setCut(null); setObjects([]); setOpen(true)
      }).catch(failure => { setError(message(failure)); onClose() }).finally(() => setOpening(false))
    }}><History className="size-3.5" aria-hidden="true" /><span className="history-entry-label hidden sm:inline" aria-hidden="true">Time Machine</span></CanvasChromeButton></Hint>
    {!open && error && <p className="canvas-notice glass-surface" role="alert">{error}</p>}
    <Dialog.Portal>
      <Dialog.Overlay ref={backdrop} className="history-backdrop" data-arrived={arrived || undefined} />
      <Dialog.Content ref={surface} className="history" data-arrived={arrived || undefined} data-leaving={leaving || undefined} aria-describedby={undefined}
        onOpenAutoFocus={event => { event.preventDefault(); ruler.current?.focus() }}
        onCloseAutoFocus={event => { event.preventDefault(); if (returnToCanvas.current) onResume(); else trigger.current?.focus() }}
        onEscapeKeyDown={event => { event.preventDefault(); if (naming) setNaming(false); else if (exporting) exporting.abort(); else if (trim) finishTrim(); else if (objects.length) setObjects([]); else close() }}
        onPointerDownOutside={event => event.preventDefault()}
        // A file dropped here must not replace the page.
        onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}
        // The editor has document-level keyup handlers too: an arrow release
        // can rebind the live selection even though its keydown stayed here.
        onKeyUp={event => event.stopPropagation()}
        onKeyDown={event => {
          event.stopPropagation()
          const element = event.target as HTMLElement, typing = element.matches('input, textarea')
          // A portalled timeline menu owns its arrows, typeahead and Escape.
          if (event.defaultPrevented || element.closest('[role=menu]')) return
          // The working canvas underneath never receives edits from here.
          if (!typing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (cut && !event.shiftKey && !busy && !leaving) undoCut(); return }
          if (!typing && ['Delete', 'Backspace'].includes(event.key)) event.preventDefault()
          if (typing || busy || leaving || exporting || !layout) return
          if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event.altKey && moments) {
            // Option steps through every saved version along the path.
            event.preventDefault()
            const direction = event.key === 'ArrowLeft' ? -1 : 1, here = moment!, at = stepAt ?? here.commits.length - 1
            if (at + direction >= 0 && at + direction < here.commits.length) { setMotion('step'); setStep(at + direction); setObjects([]); setComparing(false) }
            else if (direction < 0 && index > 0) { const before = moments.byId.get(path[index - 1]!)!; select(before.id); setStep(before.commits.length - 1) }
            else if (direction > 0 && index < path.length - 1) { const after = moments.byId.get(path[index + 1]!)!; select(after.id); setStep(after.commits.length > 1 ? 0 : null) }
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            const direction = event.key === 'ArrowLeft' ? -1 : 1
            // Shift goes to the next session, or back to the start of this one.
            let i = index + direction
            if (event.shiftKey && direction > 0) while (i < path.length - 1 && !layout.sessionStarts.has(path[i]!)) i++
            if (event.shiftKey && direction < 0) { i = layout.sessionStarts.has(path[index]!) ? index - 1 : index; while (i > 0 && !layout.sessionStarts.has(path[i]!)) i-- }
            seek(i)
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            // Into the future that branched at this moment, else the next
            // future of the fork Up just left, else the nearest other
            // timeline above the playhead.
            const here = path[index]!, x = layout.at.get(here)!.x
            const newest = (fork: string) => [...moments!.byId.get(fork)!.children].sort((a, b) => moments!.byId.get(latestTip(moments!, b))!.end - moments!.byId.get(latestTip(moments!, a))!.end)
            const futures = newest(here)
            // Cycle all futures at the fork, including those folded into a
            // bud. Always choosing the newest would trap travel in two paths.
            if (futures.some(id => id !== path[index + 1])) { travel(futures[(futures.indexOf(path[index + 1]!) + 1) % futures.length]!); return }
            // Up lands on a future's first moment. Where nothing branches
            // from it, another Up goes on around the fork it left; Down
            // still returns to that first departure.
            const left = back.current.at(-1)?.selected, siblings = left !== undefined && moments!.byId.get(here)!.parent === left ? newest(left) : []
            if (siblings.length > 1) { travel(siblings[(siblings.indexOf(here) + 1) % siblings.length]!, true); return }
            const best = layout.strands.filter(strand => strand.index)
              .flatMap(strand => strand.moments.map(id => ({ id, d: Math.abs(layout.at.get(id)!.x - x) + layout.at.get(id)!.lane * 4 })))
              .sort((a, b) => a.d - b.d)[0]
            if (best) travel(best.id)
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            goBack()
          } else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); seek(event.key === 'Home' ? trim?.from ?? 0 : trim?.to ?? path.length - 1) }
          else if (event.code === 'Space' && !element.closest('button')) { event.preventDefault(); play() }
        }}>
        <Dialog.Title className="sr-only">Time Machine</Dialog.Title>
        {open && shown && <HistoryStage ref={stage} version={comparing ? view.project.headCommitId : target ?? ''} snapshot={shown} focus={comparing || leaving || motion === 'cut' ? null : focus} light={motion === 'step'} by={moment?.source === 'agent' ? 'agent' : 'user'}
          settled={motion !== 'cut' && !comparing} label={comparing ? 'Current canvas' : 'Selected moment'} live={liveView} files={files} insets={insets}
          selected={objects} onSelect={(ids, additive) => setObjects(previous => additive ? [...new Set([...previous.filter(id => !ids.includes(id)), ...ids.filter(id => !previous.includes(id))])] : ids)}
          onReady={() => setArrived(true)} />}
        <header ref={caption} className="history-caption">
          <div className="history-caption-text">
            {naming ? <form onSubmit={event => {
              event.preventDefault()
              if (submitting.current || !target) return
              // A name belongs to the version on stage: inside a moment, that
              // version becomes a moment of its own, which then stays selected.
              if (name.trim() === (stepAt === null ? moment?.name ?? '' : '').trim()) { setNaming(false); return }
              submitting.current = true
              void act(() => onName(target, name)).then(done => { if (done) { setNaming(false); if (stepAt !== null && name.trim()) select(target) } }).finally(() => { submitting.current = false })
            }}>
              <Input autoFocus aria-label="Moment name" placeholder={stepAt === null ? 'Name this moment' : 'Name this version'} maxLength={80} value={name} disabled={busy}
                onChange={event => setName(event.target.value)} onBlur={event => event.currentTarget.form?.requestSubmit()} />
            </form> : <Hint label={stepAt !== null ? 'Name this version' : moment?.name ? 'Rename this moment' : 'Name this moment'}>
              <button type="button" className="history-title" disabled={busy || comparing || !moment} onClick={() => { setPlaying(false); setName(stepAt === null ? moment?.name ?? '' : ''); setNaming(true) }}>
                <span>{text.title}</span><PenLine aria-hidden="true" />
              </button>
            </Hint>}
            <div className="history-detail">
              <span className="history-meta">{text.detail}</span>
              <span className="history-location">
              {timelines.length > 1 ? <DropdownMenu onOpenChange={value => { if (value) setPlaying(false) }}>
                <DropdownMenuTrigger asChild><Button variant="ghost" size="compact" className="history-timeline-trigger" aria-label={`${timelineLabel}: choose timeline`} disabled={busy || Boolean(exporting) || Boolean(trim)}>{timelineLabel}<ChevronDown aria-hidden="true" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent className="history-timeline-menu" align="start" collisionPadding={themeLength('--space-3')}>
                  <DropdownMenuRadioGroup value={travelTip!} onValueChange={id => { if (id === moments?.current) goHome(); else if (id !== travelTip) travel(id); else select(id) }}>
                    {timelines.map(timeline => <DropdownMenuRadioItem key={timeline.id} value={timeline.id} className="history-timeline-option">
                      <span><span className="history-timeline-name">{timeline.label}</span><span className="history-timeline-date">{timeline.when}</span></span>
                    </DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu> : isCurrent && <span>Current canvas</span>}
              {back.current.length > 0 && <Hint label="Back to the timeline and moment you came from · ↓"><Button variant="ghost" size="compact" className="history-back" disabled={busy || Boolean(exporting)} onClick={goBack}><Undo2 aria-hidden="true" />Back</Button></Hint>}
              </span>
            </div>
          </div>
          <Hint label="Close Time Machine"><Button variant="ghost" size="icon-compact" aria-label="Close Time Machine" disabled={busy} onClick={() => close()}><X /></Button></Hint>
        </header>
        <footer ref={controls} className="history-controls">
          {error && <p className="history-error" role="alert">{error}</p>}
          {cut && <p className="history-context" role="status">{cutNote}</p>}
          {trim && <p className="history-context">{trimHoldsCurrent ? 'The current canvas can’t be cut. Adjust the range to cut.' : 'You can undo a cut until you close Time Machine.'}</p>}
          <div className="history-actions">
            {trim ? <>
              <Hint label="Save this range as a video of the canvas changing">
                <Button variant="ghost" size="compact" disabled={busy || Boolean(exporting) || trimCount < 2} onClick={() => void exportRange()}>{exporting ? 'Recording…' : 'Export video'}</Button>
              </Hint>
              {exporting ? <Button variant="ghost" size="compact" onClick={() => exporting.abort()}>Stop</Button>
                : <Hint label={trimHoldsCurrent ? 'The current canvas can’t be cut' : 'Remove these moments from history. Undo until you close.'}>
                  <span><Button variant="ghost" size="compact" className="history-cut" disabled={busy || trimHoldsCurrent} onClick={applyCut}>Cut {trimCount === 1 ? 'moment' : `${trimCount} moments`}</Button></span>
                </Hint>}
              <span className="history-spacer" />
              <Button size="compact" className="history-primary" disabled={Boolean(exporting)} onClick={finishTrim}>Done</Button>
            </> : <>
              {cut && <Hint label={cutNote!}><Button variant="ghost" size="compact" disabled={busy} onClick={undoCut}>Undo cut</Button></Hint>}
              {!cut && !isCurrent && !objects.length && <Hint label="Hold to see the current canvas">
                <Button variant="ghost" size="compact" aria-pressed={comparing} disabled={busy}
                  onPointerDown={event => { if (event.button === 0) { event.currentTarget.setPointerCapture(event.pointerId); setPlaying(false); setComparing(true) } }}
                  onPointerUp={() => setComparing(false)} onPointerCancel={() => setComparing(false)} onLostPointerCapture={() => setComparing(false)}
                  onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); setPlaying(false); setComparing(true) } }}
                  onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') setComparing(false) }} onBlur={() => setComparing(false)}>Compare</Button>
              </Hint>}
              {objects.length > 0 && <Button variant="ghost" size="compact" disabled={busy} onClick={() => { setObjects([]); ruler.current?.focus() }}>Clear selection</Button>}
              {objects.length > 0 && <span className="history-spacer" />}
              {bringBackCount > 0 && <Hint label={objects.length ? 'Put the chosen objects back on your current canvas as they were then. You can undo this on the canvas.' : `Add the ${bringBackCount === 1 ? 'object' : `${bringBackCount} objects`} this moment has that your canvas no longer shows`}>
                <Button variant={objects.length ? 'default' : 'ghost'} size="compact" className={objects.length ? 'history-primary' : undefined} disabled={busy} onClick={() => void act(async () => { await commitCut(); await onBringBack(target!, entryHead, objects.length ? objects : undefined, stage.current!.camera()) }).then(done => { if (done) leave(true) })}>Bring back {bringBackCount} {bringBackCount === 1 ? 'object' : 'objects'}</Button>
              </Hint>}
              {!cut && !bringBackCount && objects.length > 0 && <p className="history-hint">Your canvas already has {objects.length === 1 ? 'this' : 'these'} as it was then</p>}
              {!cut && !bringBackCount && !objects.length && isCurrent && <p className="history-hint">{path.length > 1 ? 'Slide the ruler to go back in time' : 'History grows as you work'}</p>}
              {!objects.length && <span className="history-spacer" />}
              {!isCurrent && !objects.length && <Hint label="Make this moment your canvas. The current canvas stays in history, and Galta’s conversation continues from here.">
                <Button size="compact" className="history-primary" disabled={busy || !target} onClick={() => void act(async () => { await commitCut(); await onRestore(target!, entryHead, stage.current!.camera()) }).then(done => { if (done) leave(true) })}>Restore canvas</Button>
              </Hint>}
            </>}
          </div>
          <div className="history-transport" data-trimming={Boolean(trim) || undefined}>
            <Hint label={playing ? 'Pause' : 'Play history'}>
              <Button variant="ghost" size="icon-compact" aria-label={playing ? 'Pause' : 'Play history'} disabled={busy || Boolean(exporting) || path.length < 2} onClick={play}>{playing ? <Pause /> : <Play />}</Button>
            </Hint>
            {layout && moments && <HistoryRuler ref={ruler} moments={moments} layout={layout} index={index} current={moments.current} lanes={lanes} trim={trim}
              disabled={busy || leaving || Boolean(exporting)} surface={controls} valueText={`${text.title}, ${text.detail}, ${timelineLabel}`}
              onSeek={(i, final) => seek(i, final ? 'step' : 'cut')} onTravel={travel} onTrim={(range, handle) => { setTrim(range); seek(handle === 'from' ? range.from : range.to, 'cut') }} />}
            {!trim && <Hint label="Choose a range to export as a video or cut from history">
              <Button variant="ghost" size="compact" className="history-trim" disabled={busy || path.length < 2} onClick={startTrim}>Trim</Button>
            </Hint>}
          </div>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
