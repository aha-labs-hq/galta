import { useEffect, useRef, useState } from 'react'
import { Play, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { RecordingResult } from './CanvasRecording'
import type { useRecording } from './useRecording'
import { readSubmittedRecording } from '../canvas/messageDrafts'
import { recordingPlayback } from './playback'
import './recording.css'

type Controller = ReturnType<typeof useRecording>
const time = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

// Tooltips can receive Escape before the document shortcut. Both paths cancel
// the live take; an already retained draft is never removed by Escape.
function cancelCapture(controller: Controller, event: KeyboardEvent) {
  if (!controller.capturing) return
  event.preventDefault(); event.stopPropagation(); controller.cancel()
}

/** Only the clock subscribes to elapsed time; the canvas never renders on a tick. */
function RecordingTime({ controller, draft }: { controller: Controller; draft: RecordingResult | null }) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const update = () => setSeconds(Math.floor(controller.elapsed()))
    update()
    if (!controller.active) return
    const timer = window.setInterval(update, 250)
    return () => clearInterval(timer)
  }, [controller.active, controller.elapsed])
  return <time data-composer-motion="clock" aria-label={controller.capturing ? 'Recording duration' : 'Recorded duration'}>{time(draft?.packet.duration ?? seconds)}</time>
}

export function RecordingControl({ controller, attached, disabled, onStart }: { controller: Controller; attached: boolean; disabled: boolean; onStart(): void }) {
  const host = useRef<HTMLDivElement>(null)
  const current = useRef({ controller, attached, disabled, onStart }); current.current = { controller, attached, disabled, onStart }
  useEffect(() => {
    if (controller.active && (document.activeElement === document.body || host.current?.contains(document.activeElement))) host.current?.querySelector<HTMLButtonElement>('.recording-primary')?.focus({ preventScroll: true })
  }, [controller.active])
  useEffect(() => {
    let enterHeld = false
    const releaseEnter = () => { enterHeld = false }
    const keyUp = (event: KeyboardEvent) => { if (event.key === 'Enter') releaseEnter() }
    const key = (event: KeyboardEvent) => {
      const { controller, attached, disabled, onStart } = current.current
      // The composer regains focus after Stop. A held Enter must not then send
      // the retained take through a repeated keydown on the restored textarea.
      if (event.key === 'Enter' && enterHeld) { event.preventDefault(); event.stopPropagation(); return }
      if (event.defaultPrevented || event.repeat || event.isComposing || document.querySelector('[role="dialog"], [role="menu"], [data-slot="popover-content"], .context-menu')) return
      if (event.key === 'Escape' && controller.capturing) {
        // Capture owns Escape before the canvas editor consumes it. An open
        // dialog or menu above has first refusal; it closes without cancelling.
        cancelCapture(controller, event)
      }
      else if (!(event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key === 'Enter' && !event.shiftKey && controller.active) {
          event.preventDefault(); event.stopPropagation(); enterHeld = true; void controller.finish()
        } else if (event.code === 'KeyR' && event.shiftKey && !controller.busy && !attached && !disabled) {
          event.preventDefault(); event.stopPropagation(); onStart(); void controller.start()
        }
      }
    }
    document.addEventListener('keydown', key, true)
    document.addEventListener('keyup', keyUp, true)
    window.addEventListener('blur', releaseEnter)
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('keyup', keyUp, true); window.removeEventListener('blur', releaseEnter) }
  }, [])
  return <div ref={host} className="recording-control" hidden={attached || controller.phase === 'finishing' || controller.phase === 'sending'}>
    <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="compact" className="recording-primary" data-recording={controller.capturing}
      data-composer-motion="primary" aria-label={controller.capturing ? 'Stop recording' : 'Record a request'} aria-keyshortcuts={controller.capturing ? 'Enter' : 'Shift+R'}
      disabled={disabled && !controller.capturing} onClick={() => { if (controller.active) void controller.finish(); else if (controller.capturing) controller.cancel(); else { onStart(); void controller.start() } }}>
      <span className="recording-glyph" data-composer-motion="glyph" aria-hidden="true"><svg className="recording-glyph-ring" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25" /></svg><span className="recording-glyph-core" /></span>
      <span className="recording-primary-word" data-composer-motion="word" aria-hidden="true"><span>Record</span><span>Stop</span></span><kbd aria-hidden="true">↵</kbd>
    </Button></TooltipTrigger><TooltipContent onEscapeKeyDown={event => cancelCapture(controller, event)}>{controller.capturing ? 'Stop and keep draft · Enter' : 'Record a request · ⇧R · Audio goes to Cloudflare when sent'}</TooltipContent></Tooltip>
  </div>
}

