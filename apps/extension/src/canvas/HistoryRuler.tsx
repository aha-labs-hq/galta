import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { themeColor, themeEasing, themeLength, themeTime } from '../design/theme'
import type { MultiverseLayout } from './historyLayout'
import type { Moments } from './historyTimeline'

const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0)

/** Today, Yesterday or the date: how people place their own recent work. */
export function dayLabel(time: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(time)) / 86_400_000)
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : dayFormat.format(time)
}
export const clockLabel = (time: number) => clockFormat.format(time)

export type TrimRange = { from: number; to: number }
type Point = { x: number; y: number }
type Drag = { kind: 'tape' | 'from' | 'to' | 'strand'; pointer: number; x: number; y: number; offset: number; travel: number; samples: { t: number; offset: number }[]; target?: string }
type Ink = { rest: [number, number, number]; peak: [number, number, number]; muted: string; font: string; band: string; stroke: number; handleStroke: number; handleCap: number; handleReach: number }
type Travel = { from: Map<string, Point>; start: number; duration: number }

const LABEL_ROW = 16
const ease = (t: number) => 1 - (1 - t) ** 3
const mix = (a: [number, number, number], b: [number, number, number], f: number) => a.map((value, k) => Math.round(value + (b[k]! - value) * f)) as [number, number, number]

/**
 * The Time Machine ruler: one tick per moment on a tape that slides under a
 * fixed playhead. Ticks rise and darken in a symmetric fan around it. The
 * universe being travelled is the straight line; every other future grows
 * from the moment it branched at, as a fine strand above, or as a bud when
 * no lane is free. Clicking one travels there, and the tape rearranges so it
 * becomes the straight line. In trim, two handles bracket a range.
 */
