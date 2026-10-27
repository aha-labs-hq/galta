import type { CollectionItemInput } from './collection'
import type { MediaSettingsRequest } from '@galta/canvas'
import type { AccountRequest } from './account'

export type GaltaMessage =
  | { type: 'setup-status' }
  | { type: 'setup-reconnect' }
  | { type: 'media-settings'; request: MediaSettingsRequest }
  | { type: 'codex-connect' }
  | { type: 'codex-login' }
  | { type: 'codex-rpc'; ownerId: string; requestId: string; method: string; params?: unknown }
  | { type: 'codex-respond'; ownerId: string; id: string | number; result?: unknown; error?: { code: number; message: string } }
  | { type: 'codex-notification'; notification: { id?: string | number; ownerId?: string; method: string; params?: Record<string, unknown> } }
  | { type: 'collection-add'; item: CollectionItemInput }
  | { type: 'collection-list' }
  | { type: 'collection-remove'; id: string }
  | { type: 'account'; request: AccountRequest }

export type CodexAccount = {
  type: string
  planType?: string
  email?: string
}

export type CodexModel = {
  id: string
  displayName?: string
  supportedReasoningEfforts?: ReadonlyArray<{ reasoningEffort: string; description?: string }>
  isDefault?: boolean
}

export type CodexRateLimits = {
  planType?: string
  primary?: { usedPercent: number; resetsAt?: number; windowDurationMins?: number }
}

export type CodexConnected = {
  ok: true
  requiresAuth?: false
  account?: CodexAccount
  models?: ReadonlyArray<CodexModel>
  rateLimits?: CodexRateLimits
  usageError?: string
}

export type CodexConnectResponse = CodexConnected
  | { ok: true; requiresAuth: true; error?: string }
  | { ok: false; error: string }

export type CodexLoginResponse = { ok: true } | { ok: false; error: string }
