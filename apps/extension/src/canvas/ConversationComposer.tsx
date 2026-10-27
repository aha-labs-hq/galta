import { memo, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEventHandler, type PointerEventHandler, type Ref } from 'react'
import { ArrowUpRight, Square, ChevronDown, MessageSquare, CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { conversationError } from './ConversationError'
import { WorkingDot, elapsedLabel } from './conversationActivity'
import { usePacedText } from './ConversationMessage'
import { Locate } from './Locate'
import type { CanvasChangeRegion } from '@galta/domain'
import type { ConversationDockProps } from './ConversationDock'

function Elapsed({ startedAt }: { startedAt?: number | undefined }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let timer: number | undefined
    const change = () => {
      clearInterval(timer)
      if (document.visibilityState !== 'hidden') { setNow(Date.now()); timer = window.setInterval(() => setNow(Date.now()), 1000) }
    }
    change(); document.addEventListener('visibilitychange', change)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', change) }
  }, [startedAt])
  return <time className="shrink-0 tabular-nums">{elapsedLabel(startedAt, now)}</time>
}

/** A sentence arriving at the transport's pace, revealed at a reading pace. */
function PacedText({ text }: { text: string }) { return usePacedText(text) }

type Props = Omit<ConversationDockProps, 'conversation' | 'turns' | 'question' | 'actions'> & {
  busy: boolean; canSteer: boolean; compact: boolean; connectionOnly: boolean; sheetId: string; unread: boolean
  activityLabel: string; contextLabel: string; startedAt?: number | undefined; dockShift: number; moveLimit: number
  onDragStart: PointerEventHandler<HTMLDivElement>; onDrag: PointerEventHandler<HTMLDivElement>
  onDragEnd: PointerEventHandler<HTMLDivElement>; onMoveKey: KeyboardEventHandler<HTMLDivElement>
  /** The dock paints this form's silhouette and measures it. */
  formRef: Ref<HTMLFormElement>
  /** What the agent is saying, one sentence at a time, and the key of that
   * sentence; it replaces tool names in the closed footer. */
  narration?: string | undefined; narrationKey?: string | undefined
  /** Where the agent last changed the canvas. */
  region?: CanvasChangeRegion | undefined
}
export const ConversationComposer = memo(function ConversationComposer(props: Props) {
  const { state, busy, canSteer, compact, connectionOnly, open, onOpen, sheetId, unread, activityLabel, contextLabel, dockShift, moveLimit } = props
  const command = useSyncExternalStore(props.command.subscribe, props.command.getSnapshot)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const connectionButton = useRef<HTMLButtonElement>(null)
  const dragHintTimer = useRef<number | undefined>(undefined)
  const [dragHintOpen, setDragHintOpen] = useState(false)
  const pendingSends = useRef(new Set<string | undefined>())
  const [, updateSending] = useState(0)
  const sending = pendingSends.current.has(props.sessionId)
  const hasCommand = Boolean(command.trim())
  // A follow-up reaches the turn only once the provider reports its boundary.
  // Until then the one honest action is Stop, which the footer already owns.
  const stopAction = busy && !hasCommand
  const canSend = !props.disabled && props.submitReady !== false && hasCommand && (!busy || canSteer) && !sending
  const otherActiveCount = Math.max(0, (props.activeSessionCount ?? 0) - (busy ? 1 : 0))
  // Closed, the footer speaks for the agent while it works and until its answer
  // is read; tool names stand in only before it has said anything.
  const narrating = !open && (busy || unread) && Boolean(props.narration)
  const footerLabel = narrating ? props.narration! : busy && !open ? activityLabel : props.title ?? 'Conversation'
  const actionLabel = stopAction ? 'Stop generation' : 'Send message'
  const actionHint = stopAction ? 'Stop generation' : sending ? 'Sending…' : props.submitReady === false || busy && !canSteer ? 'Getting ready…' : 'Send message'
  const submit = async () => {
    const sessionId = props.sessionId
    if (!canSend || pendingSends.current.has(sessionId)) return
    pendingSends.current.add(sessionId); updateSending(value => value + 1)
    try { await props.onSubmit() }
    finally { pendingSends.current.delete(sessionId); updateSending(value => value + 1) }
  }
  const showDragHint = () => {
    window.clearTimeout(dragHintTimer.current)
    dragHintTimer.current = window.setTimeout(() => setDragHintOpen(true), 350)
  }
  const hideDragHint = () => {
    window.clearTimeout(dragHintTimer.current)
    dragHintTimer.current = undefined
    setDragHintOpen(false)
  }
  useEffect(() => {
    // A connection dialog can close before the background task host reports
    // ready. Keep the request latched until the textarea becomes focusable;
    // otherwise the newly visible composer is left inert after sign-in.
    if (props.focusRequest && !props.disabled) (connectionOnly ? connectionButton.current : textarea.current)?.focus()
  }, [props.focusRequest, props.disabled, connectionOnly])
  useEffect(() => () => window.clearTimeout(dragHintTimer.current), [])
  return (
    <form ref={props.formRef} className={cn('conversation-composer relative isolate shrink-0 pb-[max(4px,env(safe-area-inset-bottom))] text-foreground', compact ? 'px-1 pt-1' : 'px-3 pt-3')} data-theme="graphite" onSubmit={event => { event.preventDefault(); void submit() }}>
      {/* Sliding the composer is a capability of the surface, not a control in the
          footer: keep one quiet, centered grip on the top edge. A compact dock is
          a single line, so it has no edge to drag. */}
      {!compact && <Tooltip open={dragHintOpen}><TooltipTrigger asChild><div className="composer-resize-handle" role="slider" tabIndex={0} aria-label="Move composer" aria-orientation="horizontal" aria-valuemin={-moveLimit} aria-valuemax={moveLimit} aria-valuenow={dockShift} onPointerEnter={showDragHint} onPointerLeave={hideDragHint} onPointerDown={props.onDragStart} onPointerMove={props.onDrag} onPointerUp={props.onDragEnd} onPointerCancel={props.onDragEnd} onKeyDown={props.onMoveKey}><span className="composer-resize-glyph" aria-hidden="true" /></div></TooltipTrigger><TooltipContent side="top" sideOffset={6}>Drag to move composer</TooltipContent></Tooltip>}
      {props.external ? <div className="external-agent-activity"><span role="status"><WorkingDot />{activityLabel}</span><Button type="button" variant="ghost" size="icon-compact" onClick={props.onStop} aria-label="Stop agent"><Square className="size-3 fill-current" /></Button></div> : connectionOnly ? <Button ref={connectionButton} type="button" variant="ghost" className="composer-enable" onClick={props.connection!.onSetup}>{props.connection!.label}<ArrowUpRight aria-hidden="true" /></Button> : <>
      {props.context}
      <div className="composer-input-row flex min-h-8 items-center px-2">
      <Textarea className="composer-input field-sizing-content min-h-6 max-h-30 min-w-0 flex-1 resize-none self-center rounded-none border-0 bg-transparent px-0 py-0.5 text-[16px] leading-6 shadow-none outline-none md:text-[16px]" ref={textarea} rows={1} disabled={props.disabled} value={command} onChange={event => props.command.set(event.target.value)} placeholder={props.connection ? 'Start with an idea…' : props.preview ? 'Ask Galta from this point…' : 'Ask Galta…'} aria-label="Ask Galta" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} />
      </div>
      <div className="composer-footer flex min-h-(--target) items-center gap-1">
        <div className="composer-conversation-slot min-w-0">
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="compact" className={cn('composer-conversation min-w-0 flex-initial justify-start gap-2 text-muted-foreground aria-expanded:text-foreground', busy && 'composer-progress')} type="button" onClick={() => onOpen(!open)} aria-label={open ? 'Conversation open' : busy ? 'Show task progress' : 'Open conversation'} aria-expanded={open} aria-controls={sheetId} data-unread={unread} title={props.title}>
            {busy ? <WorkingDot /> : state === 'failed' ? <CircleAlert className="size-3.5 text-destructive" /> : <MessageSquare className="size-3.5 @max-[620px]:hidden" />}<span key={narrating ? props.narrationKey : footerLabel} data-narration={narrating || undefined} className={cn('conversation-title conversation-status-change truncate', (busy || narrating) && !open && 'conversation-text-shimmer')}>{narrating ? <PacedText text={footerLabel} /> : footerLabel}</span>{!open && otherActiveCount > 0 && <span className="composer-active-summary session-count shrink-0"><span className="working-dot size-1.5" aria-hidden="true" />{otherActiveCount} working</span>}{unread && <span className="size-1 shrink-0 rounded-full bg-foreground" />}{busy && !open && <Elapsed startedAt={props.startedAt} />}<ChevronDown className={cn('size-3 transition-transform', !open && 'rotate-180')} />
          </Button></TooltipTrigger><TooltipContent side="top">{open ? 'Collapse conversation' : busy ? footerLabel : state === 'failed' ? 'View task error' : unread ? 'View new reply' : 'Open conversation'}</TooltipContent></Tooltip>
          {!open && <Locate region={props.region} away />}
          {!open && state === 'failed' && <span className="sr-only" role="alert">{conversationError(props.error).message}</span>}
        </div>
        <div className="composer-footer-actions flex min-w-0 items-center gap-1">
          {contextLabel && <Tooltip><TooltipTrigger asChild><span className="shrink-0 tabular-nums text-xs text-muted-foreground" role="status">{contextLabel}</span></TooltipTrigger><TooltipContent>{`${contextLabel} context used`}</TooltipContent></Tooltip>}
          {props.runtime}
          {busy && hasCommand && <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-compact" className="composer-stop shrink-0 text-muted-foreground" aria-label="Stop generation" onClick={props.onStop}><Square className="size-3 fill-current" /></Button></TooltipTrigger><TooltipContent>Stop generation</TooltipContent></Tooltip>}
          {(!props.connection || busy) && <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="composer-submit group/submit p-0 text-surface hover:bg-transparent hover:text-surface disabled:text-muted-foreground disabled:opacity-100" type={stopAction ? 'button' : 'submit'} disabled={!stopAction && !canSend} aria-busy={sending} onClick={stopAction ? event => { event.preventDefault(); props.onStop() } : undefined} aria-label={actionLabel} data-action={stopAction ? 'stop' : 'send'}>
            <span className="composer-submit-face grid size-7 place-items-center rounded-md bg-foreground group-hover/submit:bg-foreground/90 group-disabled/submit:bg-transparent">
              <svg className="composer-send-glyph size-4 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path /></svg>
            </span>
          </Button></TooltipTrigger><TooltipContent>{actionHint}</TooltipContent></Tooltip>}
        </div>
      </div>
      </>}
    </form>
  )
})
