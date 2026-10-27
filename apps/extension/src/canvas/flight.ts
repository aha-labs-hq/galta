/** A view of the canvas: the world point at the centre of the clear frame and
 * the world length its shorter edge spans. The same model `CanvasScene`
 * captures and frames, so a flight ends exactly where framing would. */
export type CanvasView = { center: { x: number; y: number }; span: number }
export type WorldRect = { x: number; y: number; width: number; height: number }
type Size = { width: number; height: number }

// The path's curvature. √2 balances zooming out against travelling, as in
// van Wijk & Nuij, "Smooth and efficient zooming and panning" (2003), and in
// d3.interpolateZoom, whose formulation this follows.
const RHO = Math.SQRT2

/** The smooth path between two views: for a long move it zooms out, travels and
 * zooms back in, so the destination is reached without a blind pan. `length`
 * is the path's natural length; a duration should grow with it. */
export function flightPath(from: CanvasView, to: CanvasView): { at(t: number): CanvasView; length: number } {
  const { x: x0, y: y0 } = from.center, w0 = from.span, { x: x1, y: y1 } = to.center, w1 = to.span
  const dx = x1 - x0, dy = y1 - y0, d2 = dx * dx + dy * dy
  if (d2 < 1e-12) {
    const length = Math.abs(Math.log(w1 / w0)) / RHO, sign = Math.sign(Math.log(w1 / w0))
    return { length, at: t => ({ center: { x: x0, y: y0 }, span: w0 * Math.exp(RHO * t * length * sign) }) }
  }
  const d1 = Math.sqrt(d2)
  const b0 = (w1 * w1 - w0 * w0 + RHO ** 4 * d2) / (2 * w0 * RHO ** 2 * d1)
  const b1 = (w1 * w1 - w0 * w0 - RHO ** 4 * d2) / (2 * w1 * RHO ** 2 * d1)
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1)
  const length = (r1 - r0) / RHO
  return {
    length,
    at: t => {
      const s = t * length, u = w0 / (RHO ** 2 * d1) * (Math.cosh(r0) * Math.tanh(RHO * s + r0) - Math.sinh(r0))
      return { center: { x: x0 + u * dx, y: y0 + u * dy }, span: w0 * Math.cosh(r0) / Math.cosh(RHO * s + r0) }
    }
  }
}

/** Zoom limits shared with the editor's own controls. */
export const MIN_ZOOM = .1, MAX_ZOOM = 5

/** The least camera change that shows `region` in `frame`, keeping `margin`
 * screen pixels clear around it. A region that fits at the current zoom is
 * only travelled to; one that does not fit is zoomed out to; one too small to
 * read at a distant zoom is brought up to actual size, never past it. */
export function frameRegion(region: WorldRect, frame: Size, current: CanvasView, margin: number): CanvasView {
  const shorter = Math.min(frame.width, frame.height)
  const zoom = shorter / current.span
  const fit = Math.min((frame.width - margin * 2) / Math.max(region.width, 1), (frame.height - margin * 2) / Math.max(region.height, 1))
  const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom > fit ? fit : Math.max(zoom, Math.min(1, fit))))
  return { center: { x: region.x + region.width / 2, y: region.y + region.height / 2 }, span: shorter / target }
}

/** The world rectangle the clear frame shows for a view. */
export function visibleRect(view: CanvasView, frame: Size): WorldRect {
  const zoom = Math.min(frame.width, frame.height) / view.span
  const width = frame.width / zoom, height = frame.height / zoom
  return { x: view.center.x - width / 2, y: view.center.y - height / 2, width, height }
}

/** Whether the reader can see `region`: most of it is in view, or it fills
 * most of the view. */
export function inView(region: WorldRect, visible: WorldRect): boolean {
  const width = Math.min(region.x + region.width, visible.x + visible.width) - Math.max(region.x, visible.x)
  const height = Math.min(region.y + region.height, visible.y + visible.height) - Math.max(region.y, visible.y)
  if (width <= 0 || height <= 0) return false
  const shared = width * height
  return shared >= .6 * Math.max(region.width * region.height, 1) || shared >= .5 * visible.width * visible.height
}

/** Which way `region` lies from the view's centre, in degrees clockwise from
 * up, as a screen arrow would point. */
export function bearing(region: WorldRect, view: CanvasView): number {
  const dx = region.x + region.width / 2 - view.center.x, dy = region.y + region.height / 2 - view.center.y
  return (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360
}
