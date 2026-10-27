import { getFreeDrawSvgPath } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { defaultDrawingFont } from './drawingDefaults'
import type { CanvasWork } from './canvasWork'

const ns = 'http://www.w3.org/2000/svg'
/** Decoration time per animation frame, in milliseconds. Artwork has no
 * operation-count limit; this only paces how quickly a batch becomes visible. */
const frameSliceMs = 4
/** Fade applied to each revealed element. Kept short so a large batch reads as
 * growth rather than as a performance. */
const fadeMs = 120
/** Types previewed as an outline: their own appearance needs a native mount. */
const outlineTypes = new Set(['embeddable', 'frame', 'magicframe'])

/** The visible world rectangle. The scene owns the camera that defines it. */
export type Viewport = { x: number; y: number; width: number; height: number }

/** Where a staged element sits in world coordinates. Cheap to compute for every
 * element, so offscreen work is skipped before any node exists. */
type Placement = { cx: number; cy: number; x: number; y: number; radius: number }

/** Disposable ink, never editor state. A committed batch is replayed here for a
 * few frames so it reads as growth instead of one blocking paint. The reveal
 * covers the native elements already committed underneath, so it never delays
 * the transaction and never becomes document state.
 * Decoration is paced per frame; artwork has no operation-count limit. */
export class CanvasPresentation {
  private cleanup: (() => void) | undefined
  constructor(private readonly api: ExcalidrawImperativeAPI, private readonly root: SVGSVGElement) {}

  clear() { this.cleanup?.(); this.cleanup = undefined }

  /** Replay the newly committed elements. `previous` answers "was this element
   * already here?", so only genuinely new objects are staged. `viewport` reads
   * the current visible world rectangle, which can move during the reveal. */
  async show(elements: readonly ExcalidrawElement[], previous: { has(id: string): boolean }, viewport: () => Viewport, work: CanvasWork) {
    this.clear()
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    if (motion.matches || document.hidden) return
    const group = document.createElementNS(ns, 'g')
    const camera = () => {
      const s = this.api.getAppState(), z = s.zoom.value
      this.root.setAttribute('viewBox', `0 0 ${s.width} ${s.height}`)
      group.setAttribute('transform', `scale(${z}) translate(${s.scrollX} ${s.scrollY})`)
    }
    camera()
    this.root.append(group)
    const unsubscribe = this.api.onChange(camera)
    const clear = () => this.clear()
    // Only live animations need cancelling, so finished ones are released along
    // with their nodes instead of being held for the whole reveal.
    const live = new Set<Animation>()
    this.cleanup = () => {
      unsubscribe()
      work.signal.removeEventListener('abort', clear)
      motion.removeEventListener('change', clear)
      live.forEach(animation => animation.cancel())
      group.remove()
    }
    work.signal.addEventListener('abort', clear, { once: true })
    motion.addEventListener('change', clear, { once: true })
    // The native elements are already committed underneath this layer, so the
    // reveal grows over a finished document rather than racing its transaction.
    // The camera subscription keeps it aligned with the live view.
    let start = performance.now()
    let view = viewport()
    for (const element of elements) {
      if (element.isDeleted || previous.has(element.id) || element.opacity === 0) continue
      const placement = this.place(element)
      if (!placement || !group.isConnected) continue
      if (placement.x + placement.radius < view.x || placement.y + placement.radius < view.y || placement.x - placement.radius > view.x + view.width || placement.y - placement.radius > view.y + view.height) continue
      const node = this.draw(element)
      if (!node) continue
      node.setAttribute('transform', `translate(${element.x} ${element.y}) rotate(${element.angle * 180 / Math.PI} ${placement.cx} ${placement.cy})`)
      group.append(node)
      // The committed element is already painted underneath, so this layer only
      // covers it for the length of the fade and then removes itself. Fading
      // from full opacity would double-draw the element and darken it.
      const animation = node.animate([{ opacity: String(element.opacity / 100) }, { opacity: '0' }], { duration: fadeMs, easing: 'ease-out' })
      live.add(animation)
      animation.finished.then(() => { live.delete(animation); node.remove() }, () => undefined)
      if (performance.now() - start < frameSliceMs) continue
      // Yield to a real frame so the batch reads as growth instead of a single
      // paint. The camera may move during the yield, so the view is reread.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      view = viewport()
      start = performance.now()
    }
  }

