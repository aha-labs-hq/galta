import { useEffect, useState } from 'react'
import { ChevronDown, Minus, Plus, Scan } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { CanvasScene } from './scene'
import { CanvasChromeButton, CanvasChromeSurface } from './CanvasChrome'

/**
 * Zoom and Fit describe the current viewport. The quiet percentage reveals
 * their controls on demand, independently of document history.
 */
export function CanvasViewControls({ scene, side = 'bottom' }: { scene: CanvasScene; side?: 'top' | 'bottom' }) {
  const [state, setState] = useState(scene.api.getAppState)
  useEffect(() => scene.api.onChange((_elements, next) => setState(next)), [scene])
  return <CanvasChromeSurface className="viewport-control flex items-center">
    <Popover>
      <PopoverTrigger asChild><CanvasChromeButton aria-label="Canvas zoom" className="viewport-trigger gap-1 px-1 has-[>svg]:px-1 tabular-nums sm:min-w-16 sm:px-2 sm:has-[>svg]:px-2">
        <span className="viewport-value">{Math.round(state.zoom.value * 100)}%</span><ChevronDown className="hidden size-3 text-(--chrome-muted) sm:block" aria-hidden="true" />
      </CanvasChromeButton></PopoverTrigger>
      <PopoverContent side={side} align="end" sideOffset={8} collisionPadding={12} aria-label="Canvas zoom controls" className="zoom-popover canvas-popover w-52 max-w-[calc(100vw_-_24px)] p-1">
        <div className="zoom-actions flex items-center gap-1">
          <Button variant="ghost" size="icon-compact" aria-label="Zoom out" onClick={() => scene.zoomBy(.8)}><Minus /></Button>
          <Button variant="ghost" size="compact" className="zoom-fit flex-1 justify-center" aria-label="Fit canvas" onClick={() => scene.fit()}><Scan />Fit canvas</Button>
          <Button variant="ghost" size="icon-compact" aria-label="Zoom in" onClick={() => scene.zoomBy(1.25)}><Plus /></Button>
        </div>
      </PopoverContent>
    </Popover>
  </CanvasChromeSurface>
}
