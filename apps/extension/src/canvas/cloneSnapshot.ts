import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'

/** Native point tuples dominate large drawings. Copy these known numeric
 * payloads directly; use structured clone for extensible element metadata.
 * Every returned array remains detached, including pressures and point tuples.
 */
export function cloneCanvasElement<T extends ExcalidrawElement>(element: T): T {
  if (!('points' in element)) return structuredClone(element)
  const { points, ...metadata } = element
  const copy = structuredClone(metadata)
  return { ...copy, points: points.map(point => [...point]) } as unknown as T
}

export function cloneCanvasSnapshot<T extends { document: unknown }>(snapshot: T): T {
  const document = snapshot.document as { elements?: readonly ExcalidrawElement[]; files?: unknown } | undefined
  if (!Array.isArray(document?.elements)) return structuredClone(snapshot)
  const { document: _, ...metadata } = snapshot
  const { elements, files, ...fields } = document
  return { ...structuredClone(metadata), document: { ...structuredClone(fields), ...(files ? { files: Object.fromEntries(Object.entries(files as Record<string, object>).map(([id, file]) => [id, { ...file }])) } : {}), elements: elements!.map(cloneCanvasElement) } } as unknown as T
}
