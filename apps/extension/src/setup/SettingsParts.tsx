import { forwardRef, useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { themeTime } from '../design/theme'

/** Every Settings view opens the same way: one bar for Back (the close button
 * shares its line), then the title, then at most one sentence. The title sits
 * at the same place in every view, so moving between views never shifts it. */
export function ViewHeader({ back, title, description, lead, titleRef }: {
  back?: { label: string; onClick(): void }
  title: string
  description?: string
  /** An identity beside the title, such as the signed-in person's picture. */
  lead?: ReactNode
  titleRef?: Ref<HTMLHeadingElement>
}) {
  return <header className="settings-header" data-lead={lead ? true : undefined}>
    <div className="settings-bar">{back && <button type="button" className="settings-back" onClick={back.onClick}><ChevronLeft aria-hidden="true" />{back.label}</button>}</div>
    <div className="settings-heading">
      {lead && <span className="settings-heading-lead" aria-hidden="true">{lead}</span>}
      <div className="min-w-0">
        <DialogTitle ref={titleRef} tabIndex={-1} title={lead ? title : undefined} className="settings-title">{title}</DialogTitle>
        {description ? <DialogDescription className="settings-description">{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
      </div>
    </div>
  </header>
}

/** One row of a Settings list: a leading mark in a shared column, a label,
 * and its state at the trailing edge. A row that opens a view carries a
 * chevron; one that only reports does not. */
export function SettingsRow({ lead, label, detail, state, onClick, opens = true, hero, className, buttonRef, destination, disabled }: {
  lead: ReactNode; label: string; detail?: string | undefined; state?: ReactNode
  onClick?: (() => void) | undefined
  /** A row that opens a view shows a chevron; one that acts in place does not. */
  opens?: boolean
  hero?: boolean; className?: string; buttonRef?: Ref<HTMLButtonElement>
  destination?: string; disabled?: boolean
}) {
  const id = useId()
  const body = <>
    <span className="settings-row-lead">{lead}</span>
    <span className="settings-row-text"><span id={`${id}-label`} className="settings-row-label">{label}</span>{detail && <span id={`${id}-detail`} className="settings-row-detail">{detail}</span>}</span>
    {(state || onClick && opens) && <span id={`${id}-state`} className="settings-row-state">{state}{onClick && opens && <ChevronRight aria-hidden="true" />}</span>}
  </>
  return onClick
    ? <button ref={buttonRef} type="button" data-settings-view={destination} aria-labelledby={`${id}-label${state ? ` ${id}-state` : ''}`} aria-describedby={detail ? `${id}-detail` : undefined} disabled={disabled} className={cn('settings-row', hero && 'settings-row-hero', className)} onClick={onClick}>{body}</button>
    : <div className={cn('settings-row', hero && 'settings-row-hero', className)}>{body}</div>
}

/** Views move like pages in a stack: the next one slides in from the side it
 * comes from while the last one slides away, and the dialog's height follows
 * whatever its content becomes, so nothing jumps. The leaving view is a
 * static copy of its last frame; its component is already gone. */
export function ViewStack({ view, direction, returnTo, children }: { view: string; direction: 'forward' | 'back' | undefined; returnTo: string | undefined; children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | null>(null)
  // The leaving view needs the new direction, and which view is current,
  // before the new view commits.
  const leaving = useRef(direction), current = useRef(view)
  leaving.current = direction
  current.current = view
  useLayoutEffect(() => {
    const node = content.current!
    const measure = () => setHeight(node.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [view])
  return <div ref={viewport} className="settings-viewport" style={height === null ? undefined : { height }}>
    <ViewFrame key={view} view={view} returnTo={returnTo} current={current} ref={content} viewport={viewport} leaving={leaving} direction={direction}>{children}</ViewFrame>
  </div>
}

type Direction = 'forward' | 'back' | undefined
const ViewFrame = forwardRef<HTMLDivElement, { view: string; returnTo: string | undefined; current: RefObject<string>; viewport: RefObject<HTMLDivElement | null>; leaving: RefObject<Direction>; direction: Direction; children: ReactNode }>(function ViewFrame({ view, returnTo, current, viewport, leaving, direction, children }, ref) {
  const own = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!direction) return
    const row = view === 'settings' && returnTo ? own.current?.querySelector<HTMLElement>(`[data-settings-view="${returnTo}"]`) : null
    const target = row ?? own.current?.querySelector<HTMLElement>('.settings-title')
    target?.focus({ preventScroll: true })
  }, [direction, returnTo, view])
  // Runs while this view's DOM is still attached: leave a copy to slide away.
  useLayoutEffect(() => () => {
    const node = own.current, host = viewport.current
    // Only a view that another replaced leaves; a remount of the same view
    // (React's strict checks) is not a departure.
    if (!node || !host?.isConnected || current.current === view) return
    const duration = themeTime('--motion-disclosure', host)
    if (!duration) return
    const copy = node.cloneNode(true) as HTMLElement
    copy.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'))
    copy.setAttribute('aria-hidden', 'true'); copy.inert = true
    copy.classList.add('settings-view-leaving')
    copy.dataset.direction = leaving.current
    host.append(copy)
    // The last view clears out in the first part of the move, so its text
    // never sits on top of the next view's text.
    const animations = copy.getAnimations()
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => copy.remove())
  }, [viewport, leaving, current, view])
  return <div ref={node => { own.current = node; if (typeof ref === 'function') ref(node); else if (ref) ref.current = node }} className="settings-view" data-direction={direction}>{children}</div>
})
