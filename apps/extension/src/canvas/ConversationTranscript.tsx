import { memo, startTransition, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { ArrowDown, ArrowUpRight, CheckCircle, ChevronDown, ChevronRight, CircleAlert, CircleStop, ListChecks, LoaderCircle } from 'lucide-react'
import type { ConversationItem } from '@galta/domain'
import type { CreativeConversationTurn } from '@galta/storage'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Unfold } from '@/components/Unfold'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ArtifactDelivery, ConversationMessage, artifactReferences, type ArtifactDownload } from './ConversationMessage'
import { ConversationError } from './ConversationError'
import { ConversationQuestion } from './ConversationQuestion'
import { activityDetails, activityText, elapsedLabel, hasActivityDetails, WorkingDot } from './conversationActivity'
import { currentConversationItem, presentConversation, type ConversationTimelineEntry } from './conversationStore'
import type { PendingQuestion } from './ConversationDock'
import { RevealProvider, useReadingPosition, useReveal, type ReadingPosition, type TurnReadingState } from './readingPosition'
import { Locate } from './Locate'

const StatusTicker = memo(function StatusTicker({ label, active, announce = true }: { label: string; active: boolean; announce?: boolean }) {
  const [state, setState] = useState(() => ({ previous: label, current: label, revision: 0 }))
  useEffect(() => {
    setState(previous => previous.current === label
      ? previous
      : { previous: previous.current, current: label, revision: previous.revision + 1 })
  }, [label])
  const rolling = state.previous !== state.current
  return <span className="conversation-status-viewport conversation-status-change" data-active={active} aria-live={announce ? 'polite' : undefined} aria-atomic={announce ? 'true' : undefined}>
    <span key={state.revision} className="conversation-status-track" data-rolling={rolling} aria-hidden="true">
      <span className="conversation-status-line">{state.previous}</span>
      <span className={`conversation-status-line${active && !rolling ? ' conversation-text-shimmer' : ''}`}>{state.current}</span>
    </span>
    <span className="sr-only">{state.current}</span>
  </span>
})

const Activity = memo(function Activity({ item, running, stopped, activeItemId, reading, onArtifactDownload }: { item: ConversationItem; running: boolean; stopped: boolean; activeItemId?: string | undefined; reading: TurnReadingState; onArtifactDownload?: ArtifactDownload | undefined }) {
  const [open, setOpen] = useState(() => reading.activities.has(item.id))
  const root = useRef<HTMLDivElement>(null), reveal = useReveal()
  const active = running && item.status === 'inProgress' && item.id === activeItemId
  const label = activityText(item.status === 'inProgress' && item.id !== activeItemId && !stopped ? { ...item, status: 'completed' } : item, stopped)
  const toggle = (value: boolean) => {
    if (value) reading.activities.add(item.id)
    else reading.activities.delete(item.id)
    setOpen(value); reveal(root.current!, value)
  }
  // A step with nothing more to show is a line of the record, not a control:
  // it keeps the disclosure's column so its words align with its neighbours.
  if (!hasActivityDetails(item)) return <div ref={root} className="conversation-activity conversation-activity-line flex min-h-(--target-compact) items-center gap-2 py-1 text-xs text-muted-foreground">
    {active ? <WorkingDot /> : <span className="size-3 shrink-0" aria-hidden="true" />}
    <StatusTicker label={label} active={active} announce={false} />
    <Locate region={item.canvasChanges?.region} />
  </div>
  return <Collapsible ref={root} open={open} onOpenChange={toggle} className="conversation-activity text-xs text-muted-foreground">
    <CollapsibleTrigger asChild><Button variant="ghost" size="compact" className="group/activity h-auto min-h-(--target-compact) w-full justify-start gap-2 rounded-sm px-0 py-1 text-left whitespace-normal has-[>svg]:px-0 hover:bg-transparent">
      {active ? <WorkingDot /> : <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]/activity:rotate-90" aria-hidden="true" />}
      <StatusTicker label={label} active={active} announce={false} />
    </Button></CollapsibleTrigger>
    <Locate region={item.canvasChanges?.region} />
    <CollapsibleContent forceMount asChild><Unfold shown={open}><ActivityDetails item={item} running={active} onArtifactDownload={onArtifactDownload} /></Unfold></CollapsibleContent>
  </Collapsible>
})

