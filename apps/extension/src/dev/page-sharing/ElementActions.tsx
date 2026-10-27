import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react'
import { CaptureUpdateAction, getCommonBounds, newElementWith } from '@excalidraw/excalidraw'
import { ArrowUpRight, ChevronDown, Ellipsis } from 'lucide-react'
import { assetBlob } from '@galta/canvas'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { CanvasScene } from '../../canvas/scene'
import { useSceneSelection } from '../../canvas/useSceneSelection'
import { htmlDocument } from '../../canvas/htmlEmbed'
import { activateVideo, videoData } from '../../canvas/video'
import { DrawingStyle } from '../../canvas/DrawingStyle'
import { arrangeImages, type ImageArrangement } from '../../canvas/arrangeImages'
import { exportSelection } from '../../canvas/selectionExport'
import { ShareBody, type ShareModel } from './SharePage'

function keepFocusVisible(event: FocusEvent<HTMLDivElement>) {
  const content = event.currentTarget, target = event.target as HTMLElement
  if (!content.contains(target)) return
  const box = target.getBoundingClientRect(), frame = content.getBoundingClientRect()
  if (box.bottom > frame.bottom) content.scrollTop += box.bottom - frame.bottom + 8
  else if (box.top < frame.top) content.scrollTop -= frame.top - box.top + 8
}
function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/** Local element actions; the original composer remains the request entry. */
export function ElementActions({ scene, model, onUnpublish, onError, boundary }: { scene: CanvasScene; model: ShareModel; onUnpublish(): void; onError(message: string): void; boundary: HTMLElement | null }) {
  const { selected, state } = useSceneSelection(scene)
  const [open, setOpen] = useState<'share' | 'export' | 'more' | 'style' | 'arrange' | null>(null)
  const [saving, setSaving] = useState(false)
  const previous = useRef('')
  const toolbar = useRef<HTMLDivElement>(null)
  const [capsuleSize, setCapsuleSize] = useState({ width: 0, height: 0 })
  const focusPrimary = () => requestAnimationFrame(() => toolbar.current?.querySelector<HTMLElement>('button, a')?.focus())
  const signature = selected.map(el => el.id).join(',')
  const one = selected.length === 1 ? selected[0] : undefined
  const html = one && htmlDocument(one)?.html, video = one && videoData(one)
  const isImage = one?.type === 'image', images = selected.length > 1 && selected.every(el => el.type === 'image')
  const group = selected.length > 1 && selected[0]?.groupIds.at(-1)
  const sameGroup = group && selected.every(el => el.groupIds.includes(group))
  const shown = selected.length > 0 && !state.selectedElementsAreBeingDragged && !state.isResizing && !state.isRotating && !state.editingTextElement && state.activeTool.type === 'selection'
  useEffect(() => { if (!shown || previous.current !== signature) setOpen(null); previous.current = signature }, [shown, signature])
  useLayoutEffect(() => {
    const element = toolbar.current
    if (!element) return
    const measure = () => {
      const { width, height } = element.getBoundingClientRect()
      setCapsuleSize(previous => previous.width === width && previous.height === height ? previous : { width, height })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element); measure()
    return () => observer.disconnect()
  }, [shown])
  if (!shown) return null
  const [x1, y1, x2, y2] = getCommonBounds(selected), z = state.zoom.value
  const left = Math.max(56, Math.min(((x1 + x2) / 2 + state.scrollX) * z - capsuleSize.width / 2, state.width - capsuleSize.width - 12))
  const above = (y1 + state.scrollY) * z - capsuleSize.height - 12
  const below = (y2 + state.scrollY) * z + 12, floor = state.height - 104 - capsuleSize.height
  const top = Math.max(88, Math.min(above >= 88 ? above : below <= floor ? below : 88, floor))
  const crop = (id: string | null) => { scene.api.updateScene({ appState: { croppingElementId: id, isCropping: false }, captureUpdate: CaptureUpdateAction.NEVER }); setOpen(null); focusPrimary() }
  const ungroup = () => { scene.replace(scene.elements.map(el => selected.some(item => item.id === el.id) ? newElementWith(el, { groupIds: el.groupIds.filter(id => id !== group) }) : el)); setOpen(null); focusPrimary() }
  const download = async (original: boolean) => {
    setSaving(true)
    try {
      if (original && one) {
        const id = video?.fileId ?? (one.type === 'image' ? one.fileId : null)
        const file = id ? scene.asset(id) : null
        if (!file) throw new Error('The original file is unavailable.')
        save(assetBlob(file), video?.name ?? `tide.${file.mimeType === 'image/png' ? 'png' : 'jpg'}`)
      } else save(await exportSelection(scene), 'galta-selection.png')
      setOpen(null)
    } catch (error) { onError(error instanceof Error ? error.message : 'Unable to save this selection.') }
    finally { setSaving(false) }
  }
  const primary = html ? 'Open' : video ? 'Play' : isImage ? 'Crop' : sameGroup ? 'Ungroup' : images ? 'Arrange' : 'Style'
  const primaryClick = () => {
    if (video && one) { activateVideo(scene, one); setOpen(null) }
    else if (isImage && one) crop(one.id)
    else if (sameGroup) ungroup()
  }
  const primaryMenu = !html && !video && !isImage && !sameGroup ? images ? 'arrange' : 'style' : null
  return <div ref={toolbar} className="object-edge" role="group" aria-label="Selection actions" style={{ left, top, visibility: capsuleSize.width ? 'visible' : 'hidden' }}>
    <div className="object-actions glass-surface">
      {state.croppingElementId ? <Button variant="ghost" size="compact" onClick={() => crop(null)}>Done cropping</Button> : <>
        {html ? <Button asChild variant="ghost" size="compact"><a href={`${location.pathname}?view=preview`} target="_blank" rel="noreferrer">Open<ArrowUpRight aria-hidden="true" /></a></Button> : primaryMenu ? <Popover open={open === primaryMenu} onOpenChange={value => setOpen(value ? primaryMenu : null)}><PopoverTrigger asChild><Button variant="ghost" size="compact">{primary}<ChevronDown aria-hidden="true" /></Button></PopoverTrigger><PopoverContent align="center" sideOffset={12} collisionBoundary={boundary} collisionPadding={12} onFocusCapture={keepFocusVisible} className={images ? 'element-menu' : 'element-style-panel drawing-style-panel'}>
          {images ? <><p className="element-menu-title">Arrange images</p>{([['left', 'Align left'], ['center', 'Align center'], ['right', 'Align right'], ['horizontal', 'Space evenly']] as const).map(([action, label]) => <Button key={action} variant="ghost" className="element-menu-row" onClick={() => { try { arrangeImages(scene, action as ImageArrangement) } catch (error) { onError(String(error)) } }}>{label}</Button>)}</> : <DrawingStyle scene={scene} state={state} />}
        </PopoverContent></Popover> : <Button variant="ghost" size="compact" onClick={primaryClick}>{primary}</Button>}
        <span className="element-action-divider" aria-hidden="true" />
        <Popover open={open === (html ? 'share' : 'export')} onOpenChange={value => setOpen(value ? html ? 'share' : 'export' : null)}><PopoverTrigger asChild><Button variant="ghost" size="compact" className="page-share-trigger" aria-label={html ? 'Share page' : 'Export selection'}>{html ? 'Share' : 'Export'}<ChevronDown aria-hidden="true" /></Button></PopoverTrigger><PopoverContent align="center" side="bottom" sideOffset={12} collisionPadding={12} collisionBoundary={boundary} onFocusCapture={keepFocusVisible} aria-label={html ? 'Share webpage' : 'Export selection'} className={`delivery-popover p-0${html ? '' : ' element-export-popover'}`}>
          {html ? <ShareBody model={model} html={html} onClose={() => setOpen(null)} onUnpublish={onUnpublish} /> : <div className="delivery-export-options" role="group" aria-label="Export formats">
            {(isImage || video) && <Button variant="ghost" className="delivery-format" disabled={saving} onClick={() => void download(true)}><span>Original file</span><small>{video ? 'Video · full quality' : 'Image · full quality'}</small></Button>}
            <Button variant="ghost" className="delivery-format" disabled={saving} onClick={() => void download(false)}><span>{saving ? 'Saving…' : 'PNG image'}</span><small>{selected.length > 1 ? `${selected.length} elements, together in one image` : video ? 'The cover shown on your canvas' : 'As it looks on the canvas'}</small></Button>
          </div>}
        </PopoverContent></Popover>
        <Popover open={open === 'more'} onOpenChange={value => setOpen(value ? 'more' : null)}><PopoverTrigger asChild><Button variant="ghost" size="icon-compact" className="element-more" aria-label="More selection actions" title="More actions"><Ellipsis aria-hidden="true" /></Button></PopoverTrigger><PopoverContent align="end" sideOffset={12} collisionBoundary={boundary} collisionPadding={12} className="element-menu">
          {isImage && <Button variant="ghost" className="element-menu-row" onClick={() => { scene.replace(scene.elements.map(el => el.id === one.id ? newElementWith(el, { angle: (el.angle + Math.PI / 2) as typeof el.angle }) : el)); setOpen(null) }}>Rotate right</Button>}
          {selected.length > 1 && <Button variant="ghost" className="element-menu-row" onClick={() => { if (sameGroup) ungroup(); else { const id = crypto.randomUUID(), ids = new Set(selected.map(el => el.id)); scene.replace(scene.elements.map(el => ids.has(el.id) ? newElementWith(el, { groupIds: [...el.groupIds, id] }) : el)); setOpen(null) } }}>{sameGroup ? 'Ungroup' : 'Group selection'}</Button>}
          <Button variant="ghost" className="element-menu-row" onClick={() => { const ids = new Set(selected.map(el => el.id)); scene.replace(scene.elements.map(el => ids.has(el.id) ? newElementWith(el, { isDeleted: true }) : el), scene.assets, true, { selectedElementIds: {} }); setOpen(null) }}>Delete<span className="element-shortcut">⌫</span></Button>
        </PopoverContent></Popover>
      </>}
    </div>
  </div>
}
