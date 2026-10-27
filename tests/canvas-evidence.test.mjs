import { test, expect } from 'bun:test'
import { assessCanvasClaim, canvasMessageContextSchema, canvasReportSchema, makePixelsEvidence, makeStructureEvidence, summarizeCanvasEvidence } from '../packages/canvas/src/index.ts'

const structure = makeStructureEvidence({ revision: 'r1', scope: 'ids', elementIds: ['stroke'], complete: true, detail: 'elements' })
const overview = makePixelsEvidence({ revision: 'r1', scope: 'region', elementIds: ['stroke'], complete: true, detail: 'low', focus: 'region', sha256: 'a'.repeat(64) })
const exact = makePixelsEvidence({ revision: 'r1', scope: 'elements', elementIds: ['stroke'], complete: true, detail: 'high', focus: 'exact', sha256: 'b'.repeat(64) })

test('evidence reports keep geometry, pixels and revisions as separate capabilities', () => {
  const spatial = assessCanvasClaim({ claim: 'The stroke is to the right.', category: 'spatial', basis: 'bounds', evidenceIds: [structure.id], certainty: 'certain', targetIds: ['stroke'] }, [structure])
  expect(spatial.status).toBe('evidence-sufficient')

  const wrongMedium = assessCanvasClaim({ claim: 'The stroke curves upward.', category: 'appearance', basis: 'bounds', evidenceIds: [structure.id], certainty: 'certain', targetIds: ['stroke'] }, [structure])
  expect(wrongMedium.status).toBe('unverified')

  const composite = assessCanvasClaim({ claim: 'The stroke curves upward.', category: 'appearance', basis: 'pixels', evidenceIds: [overview.id], certainty: 'certain', targetIds: ['stroke'] }, [overview])
  expect(composite.status).toBe('insufficient-evidence')
  expect(composite.reason).toContain('one exact capture')

  const grounded = assessCanvasClaim({ claim: 'The stroke curves upward.', category: 'appearance', basis: 'pixels', evidenceIds: [exact.id], certainty: 'uncertain', targetIds: ['stroke'] }, [exact])
  expect(grounded.status).toBe('evidence-sufficient')
  expect(grounded.reason).toContain('not whether')
})

test('reports reject mixed revisions and unknown evidence identities', () => {
  const next = makeStructureEvidence({ revision: 'r2', scope: 'ids', elementIds: ['stroke'], complete: true, detail: 'summary' })
  const mixed = assessCanvasClaim({ claim: 'The objects are aligned.', category: 'spatial', basis: 'bounds', evidenceIds: [structure.id, next.id], certainty: 'certain', targetIds: ['stroke'] }, [structure, next])
  expect(mixed.status).toBe('mixed-revision')
  const stale = assessCanvasClaim({ claim: 'The object is red.', category: 'appearance', basis: 'pixels', evidenceIds: [exact.id], certainty: 'certain', targetIds: ['stroke'] }, [exact], 'r2')
  expect(stale.status).toBe('stale-revision')
  const unknown = assessCanvasClaim({ claim: 'The object is red.', category: 'appearance', basis: 'pixels', evidenceIds: ['missing'], certainty: 'uncertain', targetIds: ['stroke'] }, [exact])
  expect(unknown.status).toBe('insufficient-evidence')
  const deleted = makeStructureEvidence({ revision: 'r1', scope: 'changes', elementIds: ['deleted'], missingElementIds: ['deleted'], complete: true, detail: 'summary' })
  const deletedClaim = assessCanvasClaim({ claim: 'The deleted object is to the right.', category: 'spatial', basis: 'bounds', evidenceIds: [deleted.id], certainty: 'certain', targetIds: ['deleted'] }, [deleted])
  expect(deletedClaim.status).toBe('insufficient-evidence')
  expect(deletedClaim.reason).toContain('deleted')
})