/** Where Codex condensed the conversation so far to keep working within the
 * model's context. It marks a boundary in what the agent remembers rather than
 * a step of its work, so it is a quiet rule across the reading column at the
 * point it happened, named while it happens and once it has. */
function ContextBoundary({ item, active, stopped }: { item: ConversationItem; active: boolean; stopped: boolean }) {
  const label = activityText(item.status === 'inProgress' && !active && !stopped ? { ...item, status: 'completed' } : item, stopped)
  return <p className="conversation-boundary text-xs text-muted-foreground" data-active={active} data-item-id={item.id}>
    <span className={active ? 'conversation-text-shimmer' : undefined}>{label}</span>
  </p>
}

const ProcessMessage = memo(function ProcessMessage({ item, running, activeItemId, onArtifactDownload }: { item: ConversationItem; running: boolean; activeItemId?: string | undefined; onArtifactDownload?: ArtifactDownload | undefined }) {
  if (!item.text) return null
  return <div className="conversation-process-message conversation-commentary" data-message-id={item.id}>
    <ConversationMessage text={item.text} artifacts={item.artifacts} streaming={running && item.status === 'inProgress' && item.id === activeItemId} onArtifactDownload={onArtifactDownload} />
  </div>
})

const ProcessItems = memo(function ProcessItems({ items, running, stopped, activeItemId, reading, onArtifactDownload }: { items: ConversationItem[]; running: boolean; stopped: boolean; activeItemId?: string | undefined; reading: TurnReadingState; onArtifactDownload?: ArtifactDownload | undefined }) {
  return <div className="conversation-process-items">{items.map(item => item.type === 'agentMessage'
    ? <ProcessMessage key={item.id} item={item} running={running} activeItemId={activeItemId} onArtifactDownload={onArtifactDownload} />
    : <Activity key={item.id} item={item} running={running} stopped={stopped} activeItemId={activeItemId} reading={reading} onArtifactDownload={onArtifactDownload} />)}</div>
})

function ActivityDetails({ item, running, onArtifactDownload }: { item: ConversationItem; running: boolean; onArtifactDownload?: ArtifactDownload | undefined }) {
  // Bound the mounted output without truncating the stored receipt. More is
  // revealed explicitly, so a command finishing with megabytes cannot freeze input.
  const [limit, setLimit] = useState(16_000)
  const details = useMemo(() => activityDetails(item, limit), [item, limit])
  return <div className="conversation-activity-details">
    {item.type === 'reasoning' ? <div className="conversation-reasoning max-h-64 overflow-auto overscroll-contain"><ConversationMessage text={details.text} streaming={running && item.status === 'inProgress'} /></div>
      : <pre className="max-h-64 overflow-auto overscroll-contain font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">{details.text}</pre>}
    {details.length > limit && <Button type="button" variant="ghost" size="compact" onClick={() => setLimit(value => value + 16_000)}>Show more output</Button>}
  </div>
}

