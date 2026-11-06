import { themeColor } from '../design/theme'

/** The editor's raster layers, in viewport coordinates. Layout is read only
 * after a resize, scroll or layer change, never for each input sample. */
export class CanvasPixels {
  private dirty = true
  private area!: DOMRect
  private layers: { canvas: HTMLCanvasElement; box: DOMRect }[] = []
  private paper = ''
  private resize = new window.ResizeObserver(() => { this.dirty = true })
  private mutation = new window.MutationObserver(() => { this.dirty = true })
  private theme = new window.MutationObserver(() => { this.paper = themeColor('background') })
  constructor(private surface: HTMLElement) {
    this.paper = themeColor('background')
    this.resize.observe(surface)
    this.mutation.observe(surface, { childList: true, subtree: true })
    this.theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    window.addEventListener('resize', this.invalidate)
    window.addEventListener('scroll', this.invalidate, true)
  }
  private invalidate = () => { this.dirty = true }
  get bounds() {
    if (this.dirty) {
      this.area = this.surface.getBoundingClientRect()
      const canvases = [...this.surface.querySelectorAll<HTMLCanvasElement>('.excalidraw__canvas')]
      if (canvases.length !== this.layers.length || canvases.some((canvas, i) => canvas !== this.layers[i]?.canvas)) {
        this.resize.disconnect(); this.resize.observe(this.surface)
        for (const canvas of canvases) this.resize.observe(canvas)
      }
      this.layers = canvases.map(canvas => ({ canvas, box: canvas.getBoundingClientRect() }))
      this.dirty = false
    }
    return this.area
  }
  /** Draw a viewport crop, mapping it into the context's entire backing store. */
  draw(context: CanvasRenderingContext2D, left = this.bounds.left, top = this.bounds.top, width = this.bounds.width, height = this.bounds.height) {
    void this.bounds
    const output = context.canvas, sx = output.width / width, sy = output.height / height
    context.fillStyle = this.paper; context.fillRect(0, 0, output.width, output.height)
    for (const { canvas, box } of this.layers) {
      const x = Math.max(left, box.left), y = Math.max(top, box.top)
      const w = Math.min(left + width, box.right) - x, h = Math.min(top + height, box.bottom) - y
      if (!canvas.width || !canvas.height || w <= 0 || h <= 0 || !box.width || !box.height) continue
      context.drawImage(canvas, (x - box.left) * canvas.width / box.width, (y - box.top) * canvas.height / box.height,
        w * canvas.width / box.width, h * canvas.height / box.height, (x - left) * sx, (y - top) * sy, w * sx, h * sy)
    }
  }
  dispose() {
    this.resize.disconnect(); this.mutation.disconnect(); this.theme.disconnect()
    window.removeEventListener('resize', this.invalidate); window.removeEventListener('scroll', this.invalidate, true)
    this.layers = []
  }
}
