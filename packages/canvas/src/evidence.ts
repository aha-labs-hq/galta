import { z } from 'zod'
import { canvasBoundsSchema } from './bounds'
import { CANVAS_PAGE_MAX } from './reads'

/**
 * Evidence is an addressable observation, not an interpretation.  Keeping the
 * medium and capabilities explicit prevents a model (or a caller) from using
 * a geometric fact as if it established a pixel fact.
 */
export const CANVAS_EVIDENCE_SCOPES = ['canvas', 'selection', 'viewport', 'changes', 'ids', 'elements', 'region'] as const
export const CANVAS_EVIDENCE_CAPABILITIES = ['identity', 'bounds', 'native', 'pixels'] as const
export const CANVAS_PIXEL_FOCUS = ['canvas', 'selection', 'related', 'exact', 'region'] as const

/** Fields every evidence record shares, whether held by the tool's ledger or
 * summarized in a user message. */
const evidenceSummaryBase = {
  id: z.string().min(1),
  revision: z.string().min(1),
  scope: z.enum(CANVAS_EVIDENCE_SCOPES),
  /** The renderer/read may cover more identities than the bounded ID sample
   * can carry.  Counts make that truncation explicit instead of letting a
   * short list look like complete coverage. */
  totalElementCount: z.number().int().nonnegative(),
  coveredElementCount: z.number().int().nonnegative(),
  /** The requested page/render finished without an execution truncation. A
   * final page can still cover fewer IDs than totalElementCount; the counts,
   * rather than this flag alone, decide whether a whole-set claim is safe. */
  complete: z.boolean(),
  capabilities: z.array(z.enum(CANVAS_EVIDENCE_CAPABILITIES)).min(1),
  limitations: z.array(z.string().min(1).max(300)).max(8)
}
const evidenceBase = {
  ...evidenceSummaryBase,
  elementIds: z.array(z.string().min(1)).max(CANVAS_PAGE_MAX),
  /** IDs retained for history identity but absent from the current document. */
  missingElementIds: z.array(z.string().min(1)).max(CANVAS_PAGE_MAX).optional()
}
const structureFields = { type: z.literal('structure'), detail: z.enum(['summary', 'elements']).optional() }
const pixelsFields = {
  type: z.literal('pixels'),
  detail: z.enum(['low', 'high']),
  focus: z.enum(CANVAS_PIXEL_FOCUS),
  mimeType: z.literal('image/jpeg'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  region: canvasBoundsSchema.optional()
}

type EvidenceSummaryFields = { coveredElementCount: number; totalElementCount: number; capabilities: readonly string[]; type: 'structure' | 'pixels' }
function checkSummary(value: EvidenceSummaryFields, ctx: z.RefinementCtx) {
  if (value.coveredElementCount > value.totalElementCount) {
    ctx.addIssue({ code: 'custom', path: ['coveredElementCount'], message: 'coveredElementCount cannot exceed totalElementCount' })
  }
  if (!value.capabilities.includes('identity')) {
    ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'evidence must declare identity capability' })
  }
  if (value.type === 'pixels' && !value.capabilities.includes('pixels')) {
    ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'pixel evidence must declare pixels capability' })
  }
}

/** Structural invariants shared by every producer.  Tool output is trusted by
 * the host boundary, so counts and identities must be coherent before a
 * record can enter the evidence ledger.  JSON Schema cannot express all of
 * these relationships; the Zod parse is the executable contract. */
export const canvasEvidenceSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...evidenceBase, ...structureFields }),
  z.strictObject({ ...evidenceBase, ...pixelsFields })
]).superRefine((value, ctx) => {
  checkSummary(value, ctx)
  const uniqueIds = new Set(value.elementIds)
  if (uniqueIds.size !== value.elementIds.length) {
    ctx.addIssue({ code: 'custom', path: ['elementIds'], message: 'elementIds must be unique' })
  }
  if (value.coveredElementCount < value.elementIds.length) {
    ctx.addIssue({ code: 'custom', path: ['coveredElementCount'], message: 'coveredElementCount cannot be smaller than retained elementIds' })
  }
  const missing = new Set(value.missingElementIds ?? [])
  if ([...missing].some(id => !uniqueIds.has(id))) {
    ctx.addIssue({ code: 'custom', path: ['missingElementIds'], message: 'missingElementIds must be retained in elementIds' })
  }
})
export type CanvasEvidence = z.infer<typeof canvasEvidenceSchema>

