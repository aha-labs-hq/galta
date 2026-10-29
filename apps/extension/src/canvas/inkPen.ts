import { getCommonBounds, presentFreeDrawElement } from '@excalidraw/excalidraw'
import { createFreeDrawPlayback } from '@excalidraw/excalidraw/freeDrawPath'
import { holdStaticElements } from '@excalidraw/excalidraw/staticTiles'
import type { ExcalidrawElement, ExcalidrawFreeDrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { themeNumber, themeTime } from '../design/theme'
import type { CanvasWork } from './canvasWork'

type Bounds = { x: number; y: number; width: number; height: number }

/** Finished work bakes into the tiles this many elements at a time. A GPU
 * canvas antialiases overlapping translucent strokes by how many it paints in
 * one pass: baked one at a time, dense hatching settles visibly darker than
 * the tiles' own renders of it, which paint hundreds a pass; at this size it
 * settles within their own variation. Until then finished work is presented,
 * natively, like the stroke under the pen. */
const BAKE = 128

/** One element of the work landing, in the order it lands. */
type Turn = {
  element: ExcalidrawElement
  /** Ink the pen draws: the distance along the stroke at each point. Without
   * it the element appears whole when its turn comes. */
  along?: Float64Array
  /** When the pen reaches it and moves on, on the pen's clock: milliseconds of
   * drawing at a natural pace. */
  start: number
  end: number
}

/** Types that wait for their turn: the tiles draw them, so they can hold them
 * back. An image lands with its DOM title as committed, a frame clips its
 * members, and pages and videos are DOM. */
const TURNS = new Set<ExcalidrawElement['type']>(['freedraw', 'line', 'arrow', 'rectangle', 'ellipse', 'diamond', 'text'])

/** A stroke the pen draws exactly as the canvas will: its outline, no fill. */
function drawable(element: ExcalidrawElement): element is ExcalidrawFreeDrawElement {
  return element.type === 'freedraw' && element.backgroundColor === 'transparent' && element.points.length > 0
}

/**
 * The part of an edit that lands in turn: its topmost run of new elements,
 * bottom to top. New elements below the run land as committed, so nothing
 * waiting is ever beneath something already shown, and every element keeps
 * its native stacking.
 */
export function newWork(elements: readonly ExcalidrawElement[], previous: { has(id: string): boolean }) {
  const visible = elements.filter(element => !element.isDeleted)
  const waits = (element: ExcalidrawElement) => !previous.has(element.id) && TURNS.has(element.type) && !element.frameId && element.opacity > 0
  let start = visible.length
  while (start && waits(visible[start - 1]!)) start--
  return visible.slice(start)
}

/** The largest index whose distance is at most `reach`. */
function passed(along: Float64Array, reach: number) {
  let low = 0, high = along.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (along[middle]! <= reach) low = middle; else high = middle - 1
  }
  return low
}

function inView(element: ExcalidrawFreeDrawElement, view: Bounds) {
  const [left, top, right, bottom] = getCommonBounds([element]), pad = element.strokeWidth * 4.25
  return right + pad >= view.x && bottom + pad >= view.y && left - pad <= view.x + view.width && top - pad <= view.y + view.height
}

/**
 * New work landing the way a hand makes it. Elements already committed to the
 * scene are held back from its static tiles and land one after another in
 * stacking order: a stroke is drawn from its first point to its last along its
 * own path, anything else appears when its turn comes. The pen runs inside the
 * tiles' render and presents what it has drawn above them, natively and on
 * their own pixels: the stroke under it as a copy outlined as far as the pen,
 * and finished work as itself until it bakes into the tiles in one pass, as it
 * was shown. Nothing doubles, blinks or shifts but a stroke's final cap, as
 * when a hand lifts.
 *
 * It keeps a hand's pace (`--motion-ink-pace`, lifting for `--motion-ink-lift`
 * between strokes), and speeds up only as far as the work must to never trail
 * the document by more than `--motion-ink-catchup`. Presentation only: nothing
 * here is document state.
 */
