import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react'
import { CaptureUpdateAction, getCommonBounds, newElementWith } from '@excalidraw/excalidraw'
import { AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal, AlignStartVertical, AlignCenterVertical, AlignEndVertical, ArrowDownToLine, ArrowUpRight, Ellipsis } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSceneSelection } from './useSceneSelection'
import { tidySelectedImages } from './tidy'
import type { CanvasScene } from './scene'
import type { ImageReplacement } from './imageImport'
import { SelectionExportActions, SelectionPngExport } from './SelectionExportActions'
import { htmlDocument } from './htmlEmbed'
import { DrawingStyle } from './DrawingStyle'
import './selection-actions.css'
import { arrangeImages, type ImageArrangement } from './arrangeImages'
import { activateVideo, videoData } from './video'

const alignments = [
  ['left', 'Align left', AlignStartVertical], ['center', 'Align centers horizontally', AlignCenterVertical], ['right', 'Align right', AlignEndVertical],
  ['top', 'Align top', AlignStartHorizontal], ['middle', 'Align centers vertically', AlignCenterHorizontal], ['bottom', 'Align bottom', AlignEndHorizontal]
] as const

function focusPopover(event: Event) {
  // Pointer opening focuses the panel without painting its first action as a
  // keyboard choice. Tab enters the list; keyboard opening starts at item one.
  if (document.activeElement?.matches(':focus-visible')) return
  event.preventDefault()
  ;(event.target as HTMLElement).focus({ preventScroll: true })
}

function keepFocusVisible(event: FocusEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement, content = event.currentTarget
  if (!content.contains(target)) return
  const box = target.getBoundingClientRect(), frame = content.getBoundingClientRect()
  if (box.bottom > frame.bottom) content.scrollTop += box.bottom - frame.bottom + 8
  else if (box.top < frame.top) content.scrollTop -= frame.top - box.top + 8
}

