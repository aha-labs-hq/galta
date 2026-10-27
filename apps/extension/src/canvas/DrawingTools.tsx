import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { AppState } from '@excalidraw/excalidraw/types'
import { MousePointer2, Hand, Pencil, Eraser, ArrowUpRight, Type, Image, Square, Circle, Diamond, Minus, Frame, PaintbrushVertical, Shapes, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { CanvasScene } from './scene'
import { useCanvasVisible } from './canvasVisibility'
import { DrawingStyle } from './DrawingStyle'
import { DrawingChoices } from './DrawingChoices'
import { toolShortcuts } from './canvasShortcuts'
import './drawing-tools.css'

const primary = [ ['selection', 'Select', MousePointer2], ['hand', 'Hand', Hand], ['freedraw', 'Draw', Pencil], ['eraser', 'Erase', Eraser] ] as const
const secondary = [ ['arrow', 'Arrow', ArrowUpRight] ] as const
const shapes = [ ['rectangle', 'Rectangle', Square], ['ellipse', 'Ellipse', Circle], ['diamond', 'Diamond', Diamond], ['line', 'Line', Minus], ['frame', 'Frame', Frame] ] as const
const paletteTools = [...shapes, ...secondary] as const
const toolButtonClass = 'drawing-tool text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-(--surface-hover) hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 aria-pressed:bg-(--surface-pressed) aria-pressed:text-foreground data-[state=open]:bg-(--surface-pressed) data-[state=open]:text-foreground'
const toolGroupClass = 'drawing-tool-group relative flex w-full shrink-0 flex-col items-center gap-(--dock-gap)'
const laterGroupClass = `${toolGroupClass} before:absolute before:inset-x-2 before:top-[calc(var(--dock-gap)/-2)] before:h-px group-data-[overflow=true]/dock:before:bg-(--graphite-border)`
function ToolButton({ label, shortcut, active, children, onClick }: { label: string; shortcut?: string; active?: boolean; children: React.ReactNode; onClick: () => void }) {
  const visible = useCanvasVisible()
  const name = shortcut ? `${label} — ${shortcut.toUpperCase()}` : label
  return <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-compact" aria-label={name} aria-keyshortcuts={shortcut?.toUpperCase()} aria-pressed={Boolean(active)} onClick={onClick} className={cn(toolButtonClass, active && 'is-active')}>{children}</Button></TooltipTrigger>{visible && <TooltipContent side="right">{name}</TooltipContent>}</Tooltip>
}
export function DrawingTools({ scene, onImport }: { scene: CanvasScene; onImport: (files: File[]) => Promise<void> }) {
  const visible = useCanvasVisible()
  const [moreOpen, setMoreOpen] = useState(false)
  const [styleOpen, setStyleOpen] = useState(false)
  useLayoutEffect(() => {
    if (!visible) { setMoreOpen(false); setStyleOpen(false) }
  }, [visible])
  const [state, setState] = useState(scene.api.getAppState)
  const fileInput = useRef<HTMLInputElement>(null)
  const palette = useRef<HTMLDivElement>(null)
  useEffect(() => scene.api.onChange((_elements, state) => setState(state)), [scene])
  const select = (type: AppState['activeTool']['type']) => scene.api.setActiveTool({ type } as Parameters<typeof scene.api.setActiveTool>[0])
  const activeShape = paletteTools.find(([id]) => state.activeTool.type === id)
  const ShapeIcon = activeShape?.[2] ?? Shapes
  const chooseShape = (type: typeof paletteTools[number][0]) => { select(type); setMoreOpen(false) }
  return <nav data-theme="graphite" className="drawing-dock graphite-surface group/dock" aria-label="Galta tools" style={{ '--dock-tool-count': primary.length + 4, '--dock-group-count': 4 } as React.CSSProperties}>
      {/* Keep the scroll viewport inside the dock's padding so complete rows
          cannot paint cropped controls into that padding. */}
      <div className="drawing-tools absolute inset-x-0 inset-y-(--dock-padding) flex min-h-0 flex-col items-center gap-(--dock-group-gap) overflow-x-hidden overflow-y-auto px-(--dock-padding)" role="toolbar" aria-label="Canvas tools" aria-orientation="vertical">
        <div className={toolGroupClass} role="group" aria-label="Navigate canvas">
          {primary.slice(0, 2).map(([id, label, Icon]) => <ToolButton key={id} label={label} shortcut={toolShortcuts[id]} active={state.activeTool.type === id} onClick={() => select(id)}><Icon /></ToolButton>)}
        </div>
        <div className={laterGroupClass} role="group" aria-label="Draw and write">
          {primary.slice(2).map(([id, label, Icon]) => <ToolButton key={id} label={label} shortcut={toolShortcuts[id]} active={state.activeTool.type === id} onClick={() => select(id)}><Icon /></ToolButton>)}
          <Popover open={moreOpen} onOpenChange={setMoreOpen}><Tooltip><TooltipTrigger asChild><PopoverTrigger asChild><Button type="button" variant="ghost" size="icon-compact" aria-label="Shapes and more tools" aria-pressed={Boolean(activeShape)} className={cn(toolButtonClass, activeShape && 'is-active')}><ShapeIcon /></Button></PopoverTrigger></TooltipTrigger>{visible && <TooltipContent side="right">{activeShape ? `${activeShape[1]} — ${toolShortcuts[activeShape[0]].toUpperCase()}` : 'Shapes and more tools'}</TooltipContent>}</Tooltip>
            {visible && <PopoverContent ref={palette} side="right" align="center" sideOffset={12} collisionPadding={8} aria-label="Shapes and more tools" className="drawing-popover tool-palette" onOpenAutoFocus={event => {
              const current = palette.current?.querySelector<HTMLButtonElement>('.tool-choice[aria-pressed=true]')
              if (current) { event.preventDefault(); current.focus() }
            }} onKeyDown={event => {
              // Engine shortcuts intentionally stop outside its editor. This
              // palette owns its advertised keys while focus is inside it.
              if (event.defaultPrevented || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
              const tool = paletteTools.find(([id]) => toolShortcuts[id] === event.key.toLowerCase())
              if (tool) { event.preventDefault(); event.stopPropagation(); chooseShape(tool[0]) }
            }}>
              <div className="tool-palette-grid" role="group" aria-label="Drawing shapes">{paletteTools.map(([id, label, Icon]) => <Button type="button" key={id} variant="ghost" className="tool-choice" onClick={() => chooseShape(id)} aria-pressed={state.activeTool.type === id} aria-keyshortcuts={toolShortcuts[id].toUpperCase()}>
                <Icon /><span>{label}</span><span className="tool-choice-status" aria-hidden="true"><kbd>{toolShortcuts[id].toUpperCase()}</kbd><Check /></span>
              </Button>)}</div>
              <div className="tool-selection">
                <p className="tool-selection-label">Box selection</p>
                <DrawingChoices label="Box selection" value={state.boxSelectionMode} options={[[ 'overlap', 'Overlap', undefined, 'Include objects the box touches.' ], [ 'contain', 'Wrap', undefined, 'Include fully enclosed objects.' ]]} onChange={mode => scene.api.updateScene({ appState: { boxSelectionMode: mode }, captureUpdate: CaptureUpdateAction.NEVER })} />
              </div>
            </PopoverContent>}</Popover>
          <ToolButton label="Text" shortcut={toolShortcuts.text} active={state.activeTool.type === 'text'} onClick={() => select('text')}><Type /></ToolButton>
        </div>
        <div className={laterGroupClass} role="group" aria-label="Bring in media">
          <ToolButton label="Import media" onClick={() => fileInput.current?.click()}><Image /></ToolButton>
        </div>
        <div className={laterGroupClass} role="group" aria-label="Appearance">
          <Popover open={styleOpen} onOpenChange={setStyleOpen}><Tooltip><TooltipTrigger asChild><PopoverTrigger asChild><Button type="button" variant="ghost" size="icon-compact" aria-label="Drawing style" className={toolButtonClass}><PaintbrushVertical /></Button></PopoverTrigger></TooltipTrigger>{visible && <TooltipContent side="right">Drawing style</TooltipContent>}</Tooltip>
            {visible && <PopoverContent side="right" align="end" sideOffset={12} collisionPadding={8} aria-label="Drawing style" className="drawing-popover drawing-style-panel">
              <DrawingStyle scene={scene} state={state} />
            </PopoverContent>}</Popover>
        </div>
        <input ref={fileInput} type="file" accept="image/*,video/*" multiple hidden onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void onImport(files) }} />
      </div>
    </nav>
}