export class InkPen {
  private queue: Turn[] = []
  /** Finished, presented, and not yet baked into the tiles. */
  private pending: Turn[] = []
  /** What the last render presented; landing everything lands this first. */
  private shown: Turn[] = []
  private finishing = false
  private readonly held = new Set<string>()
  private readonly hold = { version: 0, has: (id: string) => this.held.has(id), paint: () => this.paint() }
  /** The tiles holding for this pen, and how to ask them for another render. */
  private target: HTMLCanvasElement | undefined
  private request: (() => void) | undefined
  /** The pen's clock, and how fast it runs against real time. */
  private clock = 0
  private rate = 1
  private last = 0
  private scene: readonly ExcalidrawElement[] = []
  private waiting = new Set<() => void>()
  /** The stroke under the pen: its outline cursor, and the copy presented in its place. */
  private brush: { element: ExcalidrawFreeDrawElement; playback: ReturnType<typeof createFreeDrawPlayback>; copy: ExcalidrawFreeDrawElement } | undefined

  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)')
  private readonly hidden = () => { if (document.hidden) this.finish() }
  private readonly motionChanged = () => { if (this.reduced.matches) this.finish() }

  constructor(private readonly api: ExcalidrawImperativeAPI, private readonly tiles: () => HTMLCanvasElement | null) {
    document.addEventListener('visibilitychange', this.hidden)
    this.reduced.addEventListener('change', this.motionChanged)
  }

  /** Land `elements`, bottom to top, after any work still landing, holding them
   * back from the tiles first; call it before the scene shows them. Strokes in
   * `view`, or all strokes without one, are drawn; a stroke out of view takes
   * its turn without drawing time. Returns the ids the pen took: anything else
   * shows as committed. */
  draw(elements: readonly ExcalidrawElement[], view?: Bounds): ReadonlySet<string> {
    const taken = new Set<string>()
    const budget = themeTime('--motion-ink-catchup'), target = this.tiles()
    if (budget <= 0 || document.hidden || !target) return taken
    const pace = themeNumber('--motion-ink-pace'), lift = themeTime('--motion-ink-lift'), zoom = this.api.getAppState().zoom.value
    if (pace <= 0) throw new Error('Galta ink pace must be positive')
    // A new edit may arrive between frames: advance at the old rate first.
    if (this.request) { const now = performance.now(); this.clock += (now - this.last) * this.rate; this.last = now }
    // Work still landing at once when new work arrives lets go now, before it.
    if (this.finishing) { this.bake([...this.pending, ...this.queue]); this.shown = []; this.finishing = false }
    let end = this.queue.at(-1)?.end
    for (const element of elements) {
      if (this.held.has(element.id)) continue
      let turn: Turn = { element, start: end ?? this.clock, end: end ?? this.clock }
      if (drawable(element) && (!view || inView(element, view))) {
        const along = new Float64Array(element.points.length)
        for (let i = 1; i < along.length; i++) along[i] = along[i - 1]! + Math.hypot(element.points[i]![0] - element.points[i - 1]![0], element.points[i]![1] - element.points[i - 1]![1])
        const start = end === undefined ? this.clock : end + lift
        turn = { element, along, start, end: start + along[along.length - 1]! * zoom / pace * 1000 }
      }
      end = turn.end
      this.queue.push(turn)
      this.held.add(element.id); taken.add(element.id)
    }
    if (!taken.size) return taken
    // A later edit must not slow an earlier one. At least a hand's pace, and
    // fast enough that everything queued lands within the budget from now.
    this.rate = Math.max(this.request ? this.rate : 1, (end! - this.clock) / budget)
    this.scene = this.api.getSceneElementsIncludingDeleted()
    this.hold.version++
    if (this.request && this.target === target) this.request()
    else {
      if (this.target) holdStaticElements(this.target, null)
      this.target = target; this.last = performance.now()
      this.request = holdStaticElements(target, this.hold)
    }
    return taken
  }

  /** Land everything at once: what is on screen in the next render, exactly
   * as shown, and work never shown in the render after. */
  finish() {
    if (!this.queue.length && !this.pending.length) return
    this.finishing = true
    this.request?.()
  }

  /** Resolves once everything the pen took has landed. */
  drawn(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (!this.request) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const clean = () => { this.waiting.delete(done); signal?.removeEventListener('abort', abort) }
      const done = () => { clean(); resolve() }, abort = () => { clean(); reject(signal!.reason) }
      this.waiting.add(done); signal?.addEventListener('abort', abort, { once: true })
    })
  }

  /** Release the tiles now, whether or not they render again. */
  dispose() {
    document.removeEventListener('visibilitychange', this.hidden)
    this.reduced.removeEventListener('change', this.motionChanged)
    this.queue = []; this.pending = []; this.shown = []; this.held.clear(); this.hold.version++
    this.detach()
  }

  /** Runs at the start of every render of the tiles while the pen holds them,
   * and returns what it presents above them. */
  private paint(): readonly ExcalidrawElement[] {
    try {
      const now = performance.now()
      this.clock += (now - this.last) * this.rate; this.last = now
      const scene = this.api.getSceneElementsIncludingDeleted()
      if (scene !== this.scene) { this.scene = scene; this.forget(scene) }
      if (this.finishing) return this.land()
      while (this.queue.length && this.queue[0]!.end <= this.clock) this.pending.push(this.queue.shift()!)
      if (this.pending.length >= BAKE || !this.queue.length) this.bake(this.pending)
      if (!this.queue.length) { this.detach(); return [] }
      this.request?.()
      const current = this.present(this.queue[0]!)
      this.shown = current.length ? [...this.pending, this.queue[0]!] : [...this.pending]
      return [...this.pending.map(turn => turn.element), ...current]
    } catch (error) {
      // Committed work is never left unseen: the tiles take all of it.
      console.error('Galta ink pen failed; showing its work at once', error)
      this.dispose()
      return []
    }
  }

  /** Let `turns` go: the tiles paint them in this render, in one pass. */
  private bake(turns: readonly Turn[]) {
    if (!turns.length) return
    const baked = new Set(turns)
    for (const { element } of turns) this.held.delete(element.id)
    this.queue = this.queue.filter(turn => !baked.has(turn))
    this.pending = this.pending.filter(turn => !baked.has(turn))
    this.hold.version++
  }

  /** One render of landing everything: what was on screen bakes as it was
   * shown; once nothing shown remains, the rest lets go together. */
  private land(): readonly ExcalidrawElement[] {
    if (this.shown.length) this.bake(this.shown)
    else this.bake([...this.pending, ...this.queue])
    this.shown = []
    if (!this.queue.length && !this.pending.length) { this.finishing = false; this.detach(); return [] }
    this.request?.()
    return []
  }

  /** Work the scene no longer has as it was queued (undone, deleted, edited)
   * is not the pen's to land; work something shown now covers lands at once. */
  private forget(scene: readonly ExcalidrawElement[]) {
    let covered = false
    for (let i = scene.length - 1; i >= 0; i--) {
      const element = scene[i]!
      if (element.isDeleted) continue
      if (this.held.has(element.id)) {
        if (covered) { this.finish(); return }
      } else covered = true
    }
    const current = new Map(scene.map(element => [element.id, element]))
    const same = ({ element }: Turn) => {
      const now = current.get(element.id)
      return now !== undefined && !now.isDeleted && now.version === element.version && now.versionNonce === element.versionNonce
    }
    const queue = this.queue.filter(same), pending = this.pending.filter(same)
    if (queue.length === this.queue.length && pending.length === this.pending.length) return
    this.queue = queue; this.pending = pending; this.shown = this.shown.filter(same)
    this.held.clear(); for (const { element } of [...queue, ...pending]) this.held.add(element.id)
    this.hold.version++
  }

  private detach() {
    if (this.target) holdStaticElements(this.target, null)
    this.target = undefined; this.request = undefined; this.brush = undefined; this.finishing = false
    const waiting = [...this.waiting]; this.waiting.clear()
    for (const resolve of waiting) resolve()
  }

  /** The part of the stroke under the pen, as a copy of it: same transform,
   * opacity and pixels as the stroke itself, outlined only as far as the pen. */
  private present(turn: Turn): readonly ExcalidrawElement[] {
    const progress = (this.clock - turn.start) / (turn.end - turn.start)
    if (!turn.along || !(progress > 0)) return []
    const element = turn.element as ExcalidrawFreeDrawElement, along = turn.along, total = along[along.length - 1]!
    // A hand sets down slowly, travels, and slows again to lift.
    const reach = total * (1 - Math.cos(Math.PI * Math.min(1, progress))) / 2
    const i = passed(along, reach)
    let tip: [number, number] | undefined, pressure: number | undefined
    if (i < along.length - 1 && along[i + 1]! > along[i]!) {
      const t = (reach - along[i]!) / (along[i + 1]! - along[i]!), [ax, ay] = element.points[i]!, [bx, by] = element.points[i + 1]!
      tip = [ax + (bx - ax) * t, ay + (by - ay) * t]
      if (!element.simulatePressure) pressure = element.pressures[i]! + (element.pressures[i + 1]! - element.pressures[i]!) * t
    }
    if (this.brush?.element !== element) this.brush = { element, playback: createFreeDrawPlayback(element), copy: { ...element } }
    presentFreeDrawElement(this.brush.copy, this.brush.playback.path(i + 1, tip, pressure))
    return [this.brush.copy]
  }
}

