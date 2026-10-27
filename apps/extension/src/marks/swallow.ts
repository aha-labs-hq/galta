import {
  BEAT, EYES, MOUTH_FRACTION, OPEN_MOUTH, ORIGIN_X, ORIGIN_Y, PHASE, VIEW_H, VIEW_W,
  atBeat, faceScale, lipAt, mouthOrigin, shape,
} from './geometry'
import { funnel, type Box, type Point } from './funnel'
import { markup } from './markup'

/* ===========================================================================
   The swallow — one action, one clock.

   The whole gesture is one timeline, stated once and derived everywhere. A
   duration written at a call site is a second source of truth: it drifts from
   the beats it is supposed to describe, and the drift is invisible until
   something looks wrong and nobody can say which number is the real one.

     0.00        rest — the artwork's own pose; the lips start to part
     0.10        commit — the picture starts to flow toward the mouth
     0.14        gather — the body has given back volume and leaned away
     0.30        open — lips wide, the picture funnelling in
     0.66        take — the last of the picture is in; the lips close
     0.76        gulp — lips shut, the body at its fullest
     0.86        rebound — one overshoot, then settle
     1.00        rest again

   Two properties of this are load-bearing and must not be "simplified" later.

   The mouth cannot be a WAAPI animation. An animated `d` attribute is not
   reflected in the DOM — the browser rejects it with a warning per frame and
   paints nothing — so the lip, the eyes and the picture are painted by a rAF
   loop reading the body animation's own `currentTime`. One clock, never two:
   two clocks for one action is how a mouth and a body drift apart.

   Nothing moves in straight lines between poses. A keyframe list interpolated
   linearly has a corner at every pose — the motion visibly changes speed
   there — and that is what made earlier versions read as stiff. The body runs
   through its poses on a smooth curve sampled at frame rate; the picture, the
   mouth and the eyes are smooth functions of the same clock.
   =========================================================================== */

const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
/* 0 to 1 with zero velocity at both ends, so nothing starts or stops with a jolt. */
const smooth = (x: number) => { const k = clamp01(x); return k * k * (3 - 2 * k) }
/* Where `t` is between two beats, as 0–1. */
const span = (t: number, from: number, to: number) => clamp01((t - from) / (to - from))

/* How far the mouth is open, over the action's normalized clock.

   The mouth does exactly three things — part, hold, take — and then it is
   finished. It parts from the first frame, so the click is answered at once,
   and it closes over a beat of its own rather than in one frame: a mouth that
   snaps shut reads as a glitch, not a bite. The gulp belongs to the body: a
   mouth that reopens after the bite is a stutter, not a swallow. Note that 0
   is not a shut mouth; it is the lens the artwork ships, which is where the
   mark comes to rest. */
function openness(t: number): number {
  return smooth(t / PHASE.open) * (1 - smooth(span(t, PHASE.take, PHASE.gulp)))
}

/* Attribute writes that skip the frames where nothing changed.

   The mouth holds wide through the pull and rests after the gulp, and the
   eyes rest at both ends, so those windows would otherwise re-serialize an
   identical string and re-set an identical attribute sixty times a second. */
const written = new WeakMap<Element, Map<string, string>>()

function write(el: Element, attr: string, value: string): void {
  let byAttr = written.get(el)
  if (!byAttr) { byAttr = new Map(); written.set(el, byAttr) }
  if (byAttr.get(attr) === value) return
  byAttr.set(attr, value)
  el.setAttribute(attr, value)
}

/* The body's performance.

   The mark does not travel. It is the anchor the picture is drawn to, and a
   character that walks toward its food is a different creature from one that
   inhales it. So there is no translation here at all: the body turns to face
   what is coming, gives back volume before taking it, swells as it inhales and
   gulps once the last of it is in. Every magnitude is a fraction of the mark's
   own box, so the gesture is the same at 34 px and at 220 px.

   `toward` is the unit vector from the mouth to the picture, so the turn is
   toward whatever it is eating no matter where the picture sat on the page.
   The rotation pivots on the mouth, which is set as the transform origin, so
   the head tilts while the mouth stays where the food is going. */
const LEAN = 9                              // degrees at full turn

