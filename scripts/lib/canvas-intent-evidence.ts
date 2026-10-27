import assert from 'node:assert/strict'
import { imageSize } from 'image-size'
import { CANVAS_MESSAGE_LABEL, canvasMessageContextSchema } from '../../packages/canvas/src/message'

/** Recover exactly the submitted observation and the preview it showed from
 * authoritative history. An unchanged preview resolves to the earlier turn's
 * attached image that it names; no other image can stand in for it. */
export function submittedCanvasEvidence(turn: { items: any[] }, earlierTurns: ReadonlyArray<{ items: any[] }> = []): { context: ReturnType<typeof canvasMessageContextSchema.parse>; preview?: Buffer } {
  const messages = turn.items.filter(item => item.type === 'userMessage')
  assert.equal(messages.length, 1, 'Expected one submitted user message')
  const content = messages[0].content as any[]
  const indices = content.flatMap((part, index) => part.type === 'text' && part.text?.startsWith(CANVAS_MESSAGE_LABEL) ? [index] : [])
  assert.equal(indices.length, 1, 'Expected one submitted canvas observation')
  const index = indices[0]!
  const context = canvasMessageContextSchema.parse(JSON.parse(content[index].text.slice(CANVAS_MESSAGE_LABEL.length).trim()))
  const after = content.slice(index + 1)
  if (context.preview.status === 'unchanged') {
    assert.equal(after.length, 0, 'An unchanged preview must not resend pixels')
    const evidenceId = context.preview.evidenceId
    const source = [...earlierTurns].reverse().map(earlier => submittedCanvasEvidence(earlier)).find(earlier => earlier.context.preview.status === 'attached' && earlier.context.preview.evidenceId === evidenceId)
    assert(source?.preview, `The earlier preview ${evidenceId} is missing from history`)
    return { context, preview: source.preview }
  }
  if (context.preview.status !== 'attached') {
    assert.equal(after.length, 0, 'A preview is present despite its declared absence')
    return { context }
  }
  assert.equal(after.length, 1, 'Attached preview missing or ambiguous')
  assert.equal(after[0].type, 'image', 'Attached preview is not an image')
  const encoded = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(after[0].url ?? '')?.[1]
  assert(encoded, 'Attached canvas preview must contain the delivered JPEG bytes')
  const preview = Buffer.from(encoded, 'base64')
  assert.equal(preview.toString('base64'), encoded, 'Malformed preview base64')
  const size = imageSize(preview)
  assert(size.type === 'jpg' && size.width > 0 && size.height > 0, 'Invalid submitted JPEG')
  return { context, preview }
}
