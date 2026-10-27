import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { themeLength, themeNumber } from '../design/theme'
import { LightPaints, LIGHT, travel } from './agentLight'
import './dock-surface.css'

/** The attached silhouette turns with the same radius as the expanded
 * conversation sheet it joins, so one surface never shows two corner sizes.
 * The radius is the token's own value; the turn geometry is its fixed multiple,
 * so the silhouette and the CSS controls on it cannot drift apart. A missing
 * token is a configuration error, not a fallback. */
function cornerRadius(): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--radius-dock'))
  if (!Number.isFinite(value) || value <= 0) throw new Error('Galta theme is missing --radius-dock')
  return value
}

// The turn is the same construction at every size: a circular core entered and
// left by cubic ramps that approximate a circular quarter, with tangent joins
// to the straight edges. `turnRatio` is the fixed multiple between the radius
// the silhouette draws and the distance it reaches along each edge, so the
// token alone sets the corner and the geometry cannot restate it.
const coreRatio = .6, turnRatio = 1 / .6

/** One quarter turn reaching `p` along each edge. Local x follows the incoming
 * tangent; local y follows the outgoing one. */
function turn(p: number, x: number, y: number, dx: number, dy: number, sweep: 0 | 1) {
  const radius = p * coreRatio, angle = Math.PI / 6
  const d = radius * (1 - Math.cos(angle)), c = d / Math.tan(angle)
  const b = 3 * Math.hypot(c, d) ** 3 / (2 * d * radius)
  const a = p - radius + radius * Math.sin(angle) - c - b
  const arc = radius * (Math.cos(angle) - Math.sin(angle))
  const sign = sweep ? 1 : -1
  const point = (u: number, v: number) => `${x + u * dx - v * dy * sign} ${y + u * dy + v * dx * sign}`
  return `C ${point(a, 0)} ${point(a + b, 0)} ${point(a + b + c, d)}
    A ${radius} ${radius} 0 0 ${sweep} ${point(a + b + c + arc, d + arc)}
    C ${point(p, p - a - b)} ${point(p, p - a)} ${point(p, p)}`
}

/** The outline of a surface attached to the bottom edge, in three parts that
 * continue one another: the left side from its shoulder, the crown with its two
 * upper corners, and the right side down to its shoulder. `crown` is the radius
 * of the upper corners; zero squares them. `rise` is where the crown meets the
 * sides. */
function outline(width: number, top: number, bottom: number, radius: number, crown: number) {
  const limit = Math.min(width, bottom - top) / 2
  const shoulder = Math.min(radius * turnRatio, limit), corner = Math.min(crown * turnRatio, limit)
  const rise = corner < .5 ? top : top + corner
  return {
    rise,
    left: `M ${-shoulder} ${bottom} ${turn(shoulder, -shoulder, bottom, 1, 0, 0)} L 0 ${rise}`,
    crown: corner < .5 ? `L ${width} ${top}`
      : `${turn(corner, 0, rise, 0, -1, 1)} L ${width - corner} ${top} ${turn(corner, width - corner, top, 1, 0, 1)}`,
    right: `L ${width} ${bottom - shoulder} ${turn(shoulder, width, bottom - shoulder, 0, 1, 0)}`,
  }
}

/** The dock's painted silhouette. The composer body is one filled outline
 * attached to the bottom edge; its crown squares as the reading sheet rises
 * over it, measured from the sheet's height rather than its open state, so
 * every frame of the sheet's motion meets the composer without a notch. The
 * body is drawn from the composer's own top edge, the edge the sheet ends on,
 * so the two meet on the same device pixel however the dock moves; and its
 * rim leaves that seam as the sheet arrives, so glass meets graphite with no
 * line between them. While an agent works, one light travels the edge of the
 * whole dock, around the reading sheet when it is open, lit from within the
 * dock so it never borrows the canvas behind it. Render it after the composer. */
