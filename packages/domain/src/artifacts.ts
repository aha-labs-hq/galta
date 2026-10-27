import { z } from 'zod'

export const ARTIFACT_LIMITS = { files: 16, bytes: 128 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, timeoutMs: 60_000 } as const
export const artifactIdentitySchema = z.strictObject({
  projectId: z.string().min(1), threadId: z.string().min(1), turnId: z.string().min(1), messageId: z.string().min(1)
})
export const artifactReceiptSchema = artifactIdentitySchema.extend({
  receiptId: z.uuid(), href: z.string().min(1), uri: z.string().startsWith('galta-workspace:/deliveries/'),
  /** Stable workspace alias emitted by canvas_deliver, when one exists. */
  artifactUri: z.string().startsWith('galta-workspace:/').optional(),
  name: z.string().min(1), mimeType: z.string().min(1), size: z.number().int().nonnegative().max(ARTIFACT_LIMITS.bytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), version: z.string().min(1)
})
export const artifactReadSchema = artifactReceiptSchema.pick({ receiptId: true, projectId: true, threadId: true, turnId: true, messageId: true, href: true, uri: true })
/** A canvas_deliver result is a product-owned declaration before it is bound
 * to the completed final message by the task runtime. */
export const artifactDeliveryDeclarationSchema = z.strictObject({
  path: z.string().min(1), artifactUri: z.string().startsWith('galta-workspace:/'),
  sourceArtifactUri: z.string().startsWith('galta-workspace:/'), name: z.string().min(1),
  mimeType: z.string().min(1), size: z.number().int().nonnegative().max(ARTIFACT_LIMITS.bytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), version: z.string().min(1)
})
export const conversationArtifactSchema = z.discriminatedUnion('status', [
  z.strictObject({ href: z.string(), status: z.literal('ready'), receipt: artifactReceiptSchema }),
  z.strictObject({ href: z.string(), status: z.literal('failed'), error: z.string() })
])
export type ArtifactIdentity = z.infer<typeof artifactIdentitySchema>
export type ArtifactReceipt = z.infer<typeof artifactReceiptSchema>
export type ArtifactRead = z.infer<typeof artifactReadSchema>
export type ArtifactDeliveryDeclaration = z.infer<typeof artifactDeliveryDeclarationSchema>
export type ConversationArtifact = z.infer<typeof conversationArtifactSchema>
