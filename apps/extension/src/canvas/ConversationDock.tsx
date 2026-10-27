import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { AgentRunState, ContextPressure } from '@galta/runtime'
import type { CreativeConversationTurn } from '@galta/storage'
import type { CanvasChangeRegion } from '@galta/domain'
import { cn } from '@/lib/utils'
import { composerReachesCorner } from './useCanvasInsets'
import { Unfold } from '@/components/Unfold'
import { ConversationComposer } from './ConversationComposer'
import { DockSurface } from './DockSurface'
import { lastRegion, narration } from './narration'
import { LocatorContext, type CanvasLocator, type Locating } from './agentFocus'
import { ConversationTranscript } from './ConversationTranscript'
import type { ReadingPosition } from './readingPosition'
import type { ArtifactDownload } from './ConversationMessage'
import { activityText } from './conversationActivity'
import { ConversationStore, currentConversationItem, shareConversationHistory, type DraftCommand } from './conversationStore'
import type { TaskState } from '../tasks/protocol'
import './conversation.css'

export { isExternalConversationLink } from './ConversationMessage'
export type PendingQuestion = { method: string; params: Record<string, unknown>; answer: (value: unknown) => void }
export type ConversationDockProps = {
  /** The selected run's live task, when it exists. Its capability flags are the
   * only honest source for what the composer may offer. */
  task?: TaskState | undefined
  external?: boolean
  connection?: { label: string; onSetup(): void } | undefined
  turns: readonly CreativeConversationTurn[]; conversation: ConversationStore
  state: AgentRunState; error: string; question: PendingQuestion | null
  command: DraftCommand; onSubmit(): void | Promise<void>; onStop(): void
  open: boolean; onOpen(open: boolean): void; preview: boolean
  context?: ReactNode; runtime?: ReactNode; actions?: ReactNode; disabled?: boolean; title?: string
  /** The editor may accept a draft before the task host has finished opening;
   * this gate belongs to the send action, not to the text field. */
  submitReady?: boolean
  sessionId?: string; focusRequest?: number; activity?: string | undefined
  /** Active sessions outside the selected conversation, surfaced while the dock is collapsed. */
  activeSessionCount?: number
  pressure?: ContextPressure | null
  onArtifactDownload?: ArtifactDownload | undefined
  /** The canvas view's locator; absent where no canvas is mounted. */
  locator?: CanvasLocator | null | undefined
}
export function ConversationDock(props: ConversationDockProps) {
  const { state, turns, conversation, question, actions, ...composerProps } = props
  const { open } = props
  const observed = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot)
  const liveTurn = props.external ? null : observed
  const busy = state === 'preparing' || state === 'streaming'
  const canSteer = Boolean(props.task?.canSteer)
  const connectionOnly = Boolean(props.connection && !busy)
  const compact = connectionOnly || Boolean(props.external)
  // Cross-window snapshots arrive as fresh arrays. Share unchanged turn and
  // item identities before memoized transcript rows see them, without causing
  // a render-phase state update or a second render for every transport tick.
  const history = useRef<{ input: readonly CreativeConversationTurn[]; value: readonly CreativeConversationTurn[] }>({ input: turns, value: turns })
  const stableHistory = useMemo(() => {
    if (turns === history.current.input) return history.current.value
    const value = shareConversationHistory(history.current.value, turns)
    history.current = { input: turns, value }
    return value
  }, [turns])
  const allTurns = useMemo(() => liveTurn ? [...stableHistory.filter(turn => turn.id !== liveTurn.id), liveTurn] : stableHistory, [stableHistory, liveTurn])
  const latest = allTurns.at(-1)
  const standaloneError = props.error && !latest?.items.some(item => item.type === 'error' && item.text === props.error) ? props.error : ''
  const resultVersion = latest ? `${latest.id}:${latest.status}:${latest.items.length}` : ''
  const seenResult = useRef(resultVersion)
  const unread = Boolean(!open && !busy && resultVersion && seenResult.current !== resultVersion)
  useEffect(() => { if (open) seenResult.current = resultVersion }, [open, resultVersion])
  const reading = useRef<ReadingPosition>({ sessionId: props.sessionId, top: 0, following: true, turns: new Map() })
  // The provider's last item is the only reliable cursor for the collapsed
  // status line. Looking for any in-progress tool can surface stale work after
  // the final answer has already started streaming.
  const latestActivity = liveTurn ? currentConversationItem(liveTurn.items, busy) : undefined
  const activityLabel = props.activity ?? (question ? 'Your input is needed' : latestActivity
    ? latestActivity.type === 'agentMessage' && latestActivity.phase === 'final_answer' ? 'Writing a response' : activityText(latestActivity)
    : 'Thinking')
  const ratio = props.pressure ? props.pressure.tokens / props.pressure.window : 0
  const contextLabel = props.pressure && ratio >= 0.6 ? `${Math.round(ratio * 100)}%` : ''
  const sheetId = useId()
  const dock = useRef<HTMLElement>(null), composer = useRef<HTMLFormElement>(null)
  const [dockShift, setDockShift] = useState(0), [moveLimit, setMoveLimit] = useState(0), [dragging, setDragging] = useState(false)
  const dragStart = useRef<{ x: number; shift: number } | null>(null)
  // Submitting is what makes a request exist, so the dock reveals it here rather
  // than leaving each host to remember. The composer owns the gesture, the dock
  // owns the transition, and neither restates the duty of the other.
  const submit = useCallback(() => { if (!compact) props.onOpen(true); return props.onSubmit() }, [compact, props.onOpen, props.onSubmit])
  useEffect(() => {
    const workspace = dock.current!.parentElement!
    const measure = () => {
      // Sliding keeps a 20 px margin, or clears the settings corner where it
      // shares the composer's line. One limit serves both directions.
      const area = workspace.getBoundingClientRect(), width = dock.current!.getBoundingClientRect().width
      // The shell publishes the corner's edge; the dock never inspects the corner.
      const edge = Number.parseFloat(getComputedStyle(workspace).getPropertyValue('--corner-edge')) || 0
      const margin = edge && !composerReachesCorner(area.width, width, edge) ? Math.max(20, edge) : 20
      const limit = Math.max(0, (area.width - width) / 2 - margin)
      setMoveLimit(limit); setDockShift(value => Math.max(-limit, Math.min(limit, value)))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(dock.current!); observer.observe(workspace); measure()
    return () => observer.disconnect()
  }, [])
  const onDragStart = useCallback((event: PointerEvent<HTMLDivElement>) => {
    setDragging(true)
    dragStart.current = { x: event.clientX, shift: dockShift }; event.currentTarget.setPointerCapture(event.pointerId)
  }, [dockShift])
  const onDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (dragStart.current) setDockShift(Math.max(-moveLimit, Math.min(moveLimit, dragStart.current.shift + event.clientX - dragStart.current.x)))
  }, [moveLimit])
  const onDragEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    dragStart.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }, [])
  const onMoveKey = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      setDockShift(current => Math.max(-moveLimit, Math.min(moveLimit, current + direction * (event.shiftKey ? 80 : 24))))
    }
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setDockShift(event.key === 'Home' ? -moveLimit : moveLimit) }
  }, [moveLimit])
  const collapse = useCallback(() => {
    props.onOpen(false)
    // The composer remains mounted while the reading surface closes, so focus
    // can move synchronously without racing the next user interaction.
    dock.current?.querySelector<HTMLButtonElement>('.composer-conversation')?.focus()
  }, [props.onOpen])
  // Showing a change means going to the canvas: the reading surface settles
  // out of the way while the camera travels.
  const { locator } = props
  const locating = useMemo<Locating | null>(() => locator ? { locator, locate: region => { if (open) collapse(); void locator.locate(region) } } : null, [locator, open, collapse])
  // A change that lands where the reader is looking is lit in place; one that
  // lands out of view is left to the composer's arrow. The camera never moves.
  const landed = busy ? lastRegion(liveTurn) : undefined, lit = useRef<CanvasChangeRegion | undefined>(undefined)
  useEffect(() => {
    if (!landed || !locator || landed === lit.current) return
    lit.current = landed
    if (locator.bearing(landed) === null) locator.mark(landed)
  }, [landed, locator])
  // The closed composer speaks for the agent: the sentence it is on while it
  // works, the opening of its answer until that is read, and where it last
  // changed the canvas.
  const spoken = busy ? liveTurn : unread ? latest : undefined
  const said = useMemo(() => narration(spoken, !busy), [spoken, busy])
  return <LocatorContext.Provider value={locating}><section ref={dock} className={cn('conversation-dock group/dock absolute bottom-(--composer-bottom) left-1/2 z-(--layer-conversation) flex max-h-[calc(100%_-_var(--header-height,80px)_-_12px)] w-(--composer-width) max-w-[calc(100%_-_180px)] flex-col text-foreground @max-[620px]:max-w-[calc(100%_-_40px)]', open && !compact && 'is-open', busy && 'is-working', dragging && 'is-dragging', compact && 'connection-only')} style={{ transform: `translateX(calc(-50% + ${compact ? 0 : dockShift}px))` }} data-open={open && !compact} data-working={busy} data-dragging={dragging || undefined} aria-label={props.external ? 'Agent activity' : connectionOnly ? 'Connect an agent' : 'Agent conversation'}>
    <Unfold shown={open && !compact} className="conversation-presence flex min-h-0 flex-[0_1_auto] flex-col">
      <ConversationTranscript id={sheetId} sessionId={props.sessionId} turns={allTurns} actions={actions} title={props.title} question={question} error={standaloneError} reading={reading} onCollapse={collapse} onArtifactDownload={props.onArtifactDownload} />
    </Unfold>
    {/* A compact dock is a single line, not a collapsed reading surface: it must
        not reserve the transcript's column or intrinsic width, which would
        otherwise leave the activity line with no room to be read. */}
    <ConversationComposer {...composerProps} onSubmit={submit} state={state} busy={busy} canSteer={canSteer} compact={compact} connectionOnly={connectionOnly} sheetId={sheetId} unread={unread} activityLabel={activityLabel} contextLabel={contextLabel} startedAt={liveTurn?.startedAt} dockShift={dockShift} moveLimit={moveLimit} onDragStart={onDragStart} onDrag={onDrag} onDragEnd={onDragEnd} onMoveKey={onMoveKey} formRef={composer} narration={said?.text} narrationKey={said?.key} region={lastRegion(spoken)} />
    <DockSurface composer={composer} working={busy} />
  </section></LocatorContext.Provider>
}