export function DockSurface({ composer, working }: { composer: RefObject<HTMLElement | null>; working: boolean }) {
  const surface = useRef<SVGSVGElement>(null)
  const trace = useRef<SVGSVGElement>(null)
  const materialId = useId()
  // The tokens are immutable for the document's life, and this component
  // mounts after the stylesheets, so one lazy read is the whole lifetime.
  const [radius] = useState(cornerRadius)
  const [reach] = useState(() => themeLength('--agent-light-reach'))
  useLayoutEffect(() => {
    const box = surface.current!, body = composer.current!, dock = trace.current!
    const faces = [...box.querySelectorAll('.dock-surface-fill, .dock-surface-wash')]
    const sides = box.querySelector('.dock-surface-edge')!, crownEdge = box.querySelector<SVGPathElement>('.dock-surface-crown')!
    const edgePaint = box.querySelector(`[id="${materialId}-edge"]`)!, paths = [...dock.querySelectorAll('path')]
    const silhouette = dock.querySelector('.dock-trace-silhouette')!
    let width = 0, height = 0, depth = 0
    const draw = () => {
      const sheet = Math.max(0, height - depth), reach = radius * turnRatio
      const crown = radius * (1 - Math.min(1, sheet / (reach * 2)))
      box.style.height = `${depth}px`
      const body = width > 0 && depth > 0 ? outline(width, 0, depth, radius, crown) : null
      for (const face of faces) face.setAttribute('d', body ? `${body.left} ${body.crown} ${body.right} Z` : '')
      sides.setAttribute('d', body ? `${body.left} M ${width} ${body.rise} ${body.right}` : '')
      crownEdge.setAttribute('d', body ? `M 0 ${body.rise} ${body.crown}` : '')
      crownEdge.style.opacity = String(crown / radius)
      edgePaint.setAttribute('y2', String(depth))
      const whole = width > 0 && height > 0 ? outline(width, 0, height, radius, radius) : null
      const contour = whole ? `${whole.left} ${whole.crown} ${whole.right}` : ''
      for (const each of paths) each.setAttribute('d', contour)
      silhouette.setAttribute('d', contour && `${contour} Z`)
    }
    const size = (entry: ResizeObserverEntry) => entry.borderBoxSize[0]!
    const bounds = dock.getBoundingClientRect()
    width = bounds.width; height = bounds.height; depth = body.getBoundingClientRect().height
    draw()
    // Geometry is paint-only: update every path during resize delivery,
    // before the browser paints the newly sized surface. Scheduling React state
    // here would leave the previous outline visible for a frame.
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === body) depth = size(entry).blockSize
        else { width = size(entry).inlineSize; height = size(entry).blockSize }
      }
      draw()
    })
    observer.observe(dock); observer.observe(body)
    return () => observer.disconnect()
  }, [composer, radius, materialId])
  // The light moves only while the agent works, and holds still as it fades.
  // Without motion, the hairline alone carries the state.
  useEffect(() => {
    if (!working || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const dock = trace.current!
    return travel(dock.querySelector('.agent-light-glow path')!, [...dock.querySelectorAll('radialGradient')],
      themeNumber('--motion-orbit-pace', dock), reach)
  }, [working, reach])
  return <>
    <svg ref={surface} aria-hidden="true" focusable="false" className="dock-surface dock-surface-bottom" style={{ '--dock-graphite-wash': `url(#${materialId}-wash)`, '--dock-graphite-edge': `url(#${materialId}-edge)` } as CSSProperties}>
      <defs>
        <linearGradient id={`${materialId}-wash`} x2="0" y2="1">
          <stop offset="0" className="graphite-wash-light" />
          <stop offset="1" className="graphite-wash-shade" />
        </linearGradient>
        {/* In the body's own space, so the rim's two parts share one light. */}
        <linearGradient id={`${materialId}-edge`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" className="graphite-edge-light" />
          <stop offset="1" className="graphite-edge-shade" />
        </linearGradient>
        <clipPath id={`${materialId}-clip`}><use href={`#${materialId}-body`} /></clipPath>
      </defs>
      <path id={`${materialId}-body`} className="dock-surface-fill" />
      <path className="dock-surface-wash" />
      <path className="dock-surface-edge" clipPath={`url(#${materialId}-clip)`} />
      <path className="dock-surface-edge dock-surface-crown" clipPath={`url(#${materialId}-clip)`} />
    </svg>
    <svg ref={trace} aria-hidden="true" focusable="false" className="dock-trace" data-working={working}>
      <defs>
        <LightPaints id={`${materialId}-light`} reach={reach} />
        <clipPath id={`${materialId}-dock`}><path className="dock-trace-silhouette" /></clipPath>
      </defs>
      <g clipPath={`url(#${materialId}-dock)`}>
        <g className="agent-light-hairline">
          {LIGHT.map(([stroke]) => <path key={stroke} className={`agent-light-${stroke}`} />)}
        </g>
        <g className="agent-light-glow">
          {LIGHT.map(([stroke, paint]) => <path key={stroke} className={`agent-light-${stroke}`} stroke={`url(#${materialId}-light-${paint})`} />)}
        </g>
      </g>
    </svg>
  </>
}