const POSES = [
  { at: 0, scale: 1, turn: 0 },
  { at: PHASE.gather, scale: .95, turn: -.35 },
  { at: PHASE.open, scale: 1.03, turn: .7 },
  { at: PHASE.take, scale: 1.10, turn: .45 },
  { at: PHASE.gulp, scale: 1.24, turn: .15 },
  { at: PHASE.rebound, scale: .95, turn: -.07 },
  { at: PHASE.settle, scale: 1.025, turn: .02 },
  { at: 1, scale: 1, turn: 0 },
]

/* A smooth path through stated poses.

   A monotone cubic (Steffen's method): it passes through every pose with
   continuous velocity, never overshoots between two of them — every overshoot
   in the gesture is a pose someone chose — and comes to rest at both ends. */
function through(xs: number[], ys: number[]): (x: number) => number {
  const last = xs.length - 1
  const h = xs.slice(1).map((x, i) => x - xs[i]!)
  const secant = h.map((w, i) => (ys[i + 1]! - ys[i]!) / w)
  const slope = ys.map((_, i) => {
    if (i === 0 || i === last) return 0
    const h0 = h[i - 1]!, h1 = h[i]!, s0 = secant[i - 1]!, s1 = secant[i]!
    const p = (s0 * h1 + s1 * h0) / (h0 + h1)
    return (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), Math.abs(p) / 2)
  })
  return x => {
    let i = 0
    while (i < last - 1 && x > xs[i + 1]!) i++
    const w = h[i]!
    const s = clamp01((x - xs[i]!) / w), s2 = s * s, s3 = s2 * s
    return (2 * s3 - 3 * s2 + 1) * ys[i]! + (s3 - 2 * s2 + s) * w * slope[i]!
      + (3 * s2 - 2 * s3) * ys[i + 1]! + (s3 - s2) * w * slope[i + 1]!
  }
}

/* The body's pose at any moment: the compositor plays it as keyframes, and
   the painter reads the same function to know where the mouth is. */
type Pose = (t: number) => { scale: number; degrees: number }

function poser(toward: Point): Pose {
  const at = POSES.map(p => p.at)
  const scale = through(at, POSES.map(p => p.scale))
  const turn = through(at, POSES.map(p => p.turn))
  return t => ({ scale: scale(t), degrees: toward.x * LEAN * turn(t) })
}

/* The curve, sampled once per display frame. The compositor interpolates
   between neighbouring samples, and at this density that is the curve. */
const FRAME = 1000 / 60

function bodyKeyframes(pose: Pose): Keyframe[] {
  const frames = Math.ceil(BEAT / FRAME)
  return Array.from({ length: frames + 1 }, (_, i) => {
    const { scale, degrees } = pose(i / frames)
    return { offset: i / frames, transform: `scale(${scale.toFixed(4)}) rotate(${degrees.toFixed(2)}deg)` }
  })
}

/* Where a point of the artwork is on the page at a moment of the gesture.

   This is the browser's own arithmetic restated: the SVG fits its viewBox
   into the square control, centred and letterboxed, and the body scales and
   turns about the mouth. Anything drawn against the mouth reads it from
   here, so it lands on the mouth the browser draws at every size and in
   every pose. */
function placement(box: DOMRect, pivot: Point, pose: Pose): (t: number) => (art: number[]) => Point {
  const k = Math.min(box.width / VIEW_W, box.height / VIEW_H)
  const left = box.left + (box.width - VIEW_W * k) / 2
  const top = box.top + (box.height - VIEW_H * k) / 2
  return t => {
    const { scale, degrees } = pose(t)
    const turn = degrees * Math.PI / 180
    const cos = Math.cos(turn) * scale
    const sin = Math.sin(turn) * scale
    return ([x, y]) => {
      const dx = left + (x! - ORIGIN_X) * k - pivot.x
      const dy = top + (y! - ORIGIN_Y) * k - pivot.y
      return { x: pivot.x + cos * dx - sin * dy, y: pivot.y + sin * dx + cos * dy }
    }
  }
}

/* ---------------------------------------------------------------------------
   The picture.

   What flies is a canvas copy of exactly what the page showed: the element's
   own pixels, placed by its own object-fit and object-position, cut by the
   frame it is seen through and rounded by that frame's corners. The first
   frame of the pull is that copy at rest, so hiding the original in the same
   task is invisible, and only one instance of the picture is ever on screen.
   --------------------------------------------------------------------------- */

