import { useRef } from 'react'
import type { CanvasChangeRegion } from '@galta/domain'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useBearing, useLocating } from './agentFocus'
import './agent-locate.css'

/** Takes the reader to where the agent changed the canvas. Its arrow points
 * the way the change lies and turns as the camera moves; when the change is
 * already in view it shows a still point, and pressing it lights the change
 * in place. `away` keeps it hidden unless the change is out of view. It is
 * drawn in the surrounding ink: the light belongs to the canvas. */
export function Locate({ region, away = false, className }: { region: CanvasChangeRegion | undefined; away?: boolean; className?: string }) {
  const locating = useLocating()
  const bearing = useBearing(locating?.locator ?? null, region)
  // Turn the short way round: 350° to 10° is a 20° turn, not 340°.
  const angle = useRef(bearing ?? 0)
  if (bearing !== null) angle.current += ((bearing - angle.current) % 360 + 540) % 360 - 180
  if (!locating || !region || (away && bearing === null)) return null
  const label = bearing === null ? 'Light up the change' : 'Show on canvas'
  return <Tooltip><TooltipTrigger asChild>
    <Button type="button" variant="ghost" size="icon-compact" className={cn('agent-locate', className)} data-away={bearing !== null} aria-label={label} onClick={() => locating.locate(region)}>
      <svg className="agent-locate-glyph" viewBox="0 0 16 16" aria-hidden="true" style={{ rotate: `${angle.current}deg` }}>
        <path className="agent-locate-arrow" d="M8 2.25 12.25 13 8 10.75 3.75 13Z" />
        <circle className="agent-locate-point" cx="8" cy="8" r="2.5" />
      </svg>
    </Button>
  </TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
}
