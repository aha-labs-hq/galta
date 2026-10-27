import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement, ExcalidrawTextElement, ExcalidrawArrowElement } from '@excalidraw/excalidraw/element/types'

const isText = (element: ExcalidrawElement): element is ExcalidrawTextElement => element.type === 'text'
const includes = (types: readonly string[], type: string) => types.includes(type)
const vectors = ['rectangle', 'ellipse', 'diamond', 'line', 'arrow', 'iframe', 'embeddable']
const filled = ['rectangle', 'ellipse', 'diamond', 'line', 'freedraw', 'iframe', 'embeddable']
const rounded = ['rectangle', 'diamond', 'line', 'image', 'iframe', 'embeddable']
/** undefined means mixed; null remains a real value (no arrowhead). */
function common<T>(values: readonly T[], fallback: T): T | undefined {
  return values.length ? values.every(value => value === values[0]) ? values[0] : undefined : fallback
}

/** Read the engine's live selection, including the text owned by selected containers.
 * Creation defaults are used only when there is no applicable selected object. */
export function drawingStyle(elements: readonly ExcalidrawElement[], state: AppState) {
  const targets = state.editingTextElement ? [elements.find(el => el.id === state.editingTextElement!.id) ?? state.editingTextElement]
    : elements.filter(el => !el.isDeleted && (state.selectedElementIds[el.id] || isText(el) && el.containerId && state.selectedElementIds[el.containerId]))
  const tool = state.activeTool.type
  const supports = (types: readonly string[]) => targets.length ? targets.some(el => includes(types, el.type)) : includes(types, tool)
  const text = targets.filter(isText)
  const arrows = targets.filter((el): el is ExcalidrawArrowElement => el.type === 'arrow')
  const cornerElements = targets.filter(el => includes(rounded, el.type))
  const brush = tool === 'freedraw' && !targets.length || targets.length > 0 && targets.every(el => el.type === 'freedraw')
  const stroke = targets.filter(el => el.type !== 'image' && el.type !== 'frame' && el.type !== 'magicframe')
  const fill = targets.filter(el => includes(filled, el.type))
  const line = targets.filter(el => includes(vectors, el.type))
  const width = targets.filter(el => includes([...vectors, 'freedraw'], el.type))
  return {
    title: targets.length ? targets.length === 1 ? isText(targets[0]!) ? 'Text' : targets[0]!.type === 'image' ? 'Image' : 'Selection' : 'Selection'
      : tool === 'text' ? 'Text' : brush ? 'Brush' : tool === 'arrow' ? 'Arrow' : includes(vectors, tool) ? 'Shape' : 'Style',
    description: targets.length ? 'Applies to your selection' : 'For new objects',
    selectionKey: targets.map(el => el.id).join('|') || tool,
    available: {
      stroke: supports([...vectors, 'freedraw', 'text']),
      width: supports([...vectors, 'freedraw']),
      line: supports(vectors),
      fill: supports(filled),
      corners: supports(rounded),
      text: supports(['text']),
      verticalAlign: text.some(el => el.containerId),
      arrow: supports(['arrow']),
      opacity: targets.some(el => el.type !== 'frame' && el.type !== 'magicframe') || !targets.length && includes([...vectors, 'freedraw', 'text', 'image'], tool)
    },
    values: {
      strokeColor: common(stroke.map(el => el.strokeColor), state.currentItemStrokeColor),
      backgroundColor: common(fill.map(el => el.backgroundColor), state.currentItemBackgroundColor),
      strokeWidth: common(width.map(el => el.strokeWidth), state.currentItemStrokeWidth),
      strokeStyle: common(line.map(el => el.strokeStyle), state.currentItemStrokeStyle),
      roughness: common(line.map(el => el.roughness), state.currentItemRoughness),
      fillStyle: common(fill.map(el => el.fillStyle), state.currentItemFillStyle),
      opacity: common(targets.map(el => el.opacity), state.currentItemOpacity),
      fontFamily: common(text.map(el => el.fontFamily), state.currentItemFontFamily),
      fontSize: common(text.map(el => el.fontSize), state.currentItemFontSize),
      textAlign: common(text.map(el => el.textAlign), state.currentItemTextAlign),
      verticalAlign: common(text.filter(el => el.containerId).map(el => el.verticalAlign), 'middle' as ExcalidrawTextElement['verticalAlign']),
      roundness: common(cornerElements.map(el => el.roundness ? 'round' as const : 'sharp' as const), state.currentItemRoundness),
      startArrowhead: common(arrows.map(el => el.startArrowhead), state.currentItemStartArrowhead),
      endArrowhead: common(arrows.map(el => el.endArrowhead), state.currentItemEndArrowhead),
      arrowType: common(arrows.map(el => el.elbowed ? 'elbow' as const : el.roundness ? 'round' as const : 'sharp' as const), state.currentItemArrowType)
    }
  }
}
export type DrawingStyleValues = { [K in keyof ReturnType<typeof drawingStyle>['values']]: Exclude<ReturnType<typeof drawingStyle>['values'][K], undefined> }

const actions = {
  strokeColor: 'changeStrokeColor', backgroundColor: 'changeBackgroundColor', strokeWidth: 'changeStrokeWidth', strokeStyle: 'changeStrokeStyle',
  roughness: 'changeSloppiness', fillStyle: 'changeFillStyle', opacity: 'changeOpacity', fontFamily: 'changeFontFamily', fontSize: 'changeFontSize',
  textAlign: 'changeTextAlign', verticalAlign: 'changeVerticalAlign', roundness: 'changeRoundness',
  startArrowhead: 'changeArrowhead', endArrowhead: 'changeArrowhead', arrowType: 'changeArrowType'
} as const satisfies Record<keyof DrawingStyleValues, Parameters<ExcalidrawImperativeAPI['executeAction']>[0]>

/** Use the same actions as the editor: font loading, text/container layout, bindings
 * and history remain owned by Excalidraw, rather than approximated with updateScene. */
export function changeDrawingStyle<K extends keyof DrawingStyleValues>(api: ExcalidrawImperativeAPI, property: K, value: DrawingStyleValues[K]) {
  const payload = property === 'strokeColor' ? { currentItemStrokeColor: value }
    : property === 'backgroundColor' ? { currentItemBackgroundColor: value }
    : property === 'fontFamily' ? { currentItemFontFamily: value }
    : property === 'startArrowhead' || property === 'endArrowhead' ? { position: property === 'startArrowhead' ? 'start' : 'end', type: value }
    : value
  api.executeAction(actions[property], payload)
}
