import { getFreeDrawSvgPath } from '@excalidraw/excalidraw/freeDrawPath'
import type { BrushRequest } from './previewGeometry'

self.onmessage = ({ data }: MessageEvent<BrushRequest>) => {
  try {
    const points = Array.from({ length: data.coordinates.length / 2 }, (_, i) => [data.coordinates[i * 2]!, data.coordinates[i * 2 + 1]!])
    const path = getFreeDrawSvgPath({ ...data, points, pressures: Array.from(data.pressures) })
    self.postMessage({ path })
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}