/**
 * The live canvas's pen. An edit's new work lands after the edits still
 * landing. The user's hand on the canvas lands everything at once, as do hiding
 * the page and stopping the request. A stroke out of view takes its turn
 * without being drawn: it is there when the camera arrives.
 */
export class InkPresentation {
  private readonly pen: InkPen
  private readonly stop: () => void
  /** `editor` holds the engine: its static canvas and the user's input. */
  constructor(api: ExcalidrawImperativeAPI, editor: HTMLElement) {
    this.pen = new InkPen(api, () => editor.querySelector<HTMLCanvasElement>(':scope > .excalidraw canvas.excalidraw__canvas.static'))
    const finish = () => this.pen.finish()
    editor.addEventListener('pointerdown', finish, true)
    editor.addEventListener('keydown', finish, true)
    this.stop = () => {
      editor.removeEventListener('pointerdown', finish, true)
      editor.removeEventListener('keydown', finish, true)
    }
  }

  show(elements: readonly ExcalidrawElement[], previous: { has(id: string): boolean }, view: Bounds, work: CanvasWork) {
    if (work.signal.aborted) return
    if (!this.pen.draw(newWork(elements, previous), view).size) return
    const abort = () => this.pen.finish()
    work.signal.addEventListener('abort', abort, { once: true })
    void this.pen.drawn().then(() => work.signal.removeEventListener('abort', abort))
  }

  clear() { this.pen.finish() }

  dispose() { this.stop(); this.pen.dispose() }
}