type Picture = { source: CanvasImageSource; width: number; height: number }

/* What the page is showing for this element, as something a canvas can draw.

   An image draws itself: it is already decoded, and it is the current source
   the page chose, so nothing is fetched. A video shows its poster until it has
   played and its frame after; the poster is the collector's resolved URL. A
   canvas may draw a cross-origin picture — it only may not read it back — so
   this holds on every site. */
async function still(media: HTMLImageElement | HTMLVideoElement, url: string, doc: Document): Promise<Picture | null> {
  if (media instanceof HTMLImageElement) {
    return media.complete ? { source: media, width: media.naturalWidth, height: media.naturalHeight } : null
  }
  if (media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && (media.played.length > 0 || !media.poster)) {
    return { source: media, width: media.videoWidth, height: media.videoHeight }
  }
  const poster = doc.createElement('img')
  poster.src = url
  try { await poster.decode() } catch { return null }
  return { source: poster, width: poster.naturalWidth, height: poster.naturalHeight }
}

const edgeOf = (box: Box) => ({ right: box.left + box.width, bottom: box.top + box.height })

function intersect(a: Box, b: Box): Box {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  return {
    left, top,
    width: Math.min(edgeOf(a).right, edgeOf(b).right) - left,
    height: Math.min(edgeOf(a).bottom, edgeOf(b).bottom) - top,
  }
}

/* Where the picture's pixels land inside its content box, as the browser
   places them. An image that is cropped or letterboxed must fly cropped or
   letterboxed, or the first frame is a different picture. */
function fitted(style: CSSStyleDeclaration, picture: Picture, content: Box): Box {
  const { width: w, height: h } = picture
  const fit = style.objectFit
  if (!w || !h || fit === 'fill') return content
  const contain = Math.min(content.width / w, content.height / h)
  const scale = fit === 'contain' ? contain
    : fit === 'cover' ? Math.max(content.width / w, content.height / h)
      : fit === 'none' ? 1 : Math.min(1, contain)
  const [x = '50%', y = '50%'] = style.objectPosition.split(' ')
  const place = (value: string, free: number) => {
    const n = parseFloat(value)
    if (!Number.isFinite(n)) return free / 2
    return value.endsWith('%') ? free * n / 100 : n
  }
  return {
    left: content.left + place(x, content.width - w * scale),
    top: content.top + place(y, content.height - h * scale),
    width: w * scale,
    height: h * scale,
  }
}

const corners = (style: CSSStyleDeclaration, box: Box): DOMPointInit[] =>
  [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius]
    .map(value => {
      const [x = '0', y = x] = value.split(' ')
      const length = (v: string, of: number) => (parseFloat(v) || 0) * (v.endsWith('%') ? of / 100 : 1)
      return { x: length(x, box.width), y: length(y, box.height) }
    })

/* The frame the picture is seen through: its own box cut by every ancestor
   that clips, rounded by the corners of whichever element is that frame.
   Pinterest rounds a card on a wrapper rather than on the image, and a copy
   with square corners would be a visible swap on the first frame.

   The walk stops below `body`: overflow on the body and the root belongs to
   the viewport, not to their own boxes. */
function framing(media: Element, border: Box, view: Window): { box: Box; radii: DOMPointInit[] } {
  const doc = media.ownerDocument
  const frames: { box: Box; style: CSSStyleDeclaration }[] = [{ box: border, style: view.getComputedStyle(media) }]
  let box: Box = border
  for (let el = media.parentElement; el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
    const style = view.getComputedStyle(el)
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
    const r = el.getBoundingClientRect()
    box = intersect(box, r)
    frames.push({ box: r, style })
  }
  const matches = (a: Box) => [a.left - box.left, a.top - box.top, edgeOf(a).right - edgeOf(box).right, edgeOf(a).bottom - edgeOf(box).bottom]
    .every(d => Math.abs(d) < 1.5)
  for (const frame of frames) {
    if (!matches(frame.box)) continue
    const radii = corners(frame.style, frame.box)
    if (radii.some(r => r.x! > 0 && r.y! > 0)) return { box, radii }
  }
  return { box, radii: [{ x: 0, y: 0 }] }
}

