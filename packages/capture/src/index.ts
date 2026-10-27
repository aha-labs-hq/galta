import type { CaptureId } from '@galta/domain'

export type CaptureKind = 'image' | 'link' | 'selection' | 'page' | 'file'

export type CaptureRequest = {
  kind: CaptureKind
  sourceUrl?: string
  mediaUrl?: string
  pageUrl: string
  pageTitle?: string
  selectedText?: string
  userGestureId: string
}

export type CaptureRecord = CaptureRequest & {
  id: CaptureId
  sourceHost: string
  capturedAt: number
}

export function asCaptureId(value: string): CaptureId {
  if (!value.trim()) throw new Error('Capture id cannot be empty')
  return value as CaptureId
}

export function normalizeCapture(request: CaptureRequest, now = Date.now()): CaptureRecord {
  if (!request.userGestureId.trim()) throw new Error('Capture requires a user gesture')
  const page = new URL(request.pageUrl)
  if (!['http:', 'https:'].includes(page.protocol)) throw new Error('Capture source must be an HTTP(S) page')
  return {
    ...request,
    id: asCaptureId(`capture-${request.userGestureId}`),
    sourceHost: page.host,
    capturedAt: now
  }
}
