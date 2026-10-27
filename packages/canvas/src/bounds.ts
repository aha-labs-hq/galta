import { z } from 'zod'

export const canvasBoundsSchema = z.strictObject({
  x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative()
}).describe('Axis-aligned geometric bounds in canvas world coordinates, including rotation. x is the left edge; y is the top edge; x increases rightward and y downward. Engine geometry, not painted contours, clipping or visibility.')

export type CanvasBounds = z.infer<typeof canvasBoundsSchema>

export const CANVAS_COORDINATE_INSTRUCTIONS = 'Element bounds are axis-aligned world coordinates for spatial relations. Top-level element x/y, width/height and rotation are native edit fields; a path origin need not be its top-left corner. Bounds do not establish appearance; use the supplied preview or canvas_capture for pixels.'
