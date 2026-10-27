import { CANVAS_MESSAGE_CHARACTERS, CANVAS_MESSAGE_RECORDS, canvasEvidenceSchema, canvasMessageContextSchema, summarizeCanvasEvidence, type CanvasMessage, type CanvasMessageElement, type CanvasToolScope, type CanvasEvidence } from '@galta/canvas'
import type { CreativeConversationTurn, CreativeSession } from '@galta/storage'
import type { CanvasTool } from './canvasTool'
import type { SubmittedContext } from './context'

/** The latest turn whose observation reached the model: it has a provider turn
 * ID and a canvas receipt. It is the baseline for both changes and pixels. */
export function latestObservedTurn(turns: readonly CreativeConversationTurn[]): number {
  for (let index = turns.length - 1; index >= 0; index--) if (turns[index]!.turnId && turns[index]!.context?.canvas) return index
  return -1
}

/** The earlier preview a new message can name instead of resending pixels.
 * The latest observed turn must belong to the thread this message continues
 * and must have seen this exact document and viewport. Compaction drops
 * earlier images from the model's context, so any compaction since that turn
 * requires fresh pixels. */
export function reusablePreview(session: CreativeSession, commitId: string, viewport: CanvasMessage['context']['viewport']): string | undefined {
  const index = latestObservedTurn(session.turns)
  const previous = session.turns[index], canvas = previous?.context?.canvas
  if (!previous || !canvas?.previewEvidenceId || !session.threadId || previous.threadId !== session.threadId) return undefined
  if (canvas.commitId !== commitId || !canvas.viewport || (['x', 'y', 'width', 'height', 'zoom'] as const).some(key => canvas.viewport![key] !== viewport[key])) return undefined
  if (session.turns.slice(index).some(turn => turn.items.some(item => item.type === 'contextCompaction'))) return undefined
  return canvas.previewEvidenceId
}

/** Reuse the tool's projections and renderer, so initial observations and later
 * reads agree on identity, coordinates, coverage and rendering limitations.
 * `unchangedPreview` names an earlier attached preview of this same document
 * and viewport that is still in the conversation; its pixels are not resent. */
export async function prepareCanvasMessage(tool: CanvasTool, submitted: SubmittedContext, commitId: string, scope: CanvasToolScope, unchangedPreview?: string): Promise<CanvasMessage> {
  const read = await tool.execute('canvas_inspect', { scope: 'viewport', limit: CANVAS_MESSAGE_RECORDS }, scope)
  const page = read.structuredContent as { revision: string; elementCount: number; elements: CanvasMessageElement[]; coverage: { total: number }; evidence?: CanvasEvidence }
  const changes = submitted.changes ?? { since: null, status: 'initial' as const, elements: [] }
  const sample = <T>(items: readonly T[], total = items.length) => ({ total, items: items.slice(0, CANVAS_MESSAGE_RECORDS), truncated: total > Math.min(items.length, CANVAS_MESSAGE_RECORDS) })
  const context: CanvasMessage['context'] = {
    commitId, revision: page.revision, viewport: submitted.viewport, elementCount: page.elementCount,
    selection: sample(submitted.selection),
    visible: sample(page.elements.map(({ id, kind, bounds }) => ({ id, kind, bounds })), page.coverage.total),
    changes: { ...sample(changes.elements), since: changes.since, status: changes.status },
    ...(page.evidence ? { evidence: [summarizeCanvasEvidence(canvasEvidenceSchema.parse(page.evidence))] } : {}),
    preview: { status: 'empty', unrenderedCount: 0 }
  }
  let image: CanvasMessage['image']
  if (page.coverage.total && unchangedPreview) context.preview = { status: 'unchanged', evidenceId: unchangedPreview }
  else if (page.coverage.total) {
    let capturedRevision: string | undefined
    try {
      const { x, y, width, height } = context.viewport
      const capture = await tool.execute('canvas_capture', { region: { x, y, width, height }, detail: 'low' }, scope)
      const pixels = capture.content.find(part => part.type === 'image')
      if (!pixels || pixels.type !== 'image') throw new Error('Canvas observation returned no image')
      image = { dataUrl: `data:${pixels.mimeType};base64,${pixels.data}` }
      const metadata = capture.structuredContent as { unrenderedElementIds: string[]; revision: string; evidence?: CanvasEvidence }
      capturedRevision = metadata.revision
      if (metadata.evidence) context.evidence = [...(context.evidence ?? []), summarizeCanvasEvidence(canvasEvidenceSchema.parse(metadata.evidence))].slice(0, 4)
      context.preview = { status: 'attached', unrenderedCount: metadata.unrenderedElementIds.length, ...(metadata.evidence ? { evidenceId: metadata.evidence.id } : {}) }
    } catch (error) {
      scope.signal.throwIfAborted()
      image = undefined
      context.preview = { status: 'unavailable', unrenderedCount: 0, reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) }
    }
    if (capturedRevision !== undefined && capturedRevision !== context.revision) throw new Error('The canvas changed while preparing this message')
  }
  // Long IDs must not defeat the message budget. Full records stay readable
  // through the same selection, viewport and changes scopes.
  const samples = [context.visible, context.changes, context.selection]
  while (JSON.stringify(context).length > CANVAS_MESSAGE_CHARACTERS) {
    const largest = samples.filter(sample => sample.items.length).sort((a, b) => JSON.stringify(b.items).length - JSON.stringify(a.items).length)[0]
    if (!largest) throw new Error('Canvas observation exceeds its message budget')
    largest.items.pop(); largest.truncated = true
  }
  return { context: canvasMessageContextSchema.parse(context), ...(image ? { image } : {}) }
}