/* The picture as a bitmap in device pixels, aligned to the device grid so the
   copy at rest is pixel for pixel what the page showed. Only the part inside
   the viewport is kept: what the reader could not see cannot fly. */
type Plate = { canvas: HTMLCanvasElement; box: Box }

function plate(media: HTMLElement, picture: Picture, view: Window, dpr: number): Plate | null {
  const style = view.getComputedStyle(media)
  const border = media.getBoundingClientRect()
  const px = (v: string) => parseFloat(v) || 0
  const inset = {
    left: px(style.borderLeftWidth) + px(style.paddingLeft),
    top: px(style.borderTopWidth) + px(style.paddingTop),
    right: px(style.borderRightWidth) + px(style.paddingRight),
    bottom: px(style.borderBottomWidth) + px(style.paddingBottom),
  }
  const content = {
    left: border.left + inset.left,
    top: border.top + inset.top,
    width: border.width - inset.left - inset.right,
    height: border.height - inset.top - inset.bottom,
  }
  const shown = fitted(style, picture, content)
  const frame = framing(media, border, view)
  const viewport = { left: 0, top: 0, width: view.innerWidth, height: view.innerHeight }
  const visible = intersect(intersect(intersect(shown, content), frame.box), viewport)
  if (visible.width <= 0 || visible.height <= 0) return null

  const left = Math.floor(visible.left * dpr)
  const top = Math.floor(visible.top * dpr)
  const canvas = media.ownerDocument.createElement('canvas')
  canvas.width = Math.ceil(edgeOf(visible).right * dpr) - left
  canvas.height = Math.ceil(edgeOf(visible).bottom * dpr) - top
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingQuality = 'high'
  ctx.setTransform(dpr, 0, 0, dpr, -left, -top)
  ctx.beginPath()
  ctx.roundRect(frame.box.left, frame.box.top, frame.box.width, frame.box.height, frame.radii)
  ctx.clip()
  ctx.beginPath()
  ctx.rect(content.left, content.top, content.width, content.height)
  ctx.clip()
  /* A broken image reports itself complete and then refuses to be drawn. */
  try { ctx.drawImage(picture.source, shown.left, shown.top, shown.width, shown.height) } catch { return null }
  return { canvas, box: { left, top, width: canvas.width, height: canvas.height } }
}

/* How thick a band is at rest, in CSS pixels. Each band is a parallelogram
   of one width, so the funnel's edge steps by the change in width from one
   band to the next; at this thickness that step stays under a device pixel
   and the edge reads as a curve. `funnel` bounds the count either side. */
const BAND = 2
/* Each band reaches one device pixel into the next, so antialiased edges
   between neighbours never let the page show through as a hairline. */
const SEAM = 1

/* A band that is still wide stays behind the creature. Once it has narrowed
   to a ribbon it is also drawn in front of the face, so the last of the
   picture is seen going in through the mouth rather than slipping behind the
   head. Between these widths, as shares of the mark's own size, a band fades
   from one to the other, so nothing pops forward. Only a ribbon comes
   forward: a band any wider would lay a sheet of picture over the face. */
const RIBBON = { front: .25, back: .45 }
/* Only picture arriving from beyond the head comes forward, measured from the
   mouth as a share of the mark's size. What the creature was already sitting
   on goes in from beneath it, as it would. */
const BEYOND = .6

type Pour = {
  back: HTMLCanvasElement
  front: HTMLCanvasElement
  /* Draws the picture `progress` of the way in, with `lip` — the mouth's
     outline on the page at this moment — cut out of the front, and returns
     where the picture's middle is, in page pixels, or null once all of it is
     in. */
  paint(progress: number, lip: Point[]): Point | null
}

function canvasAt(doc: Document, dpr: number, box: Box): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = doc.createElement('canvas')
  canvas.className = 'galta-pour'
  canvas.width = box.width
  canvas.height = box.height
  Object.assign(canvas.style, {
    left: `${box.left / dpr}px`, top: `${box.top / dpr}px`,
    width: `${box.width / dpr}px`, height: `${box.height / dpr}px`,
  })
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingQuality = 'high'
  return { canvas, ctx }
}

