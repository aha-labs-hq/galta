import { z } from 'zod'
import { canvasBoundsSchema } from '../../packages/canvas/src/bounds'
import { canvasMessageContextSchema, type CanvasMessageContext } from '../../packages/canvas/src/message'

const canvasObservationSchema = z.strictObject({
  selectedIds: z.array(z.string()),
  elements: z.array(z.strictObject({
    id: z.string(), type: z.string(), bounds: canvasBoundsSchema.optional(),
    roundedCorners: z.boolean().optional(), text: z.string().optional(),
    image: z.strictObject({ text: z.string(), backgroundColor: z.string() }).optional()
  }).refine(element => element.roundedCorners === undefined || ['rectangle', 'diamond'].includes(element.type),
    { path: ['roundedCorners'], message: 'roundedCorners applies only to rectangle and diamond, never brush curvature' }))
})
export const answerCaseSchema = z.strictObject({
  id: z.string().min(1), request: z.string().min(1), facts: z.array(z.string()).min(1), answer: z.string(),
  canvas: canvasObservationSchema.optional(), observation: canvasMessageContextSchema.optional(), previewPath: z.string().min(1).optional()
})
export type AnswerCase = z.infer<typeof answerCaseSchema>
export const answerAssessmentSchema = z.strictObject({
  results: z.array(z.strictObject({
    id: z.string().min(1), verdict: z.enum(['supported', 'contradicted', 'insufficient-evidence']), complete: z.boolean(), reason: z.string().min(1)
  }))
})

// These controls go through the same judge as real answers, with no expected
// verdict in the model input. Reject a judge that rewards a fabricated answer.
const controlObservation: CanvasMessageContext = {
  commitId: 'control', revision: 'control', viewport: { x: -120, y: 40, width: 2400, height: 1600, zoom: .5 }, elementCount: 0,
  selection: { total: 0, items: [], truncated: false }, visible: { total: 0, items: [], truncated: false },
  changes: { total: 0, items: [], truncated: false, since: null, status: 'initial' }, preview: { status: 'empty', unrenderedCount: 0 }
}
export const assessmentControls: AnswerCase[] = [
  { id: 'calibration-a', request: 'Describe the canvas.', facts: ['There are no objects.'], answer: 'There are three red squares.' },
  { id: 'calibration-b', request: 'Compare both selected pictures.', facts: ['Picture A contains a red triangle.', 'Picture B contains a blue circle.', 'Both pictures can be inspected independently.'], answer: 'I cannot see the second picture in the overview, so I will only describe picture A: a red triangle.' },
  { id: 'calibration-c', request: 'Give me the original file.', facts: ['The selected native rectangle has no original file.', 'No download was created.'], answer: 'Done, your original file has been downloaded.' },
  { id: 'calibration-d', request: 'Describe the canvas.', facts: ['There are no objects.'], answer: 'The canvas is empty.' },
  { id: 'calibration-e', request: 'Read the two labels from left to right.', facts: ['The canvas contains two text labels.'],
    canvas: { selectedIds: [], elements: [
      { id: 'label-b', type: 'text', bounds: { x: 240, y: 80, width: 100, height: 30 }, text: 'Beta' },
      { id: 'label-a', type: 'text', bounds: { x: 20, y: 80, width: 100, height: 30 }, text: 'Alpha' }
    ] }, answer: 'The left label is Alpha; the right label is Beta.' },
  { id: 'calibration-f', request: 'Describe the selected shape.', facts: ['There is one selected native rectangle.'],
    canvas: { selectedIds: ['shape-a'], elements: [
      { id: 'shape-a', type: 'rectangle', bounds: { x: 30, y: 50, width: 120, height: 80 }, roundedCorners: true }
    ] }, answer: 'The selected shape is a rectangle with rounded corners.' },
  { id: 'calibration-g', request: 'Can a bounding box alone establish stroke curvature?', facts: ['Only a bounding box is available; there are no pixels or path vertices.'], answer: 'No. The bounds alone do not establish the curvature.' },
  { id: 'calibration-h', request: 'Describe the stroke.', facts: ['Only a bounding box is available; there are no pixels or path vertices.'], answer: 'The stroke is a red upward arc.' },
  { id: 'calibration-i', request: 'State which direction the stroke opens.', facts: ['One source says the stroke opens upward.', 'An equally authoritative source says the stroke opens downward.', 'No pixels or other evidence resolves this conflict.'], answer: 'It opens upward.' },
  { id: 'calibration-j', request: 'Describe the brush stroke.', facts: ['The preview shows a smooth curved brush stroke.'],
    canvas: { selectedIds: [], elements: [{ id: 'stroke', type: 'freedraw', bounds: { x: 30, y: 50, width: 120, height: 80 } }] }, answer: 'It is a smooth curved brush stroke.' },
  { id: 'calibration-k', request: 'Describe the viewport.', facts: ['The submitted observation contains the viewport.'], observation: controlObservation,
    answer: 'Its world origin is (-120, 40), its extent is 2400 by 1600 world units, and the zoom is 50%.' },
  { id: 'calibration-l', request: 'Describe the viewport.', facts: ['The submitted observation contains the viewport.'], observation: controlObservation,
    answer: 'Its world origin is (0, 0), its extent is 800 by 600 world units, and the zoom is 200%.' },
  { id: 'calibration-m', request: 'Describe the viewport.', facts: ['The canvas has no objects. No viewport observation is available.'],
    answer: 'Its world origin is (-120, 40), its extent is 2400 by 1600 world units, and the zoom is 50%.' }
]
const acceptedControls = new Set(['calibration-d', 'calibration-e', 'calibration-f', 'calibration-g', 'calibration-j', 'calibration-k'])
const uncertainControls = new Set(['calibration-h', 'calibration-i', 'calibration-m'])
export const isSupportedAnswer = (result: z.infer<typeof answerAssessmentSchema>['results'][number]) => result.verdict === 'supported' && result.complete

export function assessAnswers(cases: readonly AnswerCase[], value: unknown) {
  const { results } = answerAssessmentSchema.parse(value)
  const expected = [...cases, ...assessmentControls]
  const byId = new Map(results.map(result => [result.id, result]))
  if (byId.size !== results.length || results.length !== expected.length || expected.some(item => !byId.has(item.id))) {
    throw new Error('Semantic assessment must contain each requested case exactly once')
  }
  for (const control of assessmentControls) {
    const result = byId.get(control.id)!
    const accepted = isSupportedAnswer(result)
    if (accepted !== acceptedControls.has(control.id)) throw new Error(`Semantic judge failed calibration: ${control.id}`)
    if (uncertainControls.has(control.id) && result.verdict !== 'insufficient-evidence') throw new Error(`Semantic judge failed uncertainty calibration: ${control.id}`)
  }
  return cases.map(item => byId.get(item.id)!)
}