export function SelectionActions({ scene, onEdit, onReplace, onOpenPage, onError }: {
  scene: CanvasScene
  onEdit: (edit: () => void) => void
  onReplace: (file: File, target: ImageReplacement) => Promise<void>
  onOpenPage: (elementId: string) => Promise<void>
  onError: (message: string) => void
}) {
  const { selected, state } = useSceneSelection(scene)
  const anchor = useRef<HTMLDivElement>(null), bar = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLDivElement>(null)
  const exportFocus = useRef<'pointer' | 'keyboard' | null>(null)
  const [barSize, setBarSize] = useState({ width: 192, height: 42 })
  const fileInput = useRef<HTMLInputElement>(null)
  const replacement = useRef<ImageReplacement | null>(null)
  const [open, setOpen] = useState<'more' | 'export' | 'style' | null>(null)
  const focusCanvas = () => anchor.current?.closest('.galta-shell')?.querySelector<HTMLElement>('.excalidraw')?.focus({ preventScroll: true })
  const focusPrimary = () => requestAnimationFrame(() => {
    const primary = bar.current?.querySelector<HTMLButtonElement>('button')
    if (primary) primary.focus({ preventScroll: true })
    else focusCanvas()
  })
  const crop = (id: string | null) => {
    // Changing tools is not a document edit; the engine captures the crop gesture.
    scene.api.updateScene({ appState: { croppingElementId: id, isCropping: false }, captureUpdate: CaptureUpdateAction.NEVER })
    setOpen(null); focusPrimary()
  }
  const nativeEdit = (action: 'group' | 'ungroup' | 'deleteSelectedElements') => {
    // Native actions own nested groups, bound text, frame membership and undo.
    try { scene.api.executeAction(action) }
    catch (error) { onError(error instanceof Error ? error.message : 'Unable to edit this selection.'); return }
    setOpen(null); focusPrimary()
  }
  const closeExport = () => {
    setOpen(null)
    requestAnimationFrame(() => bar.current?.querySelector<HTMLButtonElement>('.selection-export-trigger')?.focus({ preventScroll: true }))
  }
  const [padding, setPadding] = useState({ top: 88, bottom: 104, left: 72, right: 80 })
  useLayoutEffect(() => {
    const shell = anchor.current?.closest('.galta-shell')
    if (!shell) return
    const update = () => {
      const rect = (shell.querySelector('.galta-workspace') ?? shell).getBoundingClientRect()
      const top = shell.querySelector('.galta-topbar')?.getBoundingClientRect()
      const bottom = shell.querySelector('.conversation-dock')?.getBoundingClientRect()
      const tools = shell.querySelector('.drawing-dock')?.getBoundingClientRect()
      setPadding({ top: (top?.bottom ?? rect.top + 80) + 8, bottom: window.innerHeight - (bottom?.top ?? rect.bottom - 96) + 12, left: (tools?.right ?? rect.left) + 12, right: window.innerWidth - rect.right + 12 })
    }
    const observer = new ResizeObserver(update)
    observer.observe(shell)
    // Insets can resize the sibling dock during composer delivery. Observe its
    // inner viewport so that notification follows the shallower layout inputs
    // in the same pre-paint cycle rather than being skipped as a peer resize.
    for (const element of shell.querySelectorAll('.galta-workspace,.galta-topbar,.conversation-dock,.drawing-tools')) observer.observe(element)
    update()
    return () => observer.disconnect()
  }, [scene, Boolean(selected.length)])
  const one = selected.length === 1 ? selected[0] : undefined
  const images = selected.length > 0 && selected.every(el => el.type === 'image')
  const image = one?.type === 'image', video = one && videoData(one), html = one && htmlDocument(one)
  const groups = new Set(Object.keys(state.selectedGroupIds).filter(id => state.selectedGroupIds[id]))
  const ids = new Set(selected.map(el => el.id))
  const roots = selected.filter(el => !(el.type === 'text' && el.containerId && ids.has(el.containerId)))
  const commonGroup = roots[0]?.groupIds.some(id => roots.every(el => el.groupIds.includes(id)))
  const canGroup = roots.length > 1 && !commonGroup && !selected.some(el => el.frameId && ids.has(el.frameId))
  const multipleImages = images && selected.length > 1
  const showStyle = !image && !video && !html && !multipleImages
  const startVideo = () => { focusCanvas(); activateVideo(scene, one!) }
  const replace = () => {
    replacement.current = { id: one!.id, versionNonce: one!.versionNonce, restorationVersion: scene.restorationVersion }
    fileInput.current?.click(); setOpen(null)
  }
  const arrangement = <>
    <div className="selection-alignments" role="group" aria-label="Align images">{alignments.map(([action, label, Icon]) => <Tooltip key={action}><TooltipTrigger asChild><Button variant="ghost" size="icon-compact" aria-label={label} onClick={() => onEdit(() => arrangeImages(scene, action))}><Icon /></Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>)}</div>
    {([['horizontal', 'Distribute horizontally'], ['vertical', 'Distribute vertically']] as const).map(([action, label]) => <Button key={action} variant="ghost" size="compact" disabled={selected.length < 3} className="selection-menu-row" onClick={() => onEdit(() => arrangeImages(scene, action as ImageArrangement))}>{label}</Button>)}
  </>
  const [x1, y1, x2, y2] = selected.length ? getCommonBounds(selected) : [0, 0, 0, 0]
  const x = (x1 + state.scrollX) * state.zoom.value, y = (y1 + state.scrollY) * state.zoom.value
  const width = (x2 - x1) * state.zoom.value, height = (y2 - y1) * state.zoom.value
  const hasRoom = window.innerHeight - padding.bottom - barSize.height >= padding.top && window.innerWidth - padding.right - barSize.width >= padding.left
  const shown = hasRoom && selected.length > 0 && !state.selectedElementsAreBeingDragged && !state.isResizing && !state.isRotating && !state.isCropping && !state.editingTextElement && state.activeTool.type === 'selection' && x + width > 0 && y + height > 0 && x < state.width && y < state.height
  const selectionKey = selected.map(el => el.id).join(',')
  useLayoutEffect(() => { setOpen(null) }, [shown, selectionKey])
  const exporting = open === 'export'
  useLayoutEffect(() => {
    if (!row.current || !bar.current) return
    const update = () => {
      // Measure the natural contents, never the animating shell. Its center and
      // height stay put as the shell follows the new row's width.
      const box = row.current!.getBoundingClientRect(), border = parseFloat(getComputedStyle(bar.current!).borderLeftWidth) * 2
      const width = box.width + border, height = box.height + border
      setBarSize(previous => previous.width === width && previous.height === height ? previous : { width, height })
    }
    const observer = new ResizeObserver(update)
    observer.observe(row.current); update()
    return () => observer.disconnect()
  }, [shown, exporting])
  useLayoutEffect(() => {
    if (!exporting || !exportFocus.current) return
    const target = exportFocus.current === 'keyboard' ? row.current?.querySelector<HTMLElement>('[data-format]') : row.current
    target?.focus({ preventScroll: true }); exportFocus.current = null
  }, [exporting])
  useEffect(() => {
    if (!exporting) return
    const dismiss = (event: PointerEvent) => { if (!bar.current?.contains(event.target as Node)) setOpen(null) }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [exporting])
  const center = Math.max(padding.left + barSize.width / 2, Math.min(x + state.offsetLeft + width / 2, window.innerWidth - padding.right - barSize.width / 2))
  const ceiling = padding.top, floor = window.innerHeight - padding.bottom - barSize.height
  const above = y + state.offsetTop - barSize.height - 12, below = y + state.offsetTop + height + 12
  const top = Math.max(ceiling, Math.min(above >= ceiling ? above : below <= floor ? below : ceiling, floor))
  return <><input ref={fileInput} type="file" accept={video ? 'video/*' : 'image/*'} hidden aria-label={video ? 'Replace selected video' : 'Replace selected image'} onChange={event => {
    const file = event.target.files?.[0], target = replacement.current
    event.target.value = ''; replacement.current = null
    if (file && target) void onReplace(file, target).catch(error => onError(String(error)))
  }} /><div ref={anchor} className="pointer-events-none absolute" style={{ left: center - state.offsetLeft, top: top - state.offsetTop, width: 0, height: 0, zIndex: 'var(--layer-context)' }}>
    {shown && <div ref={bar} role="group" className="selection-actions glass-surface text-popover-foreground" aria-label="Selection actions" style={{ width: barSize.width }} onKeyDownCapture={event => {
      if (exporting && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeExport() }
    }} onBlurCapture={event => { if (exporting && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(null) }}>
      <div ref={row} key={exporting ? 'export' : 'actions'} className={`selection-actions-row ${exporting ? 'selection-export' : ''}`} data-view={exporting ? 'export' : 'actions'} role={exporting ? 'group' : undefined} aria-label={exporting ? 'Export formats' : undefined} tabIndex={exporting ? -1 : undefined}>
      {exporting ? <SelectionExportActions key={selectionKey} scene={scene} source={html ? 'html' : video ? 'video' : image ? 'image' : undefined} onBack={closeExport} onError={onError} /> : state.croppingElementId ? <Button variant="ghost" size="compact" onClick={() => crop(null)}>Done cropping</Button> : <>
        {html ? <Button variant="ghost" size="compact" onClick={() => void onOpenPage(one!.id).catch(error => onError(error instanceof Error ? error.message : 'Unable to open this page.'))}>Open<ArrowUpRight className="selection-open-icon" aria-hidden="true" /></Button>
          : multipleImages ? <Button variant="ghost" size="compact" onClick={() => onEdit(() => tidySelectedImages(scene))}>Tidy</Button>
          : showStyle ? <Popover open={open === 'style'} onOpenChange={value => setOpen(value ? 'style' : null)}><PopoverAnchor virtualRef={bar} /><PopoverTrigger asChild><Button variant="ghost" size="compact">Style</Button></PopoverTrigger><PopoverContent align="center" sideOffset={8} collisionPadding={12} onOpenAutoFocus={focusPopover} onFocusCapture={keepFocusVisible} className="selection-popover drawing-style-panel">
            <DrawingStyle scene={scene} state={state} />
          </PopoverContent></Popover>
          : <Button variant="ghost" size="compact" aria-label={video ? 'Play video' : undefined} aria-keyshortcuts={video ? 'Enter' : undefined} disabled={Boolean(video && state.activeEmbeddable?.state === 'active')} onClick={() => image ? crop(one.id) : startVideo()}>{image ? 'Crop' : 'Play'}</Button>}
        <span className="selection-divider" aria-hidden="true" />
        {image || video || html ? <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-compact" className="selection-export-trigger" aria-label="Export selection" onClick={event => { exportFocus.current = event.detail === 0 ? 'keyboard' : 'pointer'; setOpen('export') }}><ArrowDownToLine aria-hidden="true" /></Button></TooltipTrigger><TooltipContent side="top" sideOffset={8}>Export</TooltipContent></Tooltip>
          : <SelectionPngExport key={selected.map(el => `${el.id}:${el.versionNonce}`).join(',')} scene={scene} onError={onError} />}
        <Popover open={open === 'more'} onOpenChange={value => setOpen(value ? 'more' : null)}><PopoverAnchor virtualRef={bar} /><PopoverTrigger asChild><Button variant="ghost" size="icon-compact" className="selection-more" aria-label="More selection actions"><Ellipsis aria-hidden="true" /></Button></PopoverTrigger><PopoverContent side="bottom" align="end" sideOffset={8} collisionPadding={12} onOpenAutoFocus={focusPopover} onFocusCapture={keepFocusVisible} className="selection-popover selection-menu">
          {multipleImages && <>{arrangement}<div className="selection-menu-divider" /></>}
          {(image || video) && <Button variant="ghost" size="compact" className="selection-menu-row" onClick={replace}>Replace {video ? 'video' : 'image'}</Button>}
          {images && <Button variant="ghost" size="compact" className="selection-menu-row" onClick={() => { onEdit(() => { const ids = new Set(scene.selectedIds); scene.replace(scene.elements.map(el => ids.has(el.id) ? newElementWith(el, { angle: (el.angle + Math.PI / 2) as typeof el.angle }) : el)) }); setOpen(null) }}>Rotate right</Button>}
          {canGroup && <Button variant="ghost" size="compact" className="selection-menu-row" onClick={() => nativeEdit('group')}>Group selection</Button>}
          {groups.size > 0 && <Button variant="ghost" size="compact" className="selection-menu-row" onClick={() => nativeEdit('ungroup')}>Ungroup</Button>}
          {(images || video || canGroup || groups.size > 0) && <div className="selection-menu-divider" />}
          <Button variant="ghost" size="compact" className="selection-menu-row text-destructive" onClick={() => nativeEdit('deleteSelectedElements')}>Delete selection</Button>
        </PopoverContent></Popover>
      </>}
      </div>
    </div>}
  </div></>
}