const ProcessBlock = memo(function ProcessBlock({ entry, running, stopped, activeItemId, duration, reading, onArtifactDownload }: { entry: Extract<ConversationTimelineEntry, { kind: 'process' }>; running: boolean; stopped: boolean; activeItemId?: string | undefined; duration: string; reading: TurnReadingState; onArtifactDownload?: ArtifactDownload | undefined }) {
  const [expanded, setExpanded] = useState(() => reading.processExpanded.has(entry.id))
  const root = useRef<HTMLDivElement>(null), reveal = useReveal()
  const statusId = useId()
  const active = Boolean(running && activeItemId && entry.items.some(item => item.id === activeItemId))
  const current = (activeItemId && entry.items.find(item => item.id === activeItemId)) ?? entry.items.at(-1)
  const displayCurrent = current && current.status === 'inProgress' && !active && !stopped ? { ...current, status: 'completed' } : current
  const label = displayCurrent ? activityText(displayCurrent, stopped) : running ? 'Thinking' : 'Work details'
  const operations = entry.items.filter(item => item.type !== 'agentMessage').length
  const setProcessExpanded = (value: boolean) => {
    if (value) reading.processExpanded.add(entry.id)
    else reading.processExpanded.delete(entry.id)
    setExpanded(value); reveal(root.current!, value)
  }
  const meta = <span className="conversation-process-meta">
    <StatusTicker label={label} active={active} />
    {operations > 0 && <span className="conversation-process-count shrink-0 tabular-nums">· {operations} {operations === 1 ? 'step' : 'steps'}</span>}
    {duration && <span className="conversation-process-count shrink-0 tabular-nums">· {duration}</span>}
  </span>
  // One step with nothing more to show would open onto its own name again, so
  // the segment is that line, not a disclosure.
  const single = entry.items.length === 1 ? entry.items[0]! : undefined
  if (single && single.type !== 'agentMessage' && !hasActivityDetails(single)) return <div ref={root} className="conversation-process conversation-process-line flex min-h-(--target-compact) items-center gap-2 text-xs text-muted-foreground" data-process-id={entry.id}>
    {active ? <WorkingDot /> : <span className="size-3 shrink-0" aria-hidden="true" />}
    {meta}
  </div>
  return <Collapsible ref={root} open={expanded} onOpenChange={setProcessExpanded} className="conversation-process" data-process-id={entry.id}>
    <CollapsibleTrigger asChild><Button variant="ghost" size="compact" className="conversation-process-trigger group/process h-auto min-h-(--target-compact) w-full max-w-full justify-start gap-2 px-0 text-left text-xs text-muted-foreground has-[>svg]:px-0 hover:bg-transparent" aria-label="Execution details" aria-describedby={statusId}>
      {active && !expanded ? <WorkingDot /> : <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]/process:rotate-90" aria-hidden="true" />}
      {meta}
      <span id={statusId} className="sr-only">{label}</span>
    </Button></CollapsibleTrigger>
    <CollapsibleContent forceMount asChild><Unfold shown={expanded}><ProcessItems items={entry.items} running={running} stopped={stopped} activeItemId={activeItemId} reading={reading} onArtifactDownload={onArtifactDownload} /></Unfold></CollapsibleContent>
  </Collapsible>
})

function UserMessage({ children, followup = false }: { children: ReactNode; followup?: boolean }) {
  return <div className={`conversation-user${followup ? ' conversation-followup' : ''}`}><span className="sr-only">You: </span>{children}</div>
}

