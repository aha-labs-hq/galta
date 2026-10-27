import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { assessAnswers, assessmentControls, answerCaseSchema, isSupportedAnswer } from '../scripts/lib/canvas-intent-assessment.ts'
import { submittedCanvasEvidence } from '../scripts/lib/canvas-intent-evidence.ts'
import { CANVAS_MESSAGE_LABEL } from '../packages/canvas/src/message.ts'

const cases = [{ id: 'comparison', request: 'Compare them.', facts: ['Two different pictures.'], answer: 'They are identical.' }]
const positiveControls = ['calibration-d', 'calibration-e', 'calibration-f', 'calibration-g', 'calibration-j', 'calibration-k']
const controls = assessmentControls.map(({ id }) => ({ id, verdict: positiveControls.includes(id) || id === 'calibration-b' ? 'supported' : ['calibration-h', 'calibration-i', 'calibration-m'].includes(id) ? 'insufficient-evidence' : 'contradicted', complete: id !== 'calibration-b', reason: 'Ground truth comparison.' }))
const verdict = { id: 'comparison', verdict: 'contradicted', complete: true, reason: 'The images differ.' }

test('wrong and incomplete answers stay failed even after a completed tool-free turn', () => {
  expect(assessAnswers(cases, { results: [verdict, ...controls] })).toEqual([verdict])
})

test('a judge that accepts false or incomplete control answers cannot certify a run', () => {
  for (const control of controls.filter(item => !positiveControls.includes(item.id))) {
    expect(() => assessAnswers(cases, { results: [verdict, ...controls.map(item => item.id === control.id ? { ...item, verdict: 'supported', complete: true } : item)] })).toThrow('calibration')
  }
})

test('a judge that rejects truthful control answers cannot certify a run', () => {
  for (const id of positiveControls) {
    expect(() => assessAnswers(cases, { results: [verdict, ...controls.map(item => item.id === id ? { ...item, verdict: 'contradicted' } : item)] })).toThrow('calibration')
  }
})

test('omitted, duplicated, invented and malformed verdicts are rejected', () => {
  for (const results of [controls, [verdict, ...controls, verdict], [{ ...verdict, id: 'invented' }, ...controls], [{ ...verdict, verdict: 'true' }, ...controls]]) {
    expect(() => assessAnswers(cases, { results })).toThrow()
  }
})

test('unresolved evidence remains explicit and cannot certify semantic success', () => {
  const uncertain = { ...verdict, verdict: 'insufficient-evidence', reason: 'The outline is occluded.' }
  expect(assessAnswers(cases, { results: [uncertain, ...controls] })).toEqual([uncertain])
  expect(isSupportedAnswer(uncertain)).toBe(false)
  for (const id of ['calibration-h', 'calibration-i', 'calibration-m']) {
    expect(() => assessAnswers(cases, { results: [verdict, ...controls.map(item => item.id === id ? { ...item, verdict: 'contradicted' } : item)] })).toThrow('uncertainty calibration')
  }
})

test('inapplicable corner properties fail the evidence schema instead of becoming visual facts', () => {
  const element = { id: 'drawing', type: 'freedraw', bounds: { x: 0, y: 0, width: 100, height: 100 } }
  for (const roundedCorners of [false, true]) {
    expect(() => answerCaseSchema.parse({ ...cases[0], canvas: { selectedIds: [], elements: [{ ...element, roundedCorners }] } })).toThrow('never brush curvature')
  }
  expect(answerCaseSchema.parse({ ...cases[0], canvas: { selectedIds: [], elements: [element] } }).canvas.elements[0]).toEqual(element)
})

test('visual assessment receives the exact submitted JPEG, never an earlier reference', () => {
  const preview = readFileSync(new URL('../docs/evidence/canvas-intent-acceptance-2026-09-25/submitted-drawing.jpg', import.meta.url))
  const context = {
    commitId: 'commit', revision: 'revision', viewport: { x: 0, y: 0, width: 1200, height: 900, zoom: 1 }, elementCount: 1,
    selection: { total: 0, items: [], truncated: false },
    visible: { total: 1, items: [{ id: 'stroke', kind: 'draw', bounds: { x: 100, y: 50, width: 200, height: 100 } }], truncated: false },
    changes: { total: 0, items: [], truncated: false, since: null, status: 'initial' }, preview: { status: 'attached', unrenderedCount: 0 }
  }
  const observation = { type: 'text', text: `${CANVAS_MESSAGE_LABEL}\n${JSON.stringify(context)}` }
  const image = { type: 'image', url: `data:image/jpeg;base64,${preview.toString('base64')}` }
  const turn = content => ({ items: [{ type: 'userMessage', content }] })
  const reference = { type: 'image', url: 'data:image/png;base64,AA==' }
  const result = submittedCanvasEvidence(turn([reference, observation, image]))
  expect(result.context).toEqual(context)
  expect(result.preview).toEqual(preview)
  const assessed = answerCaseSchema.parse({ ...cases[0], observation: result.context })
  expect(assessed.observation).toEqual(context)
  expect(() => answerCaseSchema.parse({ ...cases[0], observation: { ...context, viewport: { ...context.viewport, width: 0 } } })).toThrow()
  for (const content of [[reference, observation], [observation, image, image], [observation, reference], [observation, { type: 'image', url: 'data:image/jpeg;base64,AA==' }]]) {
    expect(() => submittedCanvasEvidence(turn(content))).toThrow()
  }
  const unavailable = { ...context, preview: { status: 'unavailable', unrenderedCount: 0, reason: 'Rendering failed' } }
  const missing = { type: 'text', text: `${CANVAS_MESSAGE_LABEL}\n${JSON.stringify(unavailable)}` }
  expect(submittedCanvasEvidence(turn([reference, missing])).preview).toBeUndefined()
  expect(() => submittedCanvasEvidence(turn([missing, image]))).toThrow('declared absence')
  // An unchanged preview resolves to the earlier attached image it names.
  const pixels = { id: 'pixels-1', type: 'pixels', revision: 'revision', scope: 'region', totalElementCount: 1, coveredElementCount: 1, complete: true, capabilities: ['identity', 'pixels'], limitations: [], detail: 'low', focus: 'region', mimeType: 'image/jpeg', sha256: 'a'.repeat(64) }
  const observed = (value) => ({ type: 'text', text: `${CANVAS_MESSAGE_LABEL}\n${JSON.stringify(value)}` })
  const earlier = turn([observed({ ...context, evidence: [pixels], preview: { status: 'attached', unrenderedCount: 0, evidenceId: 'pixels-1' } }), image])
  const later = turn([observed({ ...context, preview: { status: 'unchanged', evidenceId: 'pixels-1' } })])
  expect(submittedCanvasEvidence(later, [earlier]).preview).toEqual(preview)
  expect(() => submittedCanvasEvidence(later, [])).toThrow('missing from history')
  expect(() => submittedCanvasEvidence(turn([observed({ ...context, preview: { status: 'unchanged', evidenceId: 'pixels-1' } }), image]), [earlier])).toThrow('must not resend')
})