/** The form a user message carries. Element identities stay in the tool's
 * evidence ledger, which canvas_report returns in full, and in paged reads;
 * repeating up to 64 IDs in every message only grows the conversation. */
export const canvasEvidenceSummarySchema = z.discriminatedUnion('type', [
  z.strictObject({ ...evidenceSummaryBase, ...structureFields }),
  z.strictObject({ ...evidenceSummaryBase, ...pixelsFields })
]).superRefine(checkSummary)
export type CanvasEvidenceSummary = z.infer<typeof canvasEvidenceSummarySchema>
export function summarizeCanvasEvidence(evidence: CanvasEvidence): CanvasEvidenceSummary {
  const summary: Record<string, unknown> = { ...evidence }
  delete summary.elementIds
  delete summary.missingElementIds
  return canvasEvidenceSummarySchema.parse(summary)
}

/** Claims in this ledger are canvas facts. User intent remains in the user
 * request and selection routing; pretending that a canvas evidence ID proves
 * intent would make the interface look complete while weakening its contract. */
export const CANVAS_CLAIM_CATEGORIES = ['appearance', 'spatial', 'structure'] as const
export const CANVAS_CLAIM_BASES = ['pixels', 'bounds', 'native'] as const

export const canvasClaimSchema = z.strictObject({
  claim: z.string().min(1).max(2_000),
  category: z.enum(CANVAS_CLAIM_CATEGORIES),
  basis: z.enum(CANVAS_CLAIM_BASES),
  evidenceIds: z.array(z.string().min(1)).max(8),
  certainty: z.enum(['certain', 'uncertain']),
  targetIds: z.array(z.string().min(1)).max(CANVAS_PAGE_MAX).optional()
})
export type CanvasClaim = z.infer<typeof canvasClaimSchema>

export const canvasReportSchema = z.strictObject({ revision: z.string().min(1), claims: z.array(canvasClaimSchema).min(1).max(16) })
export type CanvasReport = z.infer<typeof canvasReportSchema>

export type CanvasClaimAssessment = {
  claim: string
  category: CanvasClaim['category']
  basis: CanvasClaim['basis']
  certainty: CanvasClaim['certainty']
  evidenceIds: string[]
  status: 'evidence-sufficient' | 'insufficient-evidence' | 'mixed-revision' | 'stale-revision' | 'unverified'
  /** The ledger validates the evidence boundary; pixel semantics remain an
   * interpretation by the answering model or a separately verified reviewer. */
  semantic: 'unverified'
  reason: string
  targetIds: string[]
}

/** Capabilities required before a claim can be responsibly presented as
 * grounded.  Pixel-backed claims remain semantically unverified: this helper
 * checks the evidence boundary, never pretends to be a vision judge. */
export function requiredEvidenceCapability(category: CanvasClaim['category'], basis: CanvasClaim['basis']): CanvasEvidence['capabilities'][number] | null {
  if (category === 'appearance') return basis === 'pixels' ? 'pixels' : null
  if (category === 'spatial') return basis === 'bounds' || basis === 'pixels' ? basis : null
  if (category === 'structure') return basis === 'native' || basis === 'bounds' ? basis : null
  return null
}

export function makeStructureEvidence(input: {
  revision: string
  scope: CanvasEvidence['scope']
  elementIds: readonly string[]
  complete: boolean
  totalElementCount?: number
  coveredElementCount?: number
  detail?: 'summary' | 'elements'
  missingElementIds?: readonly string[]
  limitations?: readonly string[]
}): CanvasEvidence {
  const capabilities: CanvasEvidence['capabilities'] = input.detail === 'elements' ? ['identity', 'bounds', 'native'] : ['identity', 'bounds']
  return canvasEvidenceSchema.parse({
    id: crypto.randomUUID(), type: 'structure', revision: input.revision, scope: input.scope,
    elementIds: [...input.elementIds].slice(0, CANVAS_PAGE_MAX),
    totalElementCount: input.totalElementCount ?? input.elementIds.length,
    coveredElementCount: input.coveredElementCount ?? Math.min(input.elementIds.length, CANVAS_PAGE_MAX),
    complete: input.complete,
    ...(input.missingElementIds?.length ? { missingElementIds: [...input.missingElementIds].slice(0, CANVAS_PAGE_MAX) } : {}),
    capabilities, limitations: [...(input.limitations ?? [])].slice(0, 8),
    ...(input.detail ? { detail: input.detail } : {})
  })
}

