import { bindLinearElement, newElementWith, redrawTextBoundingBox, updateBoundElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, ExcalidrawTextElement, NonDeletedSceneElementsMap } from '@excalidraw/excalidraw/element/types'

const textContainerTypes = new Set(['rectangle', 'ellipse', 'diamond', 'arrow'])
const arrowTargetTypes = new Set(['rectangle', 'ellipse', 'diamond', 'image', 'text', 'frame', 'embeddable', 'iframe'])
const nativeMap = (elements: readonly ExcalidrawElement[]) => new Map(elements.filter(el => !el.isDeleted).map(el => [el.id, el])) as NonDeletedSceneElementsMap

/** Called only on the planner's detached draft. Native algorithms may mutate
 * related elements; the live scene is untouched until the whole edit commits. */
export function bindArrow(elements: ExcalidrawElement[], elementId: string, endpoints: { start?: string | null; end?: string | null }) {
  const arrow = elements.find(el => el.id === elementId)
  if (arrow?.type !== 'arrow') throw new Error('bind_arrow requires an arrow element')
  const map = nativeMap(elements)
  for (const end of ['start', 'end'] as const) {
    const id = endpoints[end]
    if (id === undefined) continue
    const target = id === null ? undefined : map.get(id)
    if (id !== null && (!target || !arrowTargetTypes.has(target.type) || (target.type === 'text' && target.containerId))) throw new Error(`Invalid arrow binding target: ${id}`)
    const key = end === 'start' ? 'startBinding' : 'endBinding'
    Object.assign(arrow, newElementWith(arrow, { [key]: null }))
    if (target) bindLinearElement(arrow, target as Parameters<typeof bindLinearElement>[1], end, map)
  }
  // Rebinding one endpoint must retain the reverse link for the other endpoint.
  for (const el of elements) {
    const linked = arrow.startBinding?.elementId === el.id || arrow.endBinding?.elementId === el.id
    const had = el.boundElements?.some(b => b.id === arrow.id) ?? false
    if (linked !== had) Object.assign(el, newElementWith(el, { boundElements: [...(el.boundElements ?? []).filter(b => b.id !== arrow.id), ...(linked ? [{ id: arrow.id, type: 'arrow' as const }] : [])] }))
  }
}

export function bindText(elements: ExcalidrawElement[], elementId: string, containerId: string | null) {
  const text = elements.find(el => el.id === elementId)
  if (text?.type !== 'text') throw new Error('bind_text requires a text element')
  const container = containerId === null ? null : elements.find(el => el.id === containerId)
  if (containerId !== null && (!container || !textContainerTypes.has(container.type))) throw new Error(`Invalid text container: ${containerId}`)
  if (container?.boundElements?.some(b => b.type === 'text' && b.id !== text.id)) throw new Error('A container can bind only one text element; use a group for multiple text blocks')
  if (container && elements.some(el => el.type === 'arrow' && (el.startBinding?.elementId === text.id || el.endBinding?.elementId === text.id))) throw new Error('Rebind or detach arrows targeting this text before putting it in a container')
  for (const el of elements) {
    if (el.id === containerId || el.boundElements?.some(b => b.id === text.id)) Object.assign(el, newElementWith(el, { boundElements: [...(el.boundElements ?? []).filter(b => b.id !== text.id), ...(el.id === containerId ? [{ id: text.id, type: 'text' as const }] : [])] }))
  }
  Object.assign(text, newElementWith(text, { containerId, ...(!container ? { text: text.originalText, autoResize: true } : {}) }))
  redrawTextBoundingBox(text, container ?? null, nativeMap(elements), false)
  if (container) updateBoundElements(container, nativeMap(elements))
  else updateBoundElements(text, nativeMap(elements))
  if (container && elements.indexOf(text) < elements.indexOf(container)) {
    elements.splice(elements.indexOf(text), 1)
    elements.splice(elements.indexOf(container) + 1, 0, text)
    // Native snapshot preparation assigns a valid fractional ordering index.
    Object.assign(text, newElementWith(text, { index: null }))
  }
}

/** Geometry changes and text changes share Excalidraw's own relationship
 * update path, including rotated nodes, arrow labels and wrapped text. */
export function refreshRelationships(elements: ExcalidrawElement[], changedIds: ReadonlySet<string>) {
  const map = nativeMap(elements)
  const affected = new Set(changedIds)
  for (const el of elements) {
    if (el.isDeleted || el.type !== 'text') continue
    if (!changedIds.has(el.id) && (!el.containerId || !changedIds.has(el.containerId))) continue
    const container = el.containerId ? map.get(el.containerId) : null
    redrawTextBoundingBox(el as ExcalidrawTextElement, container ?? null, map, false)
    if (container) affected.add(container.id)
  }
  const simultaneous = elements.filter(el => changedIds.has(el.id))
  for (const id of affected) {
    const el = map.get(id)
    if (el) updateBoundElements(el, map, { simultaneouslyUpdated: simultaneous })
  }
}

/** A target keeps its ordinary single-element meaning. Group operations and
 * semantic observation expand only the requested native ownership closure. */
export function relatedElementIds(elements: readonly ExcalidrawElement[], ids: readonly string[], groups: boolean): Set<string> {
  const result = new Set(ids)
  const groupIds = new Set(groups ? elements.filter(el => result.has(el.id)).flatMap(el => el.groupIds) : [])
  for (const el of elements) if (el.groupIds.some(id => groupIds.has(id))) result.add(el.id)
  let size = -1
  while (size !== result.size) {
    size = result.size
    for (const el of elements) {
      if ((el.frameId && result.has(el.frameId)) || (el.type === 'text' && el.containerId && result.has(el.containerId))) result.add(el.id)
    }
  }
  return result
}

export function removeElement(elements: ExcalidrawElement[], id: string): ExcalidrawElement[] {
  return elements.filter(el => el.id !== id).map(el => {
    const patch: Record<string, unknown> = {}
    if (el.boundElements?.some(b => b.id === id)) patch.boundElements = el.boundElements.filter(b => b.id !== id)
    if (el.frameId === id) patch.frameId = null
    if (el.type === 'text' && el.containerId === id) patch.containerId = null
    if (el.type === 'arrow') {
      if (el.startBinding?.elementId === id) patch.startBinding = null
      if (el.endBinding?.elementId === id) patch.endBinding = null
    }
    return Object.keys(patch).length ? newElementWith(el, patch) : el
  })
}

export function validateGroupHierarchy(elements: readonly ExcalidrawElement[]) {
  const parents = new Map<string, string | null>()
  for (const el of elements) for (const [index, group] of el.groupIds.entries()) {
    const parent = el.groupIds[index + 1] ?? null
    if (parents.has(group) && parents.get(group) !== parent) throw new Error(`Group ${group} has inconsistent nesting; update all members together`)
    parents.set(group, parent)
  }
}