/** The live take becomes the retained attachment in place, including its clock. */
export function RecordingPreview({ draft, controller }: { draft: RecordingResult | null; controller: Controller }) {
  const [open, setOpen] = useState(false), [url, setUrl] = useState<string>(), [error, setError] = useState('')
  const shown = Boolean(draft) || controller.busy
  const status = controller.phase === 'finishing' ? 'Saving…' : controller.phase === 'sending' ? 'Sending…' : 'Recording'
  useEffect(() => {
    setUrl(undefined); setError('')
    if (!draft) { setOpen(false); return }
    if (!open) return
    let active = true, objectUrl: string | undefined
    void recordingPlayback(draft).then(media => {
      if (!active) return
      objectUrl = URL.createObjectURL(media); setUrl(objectUrl)
    }).catch(() => { if (active) setError('The recording could not be opened.') })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [open, draft?.media, draft?.packet.duration])
  return <div className="recording-context" data-state={controller.capturing ? 'capturing' : shown ? 'retained' : 'idle'} role="group"
    aria-label={controller.capturing ? 'Recording controls' : 'Recorded request'} aria-hidden={!shown} inert={!shown}>
    <div className="recording-take" data-composer-motion="take">
      <Popover open={open && Boolean(draft)} onOpenChange={value => { if (draft && !controller.capturing) setOpen(value) }}><PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="compact" className="recording-status" aria-label={controller.capturing ? 'Recording in progress' : 'Review recording'} tabIndex={controller.capturing ? -1 : 0}>
          <span className="recording-rec-dot" data-active={controller.active} aria-hidden="true" />
          <span className="recording-take-word" aria-hidden="true"><span>{controller.phase === 'starting' ? '…' : 'REC'}</span><span>{status}</span></span>
          <RecordingTime controller={controller} draft={draft} />
        </Button>
      </PopoverTrigger><PopoverContent className="recording-playback" side="top" align="start" collisionPadding={12} aria-label="Recording playback">{error ? <p role="status">{error}</p> : url ? <video src={url} controls playsInline /> : <p>Opening recording…</p>}<p>Audio is transcribed by Cloudflare when you send.</p></PopoverContent></Popover>
      <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="compact" className="recording-discard" data-composer-motion="discard"
        aria-label={controller.capturing ? 'Cancel recording' : 'Remove recording'} aria-keyshortcuts={controller.capturing ? 'Escape' : undefined} disabled={controller.phase === 'finishing' || controller.phase === 'sending'}
        onClick={() => controller.capturing ? controller.cancel() : void controller.remove()}>
        <span aria-hidden="true">Cancel</span><X aria-hidden="true" />
      </Button></TooltipTrigger><TooltipContent onEscapeKeyDown={event => cancelCapture(controller, event)}>{controller.capturing ? 'Discard this recording · Esc' : 'Remove recording'}</TooltipContent></Tooltip>
    </div>
    <span className="sr-only" role="status">{controller.busy ? controller.phase === 'starting' ? 'Opening microphone' : controller.active ? 'Recording' : status : draft ? 'Recording retained. Ready to send.' : ''}</span>
  </div>
}

export function SentRecording({ projectId, requestId, duration, onRestore }: { projectId: string; requestId: string; duration: number; onRestore?: (() => Promise<void>) | undefined }) {
  const [open, setOpen] = useState(false), [url, setUrl] = useState<string>(), [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    let active = true, objectUrl: string | undefined
    setError('')
    void readSubmittedRecording(projectId, requestId).then(async value => {
      if (!active) return
      if (!value) { setError('The original recording is unavailable on this device.'); return }
      const media = await recordingPlayback(value)
      if (!active) return
      objectUrl = URL.createObjectURL(media); setUrl(objectUrl)
    }).catch(() => { if (active) setError('The recording could not be opened.') })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); setUrl(undefined) }
  }, [open, projectId, requestId])
  return <div className="recording-attachment"><Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button type="button" variant="ghost" size="compact" aria-label="Play sent recording"><Play />Recording · {time(duration)}</Button></PopoverTrigger>
    <PopoverContent className="recording-playback" side="top" align="start">{error ? <p role="status">{error}</p> : url ? <video src={url} controls playsInline /> : <p>Opening recording…</p>}</PopoverContent>
  </Popover>{onRestore && <Button type="button" variant="ghost" size="compact" onClick={() => void onRestore()}>Restore recording</Button>}</div>
}