export function makePixelsEvidence(input: {
  revision: string
  scope: CanvasEvidence['scope']
  elementIds: readonly string[]
  complete: boolean
  totalElementCount?: number
  coveredElementCount?: number
  missingElementIds?: readonly string[]
  sha256: string
  focus: (typeof CANVAS_PIXEL_FOCUS)[number]
  region?: { x: number; y: number; width: number; height: number }
  limitations?: readonly string[]
  detail: 'low' | 'high'
}): CanvasEvidence {
  return canvasEvidenceSchema.parse({
    id: crypto.randomUUID(), type: 'pixels', revision: input.revision, scope: input.scope,
    elementIds: [...input.elementIds].slice(0, CANVAS_PAGE_MAX),
    totalElementCount: input.totalElementCount ?? input.elementIds.length,
    coveredElementCount: input.coveredElementCount ?? Math.min(input.elementIds.length, CANVAS_PAGE_MAX),
    complete: input.complete,
    ...(input.missingElementIds?.length ? { missingElementIds: [...input.missingElementIds].slice(0, CANVAS_PAGE_MAX) } : {}),
    capabilities: ['identity', 'pixels'], limitations: [...(input.limitations ?? [])].slice(0, 8),
    detail: input.detail, focus: input.focus, mimeType: 'image/jpeg', sha256: input.sha256,
    ...(input.region ? { region: input.region } : {})
  })
}

export function assessCanvasClaim(claim: CanvasClaim, evidence: readonly CanvasEvidence[], expectedRevision?: string): CanvasClaimAssessment {
  const targets = { targetIds: [...(claim.targetIds ?? [])] }
  const base = (status: CanvasClaimAssessment['status'], reason: string): CanvasClaimAssessment => ({ ...claim, ...targets, status, semantic: 'unverified', reason })
  if (!claim.evidenceIds.length) return base('insufficient-evidence', 'A claim must name the evidence that supports it.')
  const selected = claim.evidenceIds.map(id => evidence.find(item => item.id === id))
  if (selected.some(item => !item)) return base('insufficient-evidence', 'One or more evidence IDs do not belong to this execution.')
  const records = selected as CanvasEvidence[]
  if (new Set(records.map(item => item.revision)).size > 1) return base('mixed-revision', 'The claim combines observations from different canvas revisions; read or capture again from one revision.')
  if (expectedRevision !== undefined && records.some(item => item.revision !== expectedRevision)) return base('stale-revision', 'The supplied evidence belongs to a different canvas revision than this report; inspect or capture the current revision again.')
  const required = requiredEvidenceCapability(claim.category, claim.basis)
  if (!required) return base('unverified', `The ${claim.category} claim cannot use ${claim.basis} as its evidence basis.`)
  if (records.some(item => !item.capabilities.includes(required))) {
    return base('insufficient-evidence', `This claim requires ${required} evidence; the supplied records do not establish it.`)
  }
  const observedIds = new Set(records.flatMap(item => item.elementIds))
  const missingIds = new Set(records.flatMap(item => item.missingElementIds ?? []))
  if (claim.targetIds?.some(id => missingIds.has(id))) {
    return base('insufficient-evidence', 'The declared target is a deleted or unavailable element in the supplied evidence.')
  }
  if (claim.targetIds?.some(id => !observedIds.has(id))) {
    return base('insufficient-evidence', 'The declared target is not included in the supplied evidence.')
  }
  if (claim.category === 'appearance' && claim.targetIds?.length) {
    const pixelRecords = records.filter((item): item is Extract<CanvasEvidence, { type: 'pixels' }> => item.type === 'pixels')
    if (pixelRecords.some(item => item.focus !== 'exact' || item.elementIds.length !== 1)) {
      return base('insufficient-evidence', 'An individual appearance claim needs one exact capture per target; a composite or related view can hide overlap and detail.')
    }
  }
  if (records.some(item => !item.complete || item.coveredElementCount < item.totalElementCount || item.limitations.length > 0)) return base('insufficient-evidence', 'The supplied evidence is incomplete or limited; inspect or capture the missing content before making this claim.')
  return base('evidence-sufficient', 'The declared evidence has the required medium and revision. This checks the evidence boundary, not whether the visual wording is semantically correct.')
}