  /** World-space position and rotation centre. Returns undefined for elements
   * this layer cannot place honestly. */
  private place(element: ExcalidrawElement): Placement | undefined {
    if (element.type === 'text') {
      // A bound text's rendered position is container-relative, which this layer
      // cannot resolve without the editor's element map. Unbound text carries its
      // measured wrapped box, so only that case is placed.
      if (element.containerId) return undefined
      return this.box(element)
    }
    if (element.type === 'freedraw') {
      // Native points are relative to x/y, so the absolute point bounds are also
      // the native rotation centre.
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
      for (const [x, y] of element.points) {
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y)
      }
      const cx = (left + right) / 2, cy = (top + bottom) / 2
      return { cx, cy, x: element.x + cx, y: element.y + cy,
        radius: Math.hypot(right - left, bottom - top) / 2 + element.strokeWidth * 4.25 }
    }
    if (!drawable(element.type)) return undefined
    return this.box(element)
  }

  /** The placement of any element drawn inside its own width and height box. */
  private box(element: ExcalidrawElement): Placement {
    return { cx: element.width / 2, cy: element.height / 2, x: element.x + element.width / 2,
      y: element.y + element.height / 2, radius: Math.hypot(element.width, element.height) / 2 + element.strokeWidth }
  }

  /** Build the staged node. Only types this layer can draw faithfully are
   * previewed; a stand-in never invents content the document does not have. */
  private draw(element: ExcalidrawElement): SVGElement | undefined {
    if (element.type === 'freedraw') return this.node('path', element, { d: getFreeDrawSvgPath(element), fill: element.strokeColor })
    if (element.type === 'text') return element.containerId ? undefined : this.text(element)
    if (!drawable(element.type)) return undefined
    // HTML and video bodies need their native mount; the geometry is the only
    // honest preview. `canvas_inspect` reports the same limitation.
    const box = { x: '0', y: '0', width: String(element.width), height: String(element.height) }
    const attributes = outlineTypes.has(element.type)
      ? { ...box, rx: '8', fill: 'none', 'stroke-dasharray': '6 6' }
      : { ...box, rx: element.roundness ? '8' : '0', fill: element.backgroundColor === 'transparent' ? 'none' : element.backgroundColor }
    const tag = element.type === 'ellipse' ? 'ellipse' : element.type === 'diamond' ? 'polygon' : 'rect'
    return this.node(tag, element, attributes)
  }

  private text(element: ExcalidrawElement & { type: 'text' }) {
    const lineHeight = element.fontSize * element.lineHeight
    const rows = element.text.split('\n')
    const top = element.verticalAlign === 'middle' ? (element.height - rows.length * lineHeight) / 2
      : element.verticalAlign === 'bottom' ? element.height - rows.length * lineHeight : 0
    const offset = element.textAlign === 'center' ? element.width / 2 : element.textAlign === 'right' ? element.width : 0
    const node = this.node('text', element, {
      'font-size': String(element.fontSize), 'font-family': defaultDrawingFont.name,
      fill: element.strokeColor, 'dominant-baseline': 'text-before-edge' })
    rows.forEach((row, index) => {
      const line = document.createElementNS(ns, 'tspan')
      line.setAttribute('x', String(offset))
      line.setAttribute('y', String(top + index * lineHeight))
      line.setAttribute('text-anchor', element.textAlign === 'center' ? 'middle' : element.textAlign === 'right' ? 'end' : 'start')
      line.textContent = row
      node.append(line)
    })
    return node
  }

  /** A staged node carries `data-preview` with its source element type, which
   * test selectors and debugging key on. Its opacity is applied by the caller's
   * fade, so no attribute competes with the animation. */
  private node(tag: string, element: ExcalidrawElement, attributes: Record<string, string>) {
    const value = document.createElementNS(ns, tag)
    value.setAttribute('data-preview', element.type)
    value.setAttribute('stroke', element.strokeColor)
    value.setAttribute('stroke-width', String(element.strokeWidth))
    for (const [key, attribute] of Object.entries(attributes)) value.setAttribute(key, attribute)
    return value
  }
}

/** Types drawn inside their own width and height box, as a shape or an outline. */
function drawable(type: ExcalidrawElement['type']) {
  return type === 'rectangle' || type === 'ellipse' || type === 'diamond' || type === 'image' || type === 'iframe' || outlineTypes.has(type)
}
