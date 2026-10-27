import type { CodexConnectResponse } from '../shared/messages'

export const CODEX_SIGN_IN_REQUIRED = 'Your Codex sign-in has expired. Sign in with ChatGPT to continue.'
export const CODEX_USAGE_UNAVAILABLE = 'Usage is unavailable.'

export class CodexRequestError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, message: string, readonly data?: unknown) {
    super(message)
  }
}

// App-server wraps upstream HTTP failures in JSON-RPC errors. Older versions
// expose the upstream status/code only in the message, so keep this translation
// at the boundary. Neither response bodies nor credentials reach diagnostics.
export function isCodexAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const data = error instanceof CodexRequestError && error.data && typeof error.data === 'object'
    ? error.data as Record<string, unknown> : undefined
  return data?.status === 401 || data?.statusCode === 401
    || /\b(?:token_revoked|token_expired|invalid_token|invalid_grant|refresh_token_(?:expired|reused|invalidated))\b/i.test(String(data?.code ?? '') + ' ' + error.message)
    || /\b401\b|\bnot (?:logged|signed) in\b|\bauthentication required\b|please (?:log out and )?sign in again/i.test(error.message)
}

export function connectionFailure(error: unknown): CodexConnectResponse {
  if (isCodexAuthError(error)) return { ok: true, requiresAuth: true, error: CODEX_SIGN_IN_REQUIRED }
  if (error instanceof CodexRequestError) {
    console.warn('Codex connection request failed', { method: error.method, code: error.code })
    return { ok: false, error: error.method === 'model/list'
      ? 'Could not load Codex models. Try connecting again.'
      : 'Could not check your Codex account. Try connecting again.' }
  }
  return { ok: false, error: error instanceof Error ? error.message : 'Unable to connect to Codex' }
}