export const HistoryRuler = forwardRef<HTMLDivElement, {
  moments: Moments; layout: MultiverseLayout; index: number; current: string; valueText: string; disabled: boolean
  /** Lanes reserved above the line for this visit, so travelling never resizes the ruler. */
  lanes: number
  trim: TrimRange | null
  /** The wheel and trackpad scrub the ruler from anywhere on this surface. */
  surface: React.RefObject<HTMLElement | null>
  /** `final` is false for the moments a scrub passes, true where it settles. */
  onSeek: (index: number, final: boolean) => void
  onTravel: (moment: string) => void
  onTrim: (range: TrimRange, handle: 'from' | 'to') => void
}>(function HistoryRuler({ moments, layout, index, current, valueText, disabled, lanes, trim, surface, onSeek, onTravel, onTrim }, ref) {
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null)
  const trimFocus = useRef<'from' | 'to' | null>(null)
  useImperativeHandle(ref, () => host.current!, [])
  const handlers = useRef({ onSeek, onTravel, onTrim })
  handlers.current = { onSeek, onTravel, onTrim }
  const ruler = useRef<{
    offset: number; width: number; height: number; positions: number[]; emitted: number; frame: number; wheel?: ReturnType<typeof setTimeout>
    motion: { from: number; to: number; start: number; duration: number; report: boolean } | undefined; drag: Drag | undefined; travel: Travel | undefined; hover: string | undefined
    gap: number; rest: number; peak: number; fan: number; lane: number; ink?: Ink
    layout: MultiverseLayout; moments: Moments; current: string; trim: TrimRange | null; disabled: boolean; lanes: number; draw(): void
    /** The latest layout and selection, which a resize lays out again. */
    next: { layout: MultiverseLayout; index: number }
  }>(undefined as never)
  if (!ruler.current) ruler.current = {
    offset: Number.NaN, width: 0, height: 0, positions: [], emitted: -1, frame: 0, motion: undefined, drag: undefined, travel: undefined, hover: undefined,
    gap: 8, rest: 6, peak: 26, fan: 30, lane: 6, layout, moments, current, trim, disabled, lanes, draw: () => {}, next: { layout, index }
  }
  const r = ruler.current
  r.moments = moments; r.current = current; r.trim = trim; r.disabled = disabled; r.lanes = lanes; r.next = { layout, index }

  const nearest = (offset: number) => {
    const p = r.positions
    let low = 0, high = p.length - 1
    while (low < high) { const mid = (low + high) >> 1; if (p[mid]! < offset) low = mid + 1; else high = mid }
    return low > 0 && offset - p[low - 1]! < p[low]! - offset ? low - 1 : low
  }
  const base = () => r.height - LABEL_ROW
  const budPoint = (fork: Point): Point => ({ x: fork.x + 2, y: fork.y - (fork.y === base() ? r.rest : 3) - 5 })
  const laneY = (lane: number) => base() - r.peak - r.lane * lane
  const reach = () => r.fan / 3
  /** Where a moment sits on screen in the current layout. */
  const point = (id: string): Point | undefined => {
    const at = r.layout.at.get(id)
    return at && { x: r.width / 2 + at.x - r.offset, y: at.lane ? laneY(at.lane) : base() }
  }
  // A move the ruler makes itself reports each version it reaches; a move
  // that follows an outside seek is quiet.
  const place = (offset: number, report = true) => {
    r.offset = offset
    r.draw()
    const at = nearest(offset)
    if (report && at !== r.emitted && r.drag?.kind !== 'from' && r.drag?.kind !== 'to') { r.emitted = at; handlers.current.onSeek(at, false) }
  }
  const stop = () => { cancelAnimationFrame(r.frame); r.motion = undefined }
  const tick = () => {
    const now = performance.now(), m = r.motion
    if (m) {
      const t = Math.min(1, (now - m.start) / m.duration)
      place(m.from + (m.to - m.from) * ease(t), m.report)
      if (t >= 1) {
        r.motion = undefined
        // Where a gesture comes to rest is the moment it chose.
        if (m.report) { r.emitted = nearest(r.offset); handlers.current.onSeek(r.emitted, true) }
      }
    } else r.draw()
    if (r.motion || r.travel && now - r.travel.start < r.travel.duration) r.frame = requestAnimationFrame(tick)
    else { r.travel = undefined; r.draw() }
  }
  /** `report` marks a move the user's gesture made: it reports the moments it
   * passes and, where it rests, the final one. */
  const animate = (to: number, duration: number, report = false) => {
    stop()
    if (duration <= 0 || !Number.isFinite(r.offset)) {
      place(to, report)
      if (report) { r.emitted = nearest(r.offset); handlers.current.onSeek(r.emitted, true) }
      return
    }
    r.motion = { from: r.offset, to, start: performance.now(), duration, report }
    r.frame = requestAnimationFrame(tick)
  }
  const settle = (target: number, report = false) => animate(r.positions[target]!, themeTime('--motion-history-snap', canvas.current!), report)

  r.draw = () => {
    const element = canvas.current, ink = r.ink
    if (!element || !ink || !r.width) return
    const context = element.getContext('2d')!, dpr = devicePixelRatio || 1
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, r.width, r.height)
    const middle = r.width / 2, b = base(), crisp = (x: number) => Math.round(x * dpr) / dpr + .5 / dpr, top = b - r.peak - 4
    // Keyboard focus is the ruler's own baseline, drawn under the ticks: as
    // fine as the ruler, and clear against the field.
    if (element.parentElement!.matches(':focus-visible')) { context.fillStyle = ink.muted; context.fillRect(0, b, r.width, ink.stroke) }
    const travel = r.travel, k = travel ? ease(Math.min(1, (performance.now() - travel.start) / travel.duration)) : 1
    // During a travel every moment glides from where it was to where it goes.
    const at = (id: string): Point | undefined => {
      const to = point(id)
      const from = travel?.from.get(id)
      return to && from ? { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k } : to
    }
    const fan = (x: number) => Math.exp(-Math.abs(x - middle) / reach())
    const inside = (i: number) => !r.trim || i >= r.trim.from && i <= r.trim.to
    // Trim: a quiet band behind the ticks between the handles.
    if (r.trim) {
      const a = at(r.layout.path[r.trim.from]!)!, z = at(r.layout.path[r.trim.to]!)!
      context.fillStyle = ink.band
      context.fillRect(a.x - r.gap / 2, top, z.x - a.x + r.gap, b - top)
    }
    // Other universes: a hairline that rises from its fork and runs beside
    // the line, a short tick per moment. Like the ticks, a strand is clearer
    // near the playhead and fades with distance; the one under the pointer is
    // drawn in full.
    const budded = new Set<string>()
    for (const strand of r.layout.strands) {
      if (!strand.index) continue
      const fork = at(strand.fork!)!, first = at(strand.moments[0]!)!, last = at(strand.moments.at(-1)!)!
      if (Math.max(fork.x, last.x) < -r.gap || Math.min(fork.x, first.x) > r.width + r.gap) continue
      const hovered = strand.moments.includes(r.hover ?? '')
      const near = Math.exp(-Math.max(0, Math.min(Math.abs(fork.x - middle), Math.abs(last.x - middle), fork.x < middle && last.x > middle ? 0 : Infinity)) / (r.fan * 4))
      const [c0, c1, c2] = hovered ? ink.peak : ink.rest
      context.strokeStyle = `rgb(${c0} ${c1} ${c2} / ${hovered ? .95 : .3 + .4 * near})`
      context.fillStyle = context.strokeStyle
      context.lineWidth = ink.stroke
      const rise = fork.y - (fork.y === b ? r.rest : 3)
      if (strand.bud) {
        // A bud is a strand folded at its fork: up, a round corner, a stub.
        if (budded.has(strand.fork!)) continue
        budded.add(strand.fork!)
        const x = crisp(fork.x), y = budPoint(fork).y
        context.beginPath(); context.moveTo(x, rise); context.lineTo(x, y + 2); context.quadraticCurveTo(x, y, x + 2, y); context.lineTo(x + 4, y); context.stroke()
        continue
      }
      // Up from the fork, a small round corner, then along the lane.
      const x = crisp(fork.x), corner = Math.min(3, Math.abs(rise - first.y))
      context.beginPath(); context.moveTo(x, rise); context.lineTo(x, first.y + corner)
      context.quadraticCurveTo(x, first.y, x + corner, first.y); context.lineTo(last.x, last.y); context.stroke()
      for (const id of strand.moments) {
        const p = at(id)!
        if (p.x < -r.gap || p.x > r.width + r.gap) continue
        context.beginPath(); context.moveTo(crisp(p.x), p.y); context.lineTo(crisp(p.x), p.y - 3); context.stroke()
        if (r.moments.byId.get(id)!.name) { context.beginPath(); context.arc(p.x, p.y - 6, 1.25, 0, Math.PI * 2); context.fill() }
      }
    }
    // The travelled universe: the fan of ticks under the playhead.
    const path = r.layout.path
    const first = Math.max(0, nearest(r.offset - middle) - 2), last = Math.min(path.length - 1, nearest(r.offset + middle) + 2)
    for (let i = travel ? 0 : first; i <= (travel ? path.length - 1 : last); i++) {
      const p = at(path[i]!)!, f = fan(p.x)
      if (p.x < -r.gap || p.x > r.width + r.gap) continue
      const height = r.rest + (r.peak - r.rest) * f, [c0, c1, c2] = mix(ink.rest, ink.peak, f)
      context.strokeStyle = `rgb(${c0} ${c1} ${c2} / ${inside(i) ? 1 : .35})`
      context.lineWidth = ink.stroke
      context.beginPath(); context.moveTo(crisp(p.x), p.y); context.lineTo(crisp(p.x), p.y - height); context.stroke()
      if (r.moments.byId.get(path[i]!)!.name) {
        context.fillStyle = context.strokeStyle
        context.beginPath(); context.arc(p.x, p.y - height - 4, 1.5, 0, Math.PI * 2); context.fill()
      }
    }
    // Short inward caps make the range read as brackets, distinct from ticks.
    if (r.trim) {
      context.strokeStyle = themeColor('foreground'); context.lineWidth = ink.handleStroke; context.lineCap = 'round'
      for (const [i, side] of [[r.trim.from, -1], [r.trim.to, 1]] as const) {
        const x = Math.round(at(path[i]!)!.x + side * r.gap / 2)
        context.beginPath(); context.moveTo(x - side * ink.handleCap, top + 1); context.lineTo(x, top + 1); context.lineTo(x, b - 1); context.lineTo(x - side * ink.handleCap, b - 1); context.stroke()
        if (trimFocus.current === (side < 0 ? 'from' : 'to')) {
          context.save(); context.strokeStyle = ink.muted; context.lineWidth = themeLength('--focus-width')
          context.strokeRect(x - r.gap / 2, top, r.gap, b - top); context.restore()
        }
      }
      context.lineCap = 'butt'
    }
    // Labels: Now first, then each day's first session left to right.
    context.font = ink.font; context.textBaseline = 'alphabetic'
    const taken: [number, number][] = [], y = r.height - 3, inset = 32
    const label = (text: string, x: number, align: 'left' | 'center', color: string) => {
      const width = context.measureText(text).width, left = align === 'center' ? x - width / 2 : x
      if (left + width < 0 || left + width > r.width - inset / 2 || taken.some(([s, e]) => left < e + 8 && left + width > s - 8)) return
      taken.push([left, left + width]); context.fillStyle = color; context.textAlign = 'left'; context.fillText(text, left, y)
    }
    const now = at(r.current)
    if (now) label('Now', now.x, 'center', themeColor('foreground'))
    const days: { x: number; text: string }[] = []
    let previousDay = Number.NaN
    for (let i = 0; i <= last; i++) {
      const id = path[i]!, moment = r.moments.byId.get(id)!, day = startOfDay(moment.start)
      if (!r.layout.sessionStarts.has(id) || day === previousDay) continue
      previousDay = day
      days.push({ x: at(id)!.x, text: dayLabel(moment.start) })
    }
    days.forEach((day, i) => {
      const next = days[i + 1], width = context.measureText(day.text).width
      const x = day.x < inset ? Math.min(inset, (next?.x ?? Infinity) - width - 16) : day.x
      // A label that cannot sit wholly inside the ruler is left out.
      if (next && next.x < inset || x < 0) return
      label(day.text, x, 'left', ink.muted)
    })
  }

  // A pointer near a strand or bud points at its universe.
  const strandAt = (x: number, y: number): string | undefined => {
    if (y > base() - r.rest - 2) return undefined
    let best: { id: string; distance: number } | undefined
    for (const strand of r.layout.strands) {
      if (!strand.index) continue
      const candidates = strand.bud ? [{ id: strand.moments.at(-1)!, p: budPoint(point(strand.fork!)!) }] : strand.moments.map(id => ({ id, p: point(id)! }))
      for (const { id, p } of candidates) {
        const distance = Math.hypot((p.x - x) / 2, p.y - (strand.bud ? 0 : 2) - y)
        if (distance < 8 && (!best || distance < best.distance)) best = { id, distance }
      }
    }
    return best?.id
  }
  const handleAt = (x: number): 'from' | 'to' | undefined => {
    if (!r.trim) return undefined
    const a = point(r.layout.path[r.trim.from]!)!.x - r.gap / 2, z = point(r.layout.path[r.trim.to]!)!.x + r.gap / 2
    const from = Math.abs(x - a), to = Math.abs(x - z)
    // Targets may overlap for a short range. The closest edge owns the hit;
    // testing the start first used to steal the end of a one-moment range.
    return Math.min(from, to) <= (r.ink?.handleReach ?? 0) ? from <= to ? 'from' : 'to' : undefined
  }

  // Geometry and ink come from the tokens.
  useEffect(() => {
    const element = canvas.current!, root = host.current!
    const measure = () => {
      r.gap = themeLength('--history-tick-gap'); r.rest = themeLength('--history-tick-rest'); r.peak = themeLength('--history-tick-peak')
      r.fan = themeLength('--history-fan'); r.lane = themeLength('--history-lane')
      const probe = document.createElement('canvas').getContext('2d')!, rgb = (color: string) => {
        probe.fillStyle = '#000'; probe.fillStyle = color
        const hex = probe.fillStyle.slice(1)
        return [0, 2, 4].map(i => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
      }
      const style = getComputedStyle(root)
      r.ink = { rest: rgb(themeColor('border-strong')), peak: rgb(themeColor('foreground')), muted: themeColor('muted-foreground'), font: `${style.getPropertyValue('--text-caption').trim()} ${style.fontFamily}`, band: themeColor('surface-hover'), stroke: themeLength('--stroke-surface'), handleStroke: themeLength('--history-handle-stroke'), handleCap: themeLength('--history-handle-cap'), handleReach: themeLength('--target-compact') / 2 }
      const box = root.getBoundingClientRect(), dpr = devicePixelRatio || 1
      r.width = box.width; r.height = box.height
      element.width = Math.round(box.width * dpr); element.height = Math.round(box.height * dpr)
      layoutTape(false)
    }
    // Horizontal trackpad swipes would otherwise navigate the browser back.
    const wheel = (event: WheelEvent) => {
      if ((event.target as Element).closest('input, textarea')) return
      event.preventDefault()
      if (r.disabled || !r.positions.length || r.drag) return
      stop()
      const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * (event.deltaMode === 1 ? 16 : 1)
      place(Math.min(r.positions.at(-1)!, Math.max(0, r.offset + delta)))
      clearTimeout(r.wheel)
      r.wheel = setTimeout(() => settle(nearest(r.offset), true), 140)
    }
    const area = surface.current ?? root
    area.addEventListener('wheel', wheel, { passive: false })
    const observer = new ResizeObserver(measure)
    observer.observe(root); measure()
    return () => { observer.disconnect(); area.removeEventListener('wheel', wheel); stop(); clearTimeout(r.wheel) }
  }, [])

  /** Adopt the latest layout. A travel glides every moment from its old
   * place, and the tape lands with the selected moment under the playhead. */
  const layoutTape = (travelled: boolean) => {
    const { layout, index } = r.next
    const previous = travelled ? new Map([...r.layout.at.keys()].flatMap(id => { const p = point(id); return p ? [[id, p] as const] : [] })) : undefined
    r.layout = layout
    r.positions = layout.path.map(id => layout.at.get(id)!.x)
    if (r.emitted < 0 || travelled) { r.emitted = index; r.offset = r.positions[index] ?? 0 }
    else r.offset = r.positions[Math.min(r.emitted, r.positions.length - 1)] ?? 0
    const duration = themeTime('--motion-history-travel', canvas.current!)
    if (previous && duration > 0) { stop(); r.travel = { from: previous, start: performance.now(), duration }; r.frame = requestAnimationFrame(tick) }
    else r.draw()
  }
  const travelled = useRef(layout)
  useEffect(() => {
    const isTravel = travelled.current !== layout && travelled.current.path.at(-1) !== layout.path.at(-1)
    travelled.current = layout
    if (r.width) layoutTape(isTravel)
  }, [layout])

  // A seek from outside settles the tape on that moment.
  useEffect(() => {
    if (index === r.emitted || !r.positions.length) return
    r.emitted = index
    if (!r.drag) settle(index)
  }, [index])
  useEffect(() => { r.draw() }, [current, trim])
  // A disabled ruler is still: a fling or a pending wheel settle stops, so it
  // never seeks behind a closing or recording visit.
  useEffect(() => { if (disabled) { stop(); clearTimeout(r.wheel); r.drag = undefined } }, [disabled])

  const release = (event: React.PointerEvent) => {
    const drag = r.drag
    if (!drag || drag.pointer !== event.pointerId) return
    r.drag = undefined
    const box = host.current!.getBoundingClientRect(), x = event.clientX - box.left
    if (drag.kind === 'strand') { if (drag.travel < 4 && drag.target) handlers.current.onTravel(drag.target); return }
    if (drag.kind === 'from' || drag.kind === 'to') { settle(drag.kind === 'from' ? r.trim!.from : r.trim!.to, true); return }
    if (drag.travel < 4) { settle(nearest(r.offset + x - r.width / 2), true); return }
    const recent = drag.samples.filter(sample => event.timeStamp - sample.t < 90)
    const from = recent[0], velocity = from && event.timeStamp > from.t ? (r.offset - from.offset) / (event.timeStamp - from.t) : 0
    const glide = themeTime('--motion-history-glide', canvas.current!), snap = themeTime('--motion-history-snap', canvas.current!)
    const target = nearest(Math.min(r.positions.at(-1)!, Math.max(0, r.offset + velocity * glide)))
    const distance = Math.abs(r.positions[target]! - r.offset)
    // Start the glide at the pointer's own speed: an ease-out cubic leaves at
    // three times its average velocity.
    animate(r.positions[target]!, Math.abs(velocity) > .05 ? Math.min(4 * glide, Math.max(snap, 3 * distance / Math.abs(velocity))) : snap, true)
  }

  const height = `calc(var(--history-ruler-height) + ${lanes} * var(--history-lane) + ${lanes ? 'var(--space-1)' : '0px'})`
  return <div className="history-ruler-container"><div ref={host} className="history-ruler" role="slider" tabIndex={disabled ? -1 : 0} aria-label="History" aria-disabled={disabled || undefined}
    aria-valuemin={1} aria-valuemax={Math.max(1, layout.path.length)} aria-valuenow={index + 1} aria-valuetext={valueText} style={{ height }}
    onPointerDown={event => {
      if (disabled || event.button !== 0) return
      const box = host.current!.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top
      stop(); clearTimeout(r.wheel)
      event.currentTarget.setPointerCapture(event.pointerId)
      const handle = handleAt(x), target = handle ? undefined : strandAt(x, y)
      r.drag = { kind: handle ?? (target ? 'strand' : 'tape'), pointer: event.pointerId, x: event.clientX, y: event.clientY, offset: r.offset, travel: 0, samples: [{ t: event.timeStamp, offset: r.offset }], ...(target ? { target } : {}) }
    }}
    onPointerMove={event => {
      const drag = r.drag, box = host.current!.getBoundingClientRect(), x = event.clientX - box.left
      if (!drag) {
        const hover = strandAt(x, event.clientY - box.top), grab = handleAt(x)
        if (hover !== r.hover) { r.hover = hover; r.draw() }
        event.currentTarget.style.cursor = grab ? 'ew-resize' : hover ? 'pointer' : ''
        return
      }
      if (drag.pointer !== event.pointerId) return
      drag.travel = Math.max(drag.travel, Math.abs(event.clientX - drag.x))
      if (drag.kind === 'strand') return
      if (drag.kind === 'from' || drag.kind === 'to') {
        // A handle sits half a gap outside its tick; the tick under it follows the pointer.
        const i = nearest(r.offset + x - r.width / 2 + (drag.kind === 'from' ? r.gap / 2 : -r.gap / 2)), range = r.trim!
        const next = drag.kind === 'from' ? { from: Math.min(i, range.to), to: range.to } : { from: range.from, to: Math.max(i, range.from) }
        if (next.from !== range.from || next.to !== range.to) handlers.current.onTrim(next, drag.kind)
        return
      }
      const end = r.positions.at(-1) ?? 0, raw = drag.offset - (event.clientX - drag.x)
      // Past either end the tape resists instead of stopping dead.
      place(raw < 0 ? raw * .3 : raw > end ? end + (raw - end) * .3 : raw)
      drag.samples.push({ t: event.timeStamp, offset: r.offset })
      if (drag.samples.length > 12) drag.samples.shift()
    }}
    onPointerLeave={() => { if (r.hover) { r.hover = undefined; r.draw() } }}
    // A key pressed after a programmatic focus turns on :focus-visible without
    // a focus event, so a released key redraws the baseline as well.
    onFocus={() => r.draw()} onBlur={() => r.draw()} onKeyUp={() => r.draw()}
    onPointerUp={release} onPointerCancel={release}>
    <canvas ref={canvas} aria-hidden="true" />
  </div>
    {/* Native range inputs give each drawn handle its own keyboard and assistive
        technology semantics. They share the range and drawing used by drag;
        the canvas shows their focus at the actual handle, including offscreen ends. */}
    {trim && (['from', 'to'] as const).map(handle => {
      const moment = moments.byId.get(layout.path[trim[handle]]!)!
      return <input key={handle} className="sr-only" type="range" aria-label={handle === 'from' ? 'Trim start' : 'Trim end'}
        min={handle === 'from' ? 1 : trim.from + 1} max={handle === 'from' ? trim.to + 1 : layout.path.length} step={1} value={trim[handle] + 1}
        aria-valuetext={`${trim[handle] + 1} of ${layout.path.length}, ${moment.name ? `${moment.name}, ` : ''}${dayLabel(moment.end)}, ${clockLabel(moment.end)}`}
        disabled={disabled}
        onFocus={() => { trimFocus.current = handle; onSeek(trim[handle], true); r.draw() }}
        onBlur={() => { trimFocus.current = null; r.draw() }}
        onChange={event => onTrim({ ...trim, [handle]: event.currentTarget.valueAsNumber - 1 }, handle)} />
    })}
  </div>
})
