import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { CanvasSlot } from '@galta/canvas'
import { themeLength, themeNumber } from '../design/theme'
import type { CanvasLocator } from './agentFocus'
import { LightPaints, LIGHT, travel } from './agentLight'
import './canvas-slots.css'

export type ShownSlot = CanvasSlot & { key: string }

/** Where work in progress will land. Each place the agent holds carries its
 * working light around the edge, the same light and pace as the dock while a
 * turn runs, until the result arrives and AgentMark lights the arrival. It
 * follows the camera, takes no input and is never document state. */
export function CanvasSlots({ locator, slots }: { locator: CanvasLocator; slots: readonly ShownSlot[] }) {
  useSyncExternalStore(slots.length ? locator.subscribe : none, locator.getVersion)
  return slots.map(slot => { const box = locator.onSurface(slot); return <HeldPlace key={slot.key} box={box} lit={locator.onScreen(box)} /> })
}

/** Its light moves only while the place is on screen. */
function HeldPlace({ box, lit }: { box: { x: number; y: number; width: number; height: number }; lit: boolean }) {
  const id = useId(), svg = useRef<SVGSVGElement>(null)
  const [reach] = useState(() => themeLength('--agent-light-reach'))
  // Without motion, the hairline alone carries the state.
  useEffect(() => {
    if (!lit || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const root = svg.current!
    return travel(root.querySelector<SVGRectElement>('.agent-light-glow rect')!, [...root.querySelectorAll('radialGradient')], themeNumber('--motion-orbit-pace', root), reach, true)
  }, [reach, lit])
  const shape = { x: 0, y: 0, width: box.width, height: box.height }
  return <svg ref={svg} className="canvas-slot" aria-hidden="true" focusable="false" style={{ left: box.x, top: box.y, width: box.width, height: box.height }}>
    <defs>
      <LightPaints id={`${id}-light`} reach={reach} />
      <clipPath id={`${id}-place`}><rect {...shape} /></clipPath>
    </defs>
    <rect className="canvas-slot-tint" {...shape} />
    <g clipPath={`url(#${id}-place)`}>
      <g className="agent-light-hairline">{LIGHT.map(([stroke]) => <rect key={stroke} className={`agent-light-${stroke}`} {...shape} />)}</g>
      <g className="agent-light-glow">{LIGHT.map(([stroke, paint]) => <rect key={stroke} className={`agent-light-${stroke}`} stroke={`url(#${id}-light-${paint})`} {...shape} />)}</g>
    </g>
  </svg>
}
const none = () => () => {}
