import { useState, useSyncExternalStore } from 'react'
import { themeLength } from '../design/theme'
import type { CanvasLocator } from './agentFocus'
import './agent-mark.css'

/** The agent's light, drawn once around a change it made: it traces the
 * outline, holds, and fades. It stays attached to the change while the camera
 * moves, and is gone when its motion ends. Decoration only: it takes no input
 * and is never document state. */
export function AgentMark({ locator }: { locator: CanvasLocator }) {
  const mark = useSyncExternalStore(locator.subscribeMarks, locator.getMark)
  const [ended, setEnded] = useState<number | null>(null)
  const visible = Boolean(mark && mark.key !== ended)
  // Follow the camera only while the mark is visible.
  useSyncExternalStore(visible ? locator.subscribe : none, locator.getVersion)
  if (!mark || !visible) return null
  const pad = themeLength('--space-2'), box = locator.onSurface(mark.region.bounds)
  const width = box.width + pad * 2, height = box.height + pad * 2
  return <svg key={mark.key} className="agent-mark" aria-hidden="true" focusable="false"
    style={{ left: box.x - pad, top: box.y - pad, width, height }} onAnimationEnd={event => { if (event.animationName === 'agent-mark-life') setEnded(mark.key) }}>
    <g className="agent-mark-life">
      <rect className="agent-mark-tint" x="0" y="0" width={width} height={height} />
      <rect className="agent-mark-wash" x="0" y="0" width={width} height={height} pathLength="1000" />
      <rect className="agent-mark-line" x="0" y="0" width={width} height={height} pathLength="1000" />
    </g>
  </svg>
}
const none = () => () => {}