const ConversationTurn = memo(function ConversationTurn({ turn, reading, onArtifactDownload }: { turn: CreativeConversationTurn; reading: TurnReadingState; onArtifactDownload?: ArtifactDownload | undefined }) {
  const { process, replies, attention, timeline } = useMemo(() => presentConversation(turn), [turn])
  const artifacts = useMemo(() => {
    const found = new Map<string, NonNullable<ConversationItem['artifacts']>[number]>()
    for (const item of replies) for (const artifact of item.artifacts ?? []) {
      const key = artifact.status === 'ready' ? artifact.receipt.receiptId : artifact.href
      if (key && !found.has(key)) found.set(key, artifact)
    }
    const replyText = replies.map(reply => reply.text).join('\n')
    return [...found.values()].filter(artifact => artifact.status === 'failed' || !artifactReferences(artifact).some(reference => replyText.includes(reference)))
  }, [replies, turn.items])
  const running = turn.status === 'streaming' || turn.status === 'preparing'
  const stopped = !running && turn.status !== 'completed'
  const activeItemId = currentConversationItem(turn.items, running)?.id
  const finalAnswerPending = running && turn.items.some(item => item.type === 'agentMessage' && item.phase === 'final_answer' && item.status === 'inProgress' && !item.text)
  const duration = turn.completedAt ? elapsedLabel(turn.startedAt, turn.completedAt) : ''
  const processEntries = timeline.filter((entry): entry is Extract<ConversationTimelineEntry, { kind: 'process' }> => entry.kind === 'process')
  const lastProcessId = processEntries.at(-1)?.id
  // A boundary being drawn already says the agent is busy.
  const condensing = timeline.some(entry => entry.kind === 'boundary' && entry.item.id === activeItemId)
  return <article className="conversation-turn scroll-mt-4 outline-none" data-turn-id={turn.id} tabIndex={-1} aria-label={turn.instruction}>
    <UserMessage>{turn.instruction}</UserMessage>
    {timeline.map(entry => {
      if (entry.kind === 'process') return <ProcessBlock key={entry.id} entry={entry} running={running} stopped={stopped} activeItemId={activeItemId} duration={entry.id === lastProcessId ? duration : ''} reading={reading} onArtifactDownload={onArtifactDownload} />
      if (entry.kind === 'user') return <UserMessage key={entry.message.id} followup>{entry.message.text}</UserMessage>
      if (entry.kind === 'error') return <ConversationError key={entry.item.id} text={entry.item.text} announce={turn.status === 'failed'} />
      if (entry.kind === 'boundary') return <ContextBoundary key={entry.item.id} item={entry.item} active={entry.item.id === activeItemId} stopped={stopped} />
      const item = entry.item
      if (!item.text) return null
      return <div key={item.id} className="conversation-reply outline-none" data-message-id={item.id} data-reply="final" tabIndex={-1} aria-label="Galta response">
        <ConversationMessage text={item.text} artifacts={item.artifacts} streaming={running && item.status === 'inProgress' && item.id === activeItemId} onArtifactDownload={onArtifactDownload} />
      </div>
    })}
    {running && !condensing && !timeline.some(entry => entry.kind === 'reply' && entry.item.text) && (!process.length || finalAnswerPending) && <div className="conversation-working mt-3 flex items-center gap-2 text-xs text-muted-foreground" role="status"><WorkingDot /><span className="conversation-text-shimmer">{finalAnswerPending ? 'Writing a response' : 'Thinking'}</span></div>}
    <ArtifactDelivery artifacts={artifacts} onDownload={onArtifactDownload} />
    {turn.status === 'stopped' && <p className="conversation-status mt-3 text-xs text-muted-foreground">Stopped{!replies.length ? ' · No final response' : ''}</p>}
    {turn.status === 'failed' && !attention.length && <p className="conversation-status mt-3 text-sm text-destructive">This request could not be completed.</p>}
  </article>
})