test('bounded pixel evidence cannot masquerade as complete or isolate a composite', () => {
  const many = makePixelsEvidence({ revision: 'r1', scope: 'canvas', elementIds: Array.from({ length: 65 }, (_, index) => `e-${index}`), complete: false, detail: 'low', focus: 'canvas', sha256: 'c'.repeat(64), limitations: ['Only the retained identity sample is addressable.'] })
  expect(many.totalElementCount).toBe(65)
  expect(many.coveredElementCount).toBe(64)
  expect(assessCanvasClaim({ claim: 'The canvas is blue.', category: 'appearance', basis: 'pixels', evidenceIds: [many.id], certainty: 'uncertain' }, [many]).status).toBe('insufficient-evidence')

  const composite = makePixelsEvidence({ revision: 'r1', scope: 'elements', elementIds: ['a', 'b'], complete: true, detail: 'high', focus: 'exact', sha256: 'd'.repeat(64) })
  const claim = { claim: 'Both objects are red.', category: 'appearance', basis: 'pixels', evidenceIds: [composite.id], certainty: 'certain', targetIds: ['a', 'b'] }
  expect(assessCanvasClaim(claim, [composite]).reason).toContain('one exact capture per target')

  const a = makePixelsEvidence({ revision: 'r1', scope: 'elements', elementIds: ['a'], complete: true, detail: 'high', focus: 'exact', sha256: 'e'.repeat(64) })
  const b = makePixelsEvidence({ revision: 'r1', scope: 'elements', elementIds: ['b'], complete: true, detail: 'high', focus: 'exact', sha256: 'f'.repeat(64) })
  expect(assessCanvasClaim({ ...claim, evidenceIds: [a.id, b.id] }, [a, b])).toMatchObject({ status: 'evidence-sufficient', semantic: 'unverified' })
})

test('evidence schemas reject incoherent counts and identities', () => {
  expect(() => makeStructureEvidence({ revision: 'r1', scope: 'ids', elementIds: ['a', 'a'], totalElementCount: 2, coveredElementCount: 2, complete: true, detail: 'elements' })).toThrow(/unique/)
  expect(() => makeStructureEvidence({ revision: 'r1', scope: 'ids', elementIds: ['a'], totalElementCount: 0, coveredElementCount: 1, complete: false, detail: 'summary' })).toThrow(/exceed/)
})

test('an attached preview cannot be detached from its pixel evidence', () => {
  const context = {
    commitId: 'c1', revision: 'r1', viewport: { x: 0, y: 0, width: 100, height: 100, zoom: 1 }, elementCount: 1,
    selection: { total: 0, items: [], truncated: false }, visible: { total: 1, items: [{ id: 'stroke', kind: 'draw', bounds: { x: 0, y: 0, width: 10, height: 10 } }], truncated: false },
    changes: { total: 0, items: [], truncated: false, since: null, status: 'initial' },
    evidence: [summarizeCanvasEvidence(exact)], preview: { status: 'attached', unrenderedCount: 0, evidenceId: exact.id }
  }
  expect(() => canvasMessageContextSchema.parse({ ...context, preview: { ...context.preview, evidenceId: 'missing' } })).toThrow(/pixel evidence/)
  expect(() => canvasMessageContextSchema.parse({ ...context, revision: 'r2' })).toThrow(/revision/)
  expect(canvasMessageContextSchema.parse(context).preview).toMatchObject({ evidenceId: exact.id })
})

test('report input remains strict and bounded', () => {
  const claim = { claim: 'ok', category: 'appearance', basis: 'pixels', evidenceIds: [], certainty: 'uncertain' }
  expect(() => canvasReportSchema.parse({ revision: 'r1', claims: [claim] })).not.toThrow()
  expect(() => canvasReportSchema.parse({ claims: [claim] })).toThrow()
  expect(() => canvasReportSchema.parse({ revision: 'r1', claims: [{ ...claim, certainty: 'maybe' }] })).toThrow()
  expect(() => canvasReportSchema.parse({ revision: 'r1', claims: [{ ...claim, extra: true }] })).toThrow()
})