/* The picture drawn band by band on two canvases. The back one covers the
   picture and the mouth, and nothing the funnel produces leaves that box:
   every band lies between where it was and the mouth. The front one covers
   only the mark's neighbourhood, with room for the body to swell and turn,
   because that is the only place being in front of the creature shows. */
function pour(plate: Plate, mouth: Point, neck: { width: number; height: number }, mark: number, doc: Document, dpr: number): Pour | null {
  const m = { x: mouth.x * dpr, y: mouth.y * dpr }
  const left = Math.floor(Math.min(plate.box.left, m.x))
  const top = Math.floor(Math.min(plate.box.top, m.y))
  const back = canvasAt(doc, dpr, {
    left, top,
    width: Math.ceil(Math.max(edgeOf(plate.box).right, m.x)) - left,
    height: Math.ceil(Math.max(edgeOf(plate.box).bottom, m.y)) - top,
  })
  const reach = mark * dpr
  const face = { left: Math.floor(m.x - reach), top: Math.floor(m.y - reach), width: Math.ceil(2 * reach), height: Math.ceil(2 * reach) }
  const front = canvasAt(doc, dpr, face)
  if (!back || !front) return null
  /* The front canvas's origin, in the back canvas's coordinates. */
  const shift = { x: face.left - left, y: face.top - top }
  const ribbon = { front: RIBBON.front * reach, back: RIBBON.back * reach }

  const { width, height } = plate.box
  const bands = funnel(
    { left: plate.box.left - left, top: plate.box.top - top, width, height },
    { x: m.x - left, y: m.y - top },
    { width: neck.width * dpr, height: neck.height * dpr },
    BAND * dpr,
  )
  const length = bands.axis === 'y' ? height : width
  const arrives = bands.edges.slice(1).map((_, i) => Math.min(bands.distance[i]!, bands.distance[i + 1]!) > BEYOND * reach)
  const forward = (across: number) => 1 - smooth((across - ribbon.front) / (ribbon.back - ribbon.front))
  let done = false

  return {
    back: back.canvas,
    front: front.canvas,
    paint(progress, lip) {
      if (done) return null
      for (const { canvas, ctx } of [back, front]) {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
      }
      if (progress >= 1) { done = true; return null }
      const edges = bands.at(progress)
      /* How far forward each drawn band edge is, along the travel axis. */
      const fade: [number, number][] = []
      let area = 0, along = 0, cross = 0
      for (let i = 0; i < edges.length - 1; i++) {
        const a = edges[i]!, b = edges[i + 1]!
        const depth = b.along - a.along
        if (depth < .01) continue
        const from = bands.edges[i]!
        const slice = bands.edges[i + 1]! - from
        const extent = (seam: number) => Math.min(slice + seam, length - from)
        const across = (a.width + b.width) / 2
        const shear = (b.cross - a.cross) / slice
        /* Each band is a parallelogram: its two edges keep their own centres,
           so the picture's spine bends toward the mouth instead of stepping. */
        const band = (ctx: CanvasRenderingContext2D, dx: number, dy: number) => {
          const run = extent(SEAM)
          if (bands.axis === 'y') {
            ctx.setTransform(across / width, 0, shear, depth / slice, a.cross - across / 2 - dx, a.along - dy)
            ctx.drawImage(plate.canvas, 0, from, width, run, 0, 0, width, run)
          } else {
            ctx.setTransform(depth / slice, shear, 0, across / height, a.along - dx, a.cross - across / 2 - dy)
            ctx.drawImage(plate.canvas, from, 0, run, height, 0, 0, run, height)
          }
        }
        band(back.ctx, 0, 0)

        const low = Math.min(a.cross, b.cross) - across / 2
        const high = Math.max(a.cross, b.cross) + across / 2
        const [x0, x1, y0, y1] = bands.axis === 'y' ? [low, high, a.along, b.along] : [a.along, b.along, low, high]
        const [fa, fb] = [forward(a.width), forward(b.width)]
        if (arrives[i] && Math.max(fa, fb) > 0 && x1 > shift.x && x0 < shift.x + face.width && y1 > shift.y && y0 < shift.y + face.height) {
          band(front.ctx, shift.x, shift.y)
          fade.push([a.along, fa], [b.along, fb])
        }

        const weight = depth * across
        area += weight
        along += weight * (a.along + b.along) / 2
        cross += weight * (a.cross + b.cross) / 2
      }
      const ctx = front.ctx
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      /* The bands are drawn opaque and faded afterwards by one gradient along
         the travel axis, interpolated between their edges. A constant alpha
         per band would step from one band to the next, and the steps read as
         stripes. */
      const first = fade[0]?.[0] ?? 0
      const last = fade.at(-1)?.[0] ?? 0
      if (fade.some(([, f]) => f < 1) && last - first > 1e-3) {
        const o = bands.axis === 'y' ? shift.y : shift.x
        const gradient = bands.axis === 'y'
          ? ctx.createLinearGradient(0, first - o, 0, last - o)
          : ctx.createLinearGradient(first - o, 0, last - o, 0)
        for (const [at, f] of fade) gradient.addColorStop(clamp01((at - first) / (last - first)), `rgba(0,0,0,${f.toFixed(3)})`)
        ctx.globalCompositeOperation = 'destination-in'
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, face.width, face.height)
      }
      /* The mouth is a hole: whatever has reached it is inside. */
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = '#000'
      ctx.beginPath()
      lip.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](p.x * dpr - face.left, p.y * dpr - face.top))
      ctx.closePath()
      ctx.fill()
      ctx.globalCompositeOperation = 'source-over'

      if (area <= 0) return mouth
      const [x, y] = bands.axis === 'y' ? [cross / area, along / area] : [along / area, cross / area]
      return { x: (x + left) / dpr, y: (y + top) / dpr }
    },
  }
}