function RequestIndex({ turns, onJump }: { turns: readonly CreativeConversationTurn[]; onJump(id: string, reply: boolean): void }) {
  const [query, setQuery] = useState('')
  const matches = turns.map((turn, i) => ({ turn, number: i + 1 })).filter(({ turn }) => turn.instruction.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const statusLabel = (turn: CreativeConversationTurn) => turn.status === 'streaming' || turn.status === 'preparing' ? 'Working' : turn.status === 'failed' ? 'Needs attention' : turn.status === 'stopped' ? 'Stopped' : 'Complete'
  const statusIcon = (turn: CreativeConversationTurn) => turn.status === 'streaming' || turn.status === 'preparing'
    ? <LoaderCircle className="request-index-status-icon motion-safe:animate-spin" aria-hidden="true" />
    : turn.status === 'failed'
      ? <CircleAlert className="request-index-status-icon text-destructive" aria-hidden="true" />
      : turn.status === 'stopped'
        ? <CircleStop className="request-index-status-icon" aria-hidden="true" />
        : <CheckCircle className="request-index-status-icon" aria-hidden="true" />
  return <>
    <div className="request-index-heading"><span>Requests</span><span className="request-index-count">{turns.length}</span></div>
    <Input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a request…" aria-label="Find a request" className="request-index-search mb-2" />
    <ol aria-label="Requests in this conversation" className="request-index-list m-0 max-h-72 list-none overflow-auto overscroll-contain p-0">
      {matches.map(({ turn, number }) => <li key={turn.id} className="request-index-row flex items-center gap-1">
        <Button variant="ghost" size="compact" className="request-index-trigger h-auto min-w-0 flex-1 justify-start gap-2 py-2 text-left" onClick={() => onJump(turn.id, false)}><span className="request-index-number shrink-0 text-xs text-muted-foreground tabular-nums">{String(number).padStart(2, '0')}</span><span className="request-index-copy min-w-0"><span className="request-index-prompt line-clamp-2 whitespace-normal wrap-anywhere">{turn.instruction}</span><span className="request-index-status">{statusIcon(turn)}<span>{statusLabel(turn)}</span></span></span></Button>
        {turn.items.some(item => item.type === 'agentMessage' && item.phase === 'final_answer' && item.text) && <Button variant="ghost" size="icon-compact" aria-label={`Jump to response ${number}`} title="Jump to response" onClick={() => onJump(turn.id, true)}><ArrowUpRight className="size-4" /></Button>}
      </li>)}
      {!matches.length && <li className="px-2 py-4 text-sm text-muted-foreground">No matching requests</li>}
    </ol></>
}

// Mounting a long history is the cost of opening the sheet, paid before its
// first frame. The reader arrives at the latest, so a long history opens with
// its last turns, enough to fill the sheet, and brings the rest in behind them
// once the sheet has opened. What counts is height, not turns: a window too
// short for the sheet would make the sheet grow after it opened. The sheet is at
// most 720 px, and a turn's height is guessed from its words and low on purpose,
// so a guess of 800 px fills it; a window that is too long only costs a little.
// A history that would leave little behind opens whole.
const OPENING_HEIGHT = 800, GUESS_BASE = 72, GUESS_LINE = 22, GUESS_LINE_CHARS = 64
function guessHeight(turn: CreativeConversationTurn) {
  const characters = turn.items.reduce((sum, item) => sum + (item.type === 'agentMessage' ? item.text.length : 0), turn.instruction.length)
  return GUESS_BASE + Math.ceil(characters / GUESS_LINE_CHARS) * GUESS_LINE
}
function openingStart(reading: ReadingPosition, sessionId: string | undefined, turns: readonly CreativeConversationTurn[]) {
  const following = reading.sessionId !== sessionId || reading.following
  if (!following || turns.reduce((sum, turn) => sum + guessHeight(turn), 0) < OPENING_HEIGHT * 2) return 0
  let height = 0, start = turns.length
  while (start > 0 && height < OPENING_HEIGHT) height += guessHeight(turns[--start]!)
  return start
}

type Props = { id: string; sessionId?: string | undefined; turns: readonly CreativeConversationTurn[]; actions?: ReactNode; title?: string | undefined; question: PendingQuestion | null; error: string; reading: MutableRefObject<ReadingPosition>; onCollapse?: () => void; onArtifactDownload?: ArtifactDownload | undefined }
export const ConversationTranscript = memo(function ConversationTranscript({ id, sessionId, turns, actions, title, question, error, reading, onCollapse, onArtifactDownload }: Props) {
  const position = useReadingPosition(reading, sessionId)
  const { scroll, content, goTo, markAnchor, keepAnchor } = position
  const [indexOpen, setIndexOpen] = useState(false)
  // The first turn mounted; the turns before it are brought in by `earlier`.
  const [mounted, setMounted] = useState(() => ({ sessionId, from: openingStart(reading.current, sessionId, turns) }))
  if (mounted.sessionId !== sessionId) setMounted({ sessionId, from: openingStart(reading.current, sessionId, turns) })
  const from = Math.min(mounted.from, turns.length)
  const bringing = useRef(false)
  const earlier = useCallback((count: number, urgent: boolean) => {
    if (bringing.current) return
    bringing.current = true
    markAnchor(content.current?.querySelector<HTMLElement>('[data-turn-id]') ?? null)
    const bring = () => setMounted(current => ({ ...current, from: Math.max(0, current.from - count) }))
    if (urgent) flushSync(bring)
    else startTransition(bring)
  }, [markAnchor, content])
  useLayoutEffect(() => { keepAnchor(); bringing.current = false }, [from, keepAnchor])
  // Idle time, one turn at a time and not while the sheet is still moving, so
  // the history arrives without costing a frame.
  useEffect(() => {
    if (from <= 0) return
    let idle = 0, cancelled = false
    const step = () => { if (!cancelled) earlier(1, false) }
    const moving = scroll.current?.closest('.conversation-presence')?.getAnimations().filter(animation => animation.id !== 'unfold-contents') ?? []
    if (moving.length) void Promise.allSettled(moving.map(animation => animation.finished)).then(() => { if (!cancelled) idle = requestIdleCallback(step, { timeout: 800 }) })
    else idle = requestIdleCallback(step, { timeout: 800 })
    return () => { cancelled = true; cancelIdleCallback(idle) }
  }, [from, earlier, scroll])
  const jumpTarget = useRef<{ id: string; reply: boolean } | null>(null)
  const jump = useCallback(() => {
    const target = jumpTarget.current
    if (!target) return
    // The turn may be one not yet brought in: bring them all, and finish once they are mounted.
    if (from > 0) { setMounted(current => ({ ...current, from: 0 })); return }
    jumpTarget.current = null
    const turn = scroll.current!.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(target.id)}"]`)
    const anchor = target.reply ? turn?.querySelector<HTMLElement>('[data-reply=final]') : turn
    if (anchor) goTo(anchor)
  }, [from, scroll, goTo])
  useLayoutEffect(() => { if (from === 0) jump() }, [from, jump])
  return <div id={id} className="conversation-sheet flex min-h-0 max-h-[min(72dvh,720px)] flex-[0_1_auto] flex-col overflow-hidden">
    <header className="conversation-header flex shrink-0 items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground" role="toolbar" aria-label="Conversation controls"><div className="conversation-header-primary min-w-0 flex-1">{actions ?? title ?? 'Conversation'}</div>
      <div className="conversation-header-actions flex shrink-0 items-center gap-1">
      {turns.length > 0 && <Popover open={indexOpen} onOpenChange={setIndexOpen}><PopoverTrigger asChild><Button variant="ghost" size="compact" className="conversation-requests shrink-0 gap-1.5" aria-label="Browse requests" title="Browse requests"><ListChecks className="size-3.5" /><span className="request-label">Requests</span><span className="request-count" aria-hidden="true">{turns.length}</span></Button></PopoverTrigger>
        <PopoverContent align="end" side="top" className="request-index-popover w-80 max-w-[calc(100vw-32px)] p-2" aria-label="Browse requests" onCloseAutoFocus={event => { if (jumpTarget.current) { event.preventDefault(); jump() } }}>
          {indexOpen && <RequestIndex turns={turns} onJump={(id, reply) => { jumpTarget.current = { id, reply }; setIndexOpen(false); jump() }} />}
        </PopoverContent></Popover>}
      {onCollapse && <Button type="button" variant="ghost" size="icon-compact" className="conversation-collapse" aria-label="Collapse conversation" title="Collapse conversation" onClick={onCollapse}><ChevronDown className="size-4" /></Button>}
      </div>
    </header>
    <div className="relative flex min-h-0 flex-col">
      <div ref={position.scroll} tabIndex={-1} className="conversation-scroll min-h-0 overflow-auto overscroll-contain outline-none [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin]" {...position.scrollProps}
        onScroll={() => {
          position.scrollProps.onScroll()
          // A reader who reaches the top of what is mounted must not meet its edge.
          const element = scroll.current!
          if (from > 0 && !reading.current.following && element.scrollTop < element.clientHeight) earlier(2, true)
        }}>
        <RevealProvider value={position.reveal}><div ref={position.content}>
          {!turns.length && !error && <p className="conversation-empty text-sm leading-relaxed text-muted-foreground">No messages yet</p>}
          {turns.slice(from).map(turn => {
            let opened = reading.current.turns.get(turn.id)
            if (!opened) { opened = { activities: new Set(), processExpanded: new Set() }; reading.current.turns.set(turn.id, opened) }
            return <ConversationTurn key={`${sessionId ?? 'conversation'}:${turn.id}`} turn={turn} reading={opened} onArtifactDownload={onArtifactDownload} />
          })}
          {question && <ConversationQuestion key={String(question.params.itemId ?? question.method)} question={question} />}
          {error && <ConversationError text={error} announce />}
        </div></RevealProvider>
      </div>
      <Button type="button" variant="secondary" size="icon-compact" className="conversation-jump-latest rounded-full" data-visible={position.behind} inert={!position.behind} aria-hidden={!position.behind} aria-label={question ? 'Your input is needed' : 'Back to latest'} title={question ? 'Your input is needed' : 'Back to latest'} onClick={() => { position.scroll.current?.focus({ preventScroll: true }); position.returnToLatest() }}><ArrowDown className="size-4" aria-hidden="true" /></Button>
    </div>
  </div>
})
