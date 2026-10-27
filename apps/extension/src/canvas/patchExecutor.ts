import { convertToExcalidrawElements, newElementWith, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { slotBox, validateCanvasOperations, type CanvasOperation, type CanvasSlot, type CanvasToolScope } from '@galta/canvas'
import type { CanvasScene } from './scene'
import { videoData } from './video'
import { replaceMediaElement, type PreparedMediaArtifact } from './mediaArtifact'
import { HTML_EMBED_LINK, htmlDocument } from './htmlEmbed'
import { labelled, labelledKind } from './objectLabel'
import { normalizeFreeDraw } from './freeDraw'
import type { CanvasWork } from './canvasWork'
import { defaultDrawingFont } from './drawingDefaults'
import { bindArrow, bindText, refreshRelationships, relatedElementIds, removeElement, validateGroupHierarchy } from './relationships'

const layoutProperties = new Set(['width', 'height', 'points', 'text', 'originalText', 'fontSize', 'fontFamily', 'lineHeight', 'textAlign', 'verticalAlign', 'autoResize'])

/** Construct and validate the complete next scene before its single update. */
export function applyCreativeOperations(scene: CanvasScene, operations: ReadonlyArray<CanvasOperation>): number {
  scene.applyPrepared(scene.prepare(planCreativeOperations(scene.elements, operations)))
  return operations.length
}

type MediaArtifacts = ReadonlyMap<string, PreparedMediaArtifact>
type Slots = ReadonlyMap<string, CanvasSlot>
type HtmlArtifacts = ReadonlyMap<string, { html: string; generatedPath?: string; executionId: string; provenance?: CanvasToolScope['provenance'] }>

// Both entry points consume the same planner. Synchronous application is used
// by the isolated editor fixtures; agent writes always use cooperative planning.
export function planCreativeOperations(currentElements: readonly ExcalidrawElement[], operations: ReadonlyArray<CanvasOperation>, htmlArtifacts: HtmlArtifacts = new Map(), mediaArtifacts: MediaArtifacts = new Map(), slots: Slots = new Map()): readonly ExcalidrawElement[] {
  const plan = planOperations(currentElements, operations, htmlArtifacts, mediaArtifacts, slots)
  let step = plan.next()
  while (!step.done) step = plan.next()
  return step.value
}

export async function planCreativeOperationsAsync(currentElements: readonly ExcalidrawElement[], operations: ReadonlyArray<CanvasOperation>, htmlArtifacts: HtmlArtifacts, work: CanvasWork, mediaArtifacts: MediaArtifacts = new Map(), slots: Slots = new Map()): Promise<readonly ExcalidrawElement[]> {
  const plan = planOperations(currentElements, operations, htmlArtifacts, mediaArtifacts, slots)
  work.check()
  let step = plan.next()
  while (!step.done) { await work.checkpoint(); step = plan.next() }
  work.check()
  return step.value
}

function* planOperations(currentElements: readonly ExcalidrawElement[], operations: ReadonlyArray<CanvasOperation>, htmlArtifacts: HtmlArtifacts, mediaArtifacts: MediaArtifacts, slots: Slots): Generator<void, readonly ExcalidrawElement[]> {
  if (!operations.length) validateCanvasOperations(operations)
  let elements: ExcalidrawElement[] = []
  const ids = new Set<string>(), filled = new Set<string>()
  for (const element of currentElements) { elements.push(structuredClone(element)); ids.add(element.id); yield }
  for (const [index, op] of operations.entries()) {
    yield
    validateCanvasOperations([op], index)
    const id = 'elementId' in op ? op.elementId : undefined
    let current = id ? elements.find(el => el.id === id) : undefined
    if (id && !current) throw new Error(`operations[${index}].elementId: Canvas object ${id} no longer exists. Read the canvas again to resolve the intended target; do not substitute another object.`)
    if ((op.type === 'create_text' || op.type === 'create_element') && op.id && ids.has(op.id)) throw new Error(`Canvas element id already exists: ${op.id}`)
    // A held place gives a new element its box; the tool ends it once the edit commits.
    const slotId = 'slot' in op ? op.slot : undefined, slot = slotId === undefined ? undefined : slots.get(slotId)
    if (slotId !== undefined && !slot) throw new Error(`operations[${index}].slot: ${slotId} is no longer reserved. Place with geometry instead.`)
    if (slotId !== undefined && filled.has(slotId)) throw new Error(`operations[${index}].slot: ${slotId} is already filled in this edit`)
    if (slotId !== undefined) filled.add(slotId)
    if (op.type === 'bind_arrow') { bindArrow(elements, op.elementId, op); continue }
    if (op.type === 'bind_text') { bindText(elements, op.elementId, op.containerId); continue }
    const { htmlPath, mediaPath, title, caption, ...props } = 'props' in op ? op.props ?? {} : {}
    const words = { title, caption }, worded = title !== undefined || caption !== undefined
    if (worded && current && !labelledKind(current)) throw new Error('A title or caption belongs to a page, image or video')
    if (op.type === 'update_element' && !['line', 'arrow', 'freedraw'].includes(current!.type) && (props.width === 0 || props.height === 0)) throw new Error('Only line, arrow and freedraw elements may have a zero dimension')
    if (op.type === 'update_element' && ['line', 'arrow', 'freedraw'].includes(current!.type) && (props.width !== undefined || props.height !== undefined) && props.points === undefined) throw new Error('Path dimensions come from points; provide points to resize a line, arrow or freedraw element')
    if (current && videoData(current) && Object.hasOwn(props, 'link')) throw new Error('A video owns its resource link; replace it with props.mediaPath.')
    let htmlData: { htmlDocument: { html: string }; generatedPath: string; executionId: string; provenance?: CanvasToolScope['provenance'] } | undefined
    if (typeof htmlPath === 'string') {
      const artifact = htmlArtifacts.get(htmlPath)
      if (!artifact) throw new Error('HTML artifact must be read before preparing the canvas edit')
      if (current && !htmlDocument(current)) throw new Error('HTML replacement requires an existing HTML object')
      htmlData = { htmlDocument: { html: artifact.html }, generatedPath: artifact.generatedPath ?? htmlPath, executionId: artifact.executionId, provenance: artifact.provenance }
    }
    if (typeof mediaPath === 'string') {
      const media = mediaArtifacts.get(mediaPath)
      if (!media) throw new Error('Media artifact must be read before preparing the canvas edit')
      if (media.kind === 'video' && Object.hasOwn(props, 'link')) throw new Error('A video owns its resource link')
      if (op.type === 'create_element') {
        if (op.elementType !== media.kind) throw new Error('The media artifact does not match the requested shape type')
        const width = (props.width as number | undefined) ?? (props.height === undefined ? media.defaultWidth : Number(props.height) * media.width / media.height)
        const height = (props.height as number | undefined) ?? (props.width === undefined ? media.defaultHeight : Number(props.width) * media.height / media.width)
        const box = slot ? slotBox(slot, media) : { width, height, x: op.x ?? media.center.x - width / 2, y: op.y ?? media.center.y - height / 2 }
        const element = newElementWith(media.element, { ...props, ...(worded ? { customData: labelled(media.element.customData, words) } : {}), id: op.id ?? crypto.randomUUID(), ...box, angle: op.rotation ?? 0 } as never)
        elements.push(element); ids.add(element.id); continue
      }
      if (op.type !== 'update_element' || !current) throw new Error('Media replacement requires an existing object')
      current = replaceMediaElement(current, media)
      elements = elements.map(el => el.id === id ? current! : el)
    }
    if (op.type === 'create_text') {
      elements.push(...convertToExcalidrawElements([{ id: op.id ?? crypto.randomUUID(), type: 'text', fontSize: op.size === 's' ? 18 : op.size === 'l' ? 36 : 24, fontFamily: defaultDrawingFont.family, strokeColor: op.color ?? '#39332e', ...props, x: op.x, y: op.y, text: op.text, originalText: op.text, angle: op.rotation ?? 0 }], { regenerateIds: false }))
    } else if (op.type === 'create_element') {
      const box = slot ? slotBox(slot) : { x: op.x, y: op.y, width: op.elementType === 'html' ? 960 : 200, height: op.elementType === 'html' ? 640 : 140 }
      const raw = { id: op.id ?? crypto.randomUUID(), type: op.elementType === 'html' ? 'embeddable' : op.elementType, ...box, ...(op.elementType === 'freedraw' ? { pressures: [], simulatePressure: true } : {}), ...props, angle: op.rotation ?? 0, ...(htmlData ? { link: HTML_EMBED_LINK, customData: labelled(htmlData, words) } : {}) }
      const next = restoreElements([normalizeFreeDraw(raw as unknown as ExcalidrawElement)], null)
      if (next.length !== 1) throw new Error('Invalid Excalidraw element')
      elements.push(...next)
    } else if (op.type === 'delete') {
      elements = removeElement(elements, id!)
      ids.delete(id!)
    } else if (op.type === 'move') {
      const moved = relatedElementIds(elements, [id!], op.scope === 'group')
      if (current!.type === 'text' && current!.containerId && !moved.has(current!.containerId)) throw new Error('Move the text container; bound text follows it')
      const dx = op.x - current!.x, dy = op.y - current!.y
      elements = elements.map(el => moved.has(el.id) ? newElementWith(el, { x: el.x + dx, y: el.y + dy }) : el)
      refreshRelationships(elements, moved)
    } else if (op.type === 'update_element') {
      if (current!.type === 'text' && current!.containerId && (op.x !== undefined || op.y !== undefined || op.rotation !== undefined)) throw new Error('Move or rotate the text container; bound text follows it')
      const content = props.text ?? props.originalText
      if (content !== undefined && current!.type !== 'text') throw new Error('Text updates require a text element')
      if (content === '') { elements = removeElement(elements, id!); ids.delete(id!); continue }
      elements = elements.map(el => el.id === id ? normalizeFreeDraw(newElementWith(el, { ...props, ...(htmlData || worded ? { customData: labelled({ ...el.customData, ...htmlData }, words) } : {}), ...(typeof content === 'string' ? { text: content, originalText: content } : {}), ...(op.x === undefined ? {} : { x: op.x }), ...(op.y === undefined ? {} : { y: op.y }), ...(op.rotation === undefined ? {} : { angle: op.rotation }) } as never)) : el)
      if (op.x !== undefined || op.y !== undefined || op.rotation !== undefined || Object.keys(props).some(key => layoutProperties.has(key))) refreshRelationships(elements, new Set([id!]))
    }
    if (op.type === 'create_text' || op.type === 'create_element') ids.add(elements.at(-1)!.id)
  }
  validateGroupHierarchy(elements)
  return elements
}
