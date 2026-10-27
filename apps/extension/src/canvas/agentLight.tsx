import './agent-light.css'

/** The agent's working light, one implementation wherever the agent works: the
 * dock's edge while a turn runs, and each place it holds on the canvas.
 *
 * The light is an edge lit from within. Each stroke is centred on the outline
 * and clipped to the shape, so it keeps only its inner half and follows the
 * edge exactly, corners included. Painted in order, they leave a pale line one
 * step inside the edge with a darker wash on either side of it: brighter than
 * both neighbours on graphite, on glass and on the canvas alike. CSS owns
 * their colours and widths; each stroke names the paint it takes. */
export const LIGHT = [['wash', 'wash'], ['line', 'line'], ['edge', 'wash']] as const
const PAINTS = ['wash', 'line'] as const
// Along the outline, brightness falls from the light's centre to nothing at
// its reach: each stop's offset and opacity. A long, soft tail with no edge.
const FALLOFF = [[0, 1], [.22, .8], [.5, .36], [.78, .08], [1, 0]] as const

/** The light's paints, `${id}-wash` and `${id}-line`, for strokes in the same
 * user space as the outline that `travel` moves them along. */
export function LightPaints({ id, reach }: { id: string; reach: number }) {
  return PAINTS.map(paint => <radialGradient key={paint} id={`${id}-${paint}`} className={`agent-light-paint-${paint}`} gradientUnits="userSpaceOnUse" r={reach} cx={-reach} cy={-reach}>
    {FALLOFF.map(([offset, opacity]) => <stop key={offset} offset={offset} stopOpacity={opacity} />)}
  </radialGradient>)
}

/** A point on the outline, or on its straight continuation past either end. */
function pointAlong(path: SVGGeometryElement, along: number, length: number) {
  const at = Math.min(Math.max(along, 0), length), point = path.getPointAtLength(at)
  if (at === along || length < 1) return point
  const near = path.getPointAtLength(at === 0 ? 1 : length - 1)
  const scale = (along - at) / Math.hypot(point.x - near.x, point.y - near.y)
  const sign = at === 0 ? -1 : 1
  return { x: point.x + (point.x - near.x) * scale * sign, y: point.y + (point.y - near.y) * scale * sign }
}

/** Carry the light along the outline at an even pace until stopped. The
 * outline's strokes take their paint from radial gradients centred on the
 * light, so it is a glow on the line itself, falling off with no ends. On an
 * open outline it rises a reach before the start and sets a reach past the
 * end, then begins again; a closed outline simply comes round, its end being
 * its start. Either way it never jumps where it can be seen. Progress is a
 * fraction of the lap, so an outline that grows or shrinks carries the light. */
export function travel(contour: SVGGeometryElement, paints: SVGRadialGradientElement[], pace: number, reach: number, closed = false) {
  let progress = 0, last = 0, frame = 0
  const step = (now: number) => {
    const length = contour.getTotalLength(), overrun = closed ? 0 : reach, lap = length + overrun * 2
    // A hidden page schedules no frames; resume where the light was.
    progress = (progress + Math.min(now - (last || now), 100) / 1000 * pace / lap) % 1
    last = now
    const { x, y } = pointAlong(contour, progress * lap - overrun, length)
    for (const paint of paints) { paint.setAttribute('cx', String(x)); paint.setAttribute('cy', String(y)) }
    frame = requestAnimationFrame(step)
  }
  frame = requestAnimationFrame(step)
  return () => cancelAnimationFrame(frame)
}