export type SwallowTarget = {
  /* The element being eaten. It is hidden for the duration and restored after. */
  image: HTMLImageElement | HTMLVideoElement
  /* Where the picture's bytes are, as the collector resolved it. Not re-derived
     from the element: a video's poster is not its `src`. */
  url: string
  /* The element carrying the mark's SVG, inside the surface's shadow root. */
  markEl: HTMLElement
  /* The layers the picture is drawn into: beneath the mark, so the creature
     stays on top of what it is eating, and in front of it, for the ribbon
     going in through the mouth. */
  back: HTMLElement
  front: HTMLElement
  /* The page's document, which owns the elements the gesture creates. */
  document: Document
}

/* Draw the picture into the mouth, then resolve.

   Resolves when the picture is gone, not when the collect has been stored — the
   caller acknowledges on the store's own result. Rejecting is not a thing this
   does: an interrupted animation still cleans up and still restores the page. */
export async function swallow({ image, url, markEl, back, front, document: doc }: SwallowTarget): Promise<void> {
  const wasHidden = image.style.visibility
  const restoreSource = () => { image.style.visibility = wasHidden }

  /* Without motion the mark still answers the click: it opens and stays open
     for the beat it takes the state to land, so the action is confirmed without
     any movement. It shares the page's restoration with the animated path, so
     "the picture always comes back" is stated once. */
  if (reduce()) {
    markEl.innerHTML = markup(1)
    image.style.visibility = 'hidden'
    try {
      await new Promise(resolve => setTimeout(resolve, atBeat(.34)))
    } finally {
      restoreSource()
      markEl.innerHTML = markup(0)
    }
    return
  }

  const view = doc.defaultView ?? window
  const dpr = view.devicePixelRatio || 1
  const from = image.getBoundingClientRect()
  const to = markEl.getBoundingClientRect()

  /* Where the picture has to end up: the mouth, read out of the mark's own
     geometry rather than guessed from a percentage of the box. MOUTH_FRACTION
     says where the mouth is inside the viewBox, and the mark's measured box
     says where the viewBox sits on the page, so the picture arrives at the
     mouth at every size the mark is drawn at. */
  const feed = {
    x: to.left + to.width * MOUTH_FRACTION.x,
    y: to.top + to.height * MOUTH_FRACTION.y,
  }
  /* The picture narrows to the MOUTH, not to a number: "narrow to 3 px" is a
     statement about one particular control, "narrow to the mouth" is a
     statement about the mark. */
  const neck = { width: to.width * OPEN_MOUTH.w, height: to.height * OPEN_MOUTH.h }
  const centre = { x: from.left + from.width / 2, y: from.top + from.height / 2 }
  const reach = Math.hypot(centre.x - feed.x, centre.y - feed.y)
  const toward = reach > 1e-6 ? { x: (centre.x - feed.x) / reach, y: (centre.y - feed.y) / reach } : { x: 0, y: 0 }

  const pose = poser(toward)
  const place = placement(to, feed, pose)
  markEl.style.transformOrigin = mouthOrigin()
  const body = markEl.animate(bodyKeyframes(pose), { duration: BEAT, easing: 'linear', fill: 'both' })
  const lipEl = markEl.querySelector('.galta-mark__lip')

  /* Eyes are what make this a creature rather than a symbol. They lock onto
     the picture, follow it down into the mouth, narrow on the gulp and come
     back to rest, so the reset at the end changes nothing on screen.

     The projection from page pixels into the mark's own units is built from
     the box's own origin and size rather than by re-parsing the viewBox
     string, and it reuses `to` — the mark's measured box. The mark's SVG is
     forced square by CSS (width/height both var(--mark-size)), so the 1.097:1
     viewBox is letterboxed inside it. This introduces a 9.7% vertical scale
     error and a 1.5px offset at 34px, both sub-pixel for the pupil's 3.4-unit
     travel. */
  const toArt = (p: Point) => ({
    x: ORIGIN_X + (p.x - to.left) / (to.width || 1) * VIEW_W,
    y: ORIGIN_Y + (p.y - to.top) / (to.height || 1) * VIEW_H,
  })
  const AIM = 3.4                            // how far the pupil can travel inside the socket
  const gazes = [...markEl.querySelectorAll<SVGGElement>('.galta-mark__gaze')]
    .flatMap((el, i) => EYES[i] ? [{ el, eye: EYES[i]! }] : [])

  const paintEyes = (t: number, food: Point) => {
    const lock = smooth(t / PHASE.gather) * (1 - smooth(span(t, PHASE.gulp, 1)))
    const squint = smooth(span(t, PHASE.take, PHASE.gulp)) * (1 - smooth(span(t, PHASE.gulp, 1)))
    // narrower along the eye axis, much shorter across the face
    const squash = faceScale(1 - .18 * squint, 1 - .62 * squint)
    const art = toArt(food)
    for (const { el, eye } of gazes) {
      const dx = art.x - eye.c[0]!
      const dy = art.y - eye.c[1]!
      const k = AIM / (Math.hypot(dx, dy) || 1) * lock
      write(el, 'transform', `translate(${(dx * k).toFixed(2)} ${(dy * k).toFixed(2)}) ${squash}`)
    }
  }

  let flow: Pour | null = null
  let raf = 0
  const paint = () => {
    const t = Math.min(1, (body.currentTime as number ?? 0) / BEAT)
    const open = openness(t)
    if (lipEl) write(lipEl, 'd', shape(open))
    const pull = span(t, PHASE.commit, PHASE.take)
    /* Without a drawn picture the eyes still travel from it to the mouth. */
    const glide = smooth(pull)
    const food = flow?.paint(pull, lipAt(open).map(place(t)))
      ?? { x: centre.x + (feed.x - centre.x) * glide, y: centre.y + (feed.y - centre.y) * glide }
    paintEyes(t, food)
  }

  /* Whatever happens — including an interrupted animation — the page gets its
     picture back and the canvases are taken out of their layers. */
  try {
    paint()
    raf = requestAnimationFrame(function step() {
      paint()
      if (body.playState !== 'finished') raf = requestAnimationFrame(step)
    })

    /* The original leaves the page in the same task as its copy's first
       frame. For an image that is this turn: the element draws itself. A
       picture that cannot be drawn stays on the page; the mark still eats. */
    const picture = await still(image, url, doc)
    const copy = picture && body.playState !== 'finished' ? plate(image, picture, view, dpr) : null
    flow = copy && pour(copy, feed, neck, to.width, doc, dpr)
    if (flow) {
      back.append(flow.back)
      front.append(flow.front)
      paint()
      image.style.visibility = 'hidden'
    }

    await body.finished
  } finally {
    cancelAnimationFrame(raf)
    flow?.back.remove()
    flow?.front.remove()
    restoreSource()
    markEl.style.transformOrigin = ''
    markEl.innerHTML = markup(0)
  }
}
