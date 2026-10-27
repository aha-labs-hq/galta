/** The person's Aha Labs account, one account across Aha Labs apps. The
 * service is aha-labs-hq/account; its README is the contract these values
 * copy. The background (`background/account.ts`) owns the session and alone
 * uses the token; pages ask it through `{ type: 'account' }` messages. */

export const ACCOUNT_ORIGIN = 'https://account.ahalabs.site'
export const ACCOUNT_API = '/api/auth'
/** Google sign-in runs in a tab: `GOOGLE_PATH` starts it, and `HANDOFF_PATH`
 * hands the session back through `externally_connectable`. */
export const GOOGLE_PATH = '/google'
export const HANDOFF_PATH = '/signed-in'
export const CODE_LENGTH = 6

export type AccountUser = { id: string; name: string; email: string; image: string | null }

export type AccountHandoff =
  | { type: 'aha-account-handoff'; handoff: string; token: string }
  | { type: 'aha-account-handoff'; handoff: string; error: 'cancelled' | 'failed' }

/** A Google sign-in's request id: the extension mints it and accepts a
 * handoff only for the id it is waiting for. */
const HANDOFF_ID = /^[A-Za-z0-9_-]{22,64}$/
export function isAccountHandoff(value: unknown): value is AccountHandoff {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  if (message.type !== 'aha-account-handoff' || typeof message.handoff !== 'string' || !HANDOFF_ID.test(message.handoff)) return false
  return 'token' in message ? typeof message.token === 'string' && message.token.length > 0 && !('error' in message)
    : message.error === 'cancelled' || message.error === 'failed'
}

export const ACCOUNT_KEY = 'galta.account'
/** A Google sign-in in progress, in session storage: it outlives the service
 * worker's sleep while the person is on Google, not a browser restart. */
export const GOOGLE_KEY = 'galta.account.google'

export type StoredAccount =
  | { token: string; user: AccountUser; checkedAt: number }
  /** Signed out. `ended` means the service ended the session (it expired or
   * was revoked), not that the person signed out. */
  | { token?: undefined; ended?: true }

export type GoogleSignIn = { handoff: string; tabId: number; state: 'waiting' | 'cancelled' | 'failed' }

export type AccountState = {
  user: AccountUser | null
  ended: boolean
  google: GoogleSignIn['state'] | null
}

export type AccountRequest =
  | { action: 'status' }
  | { action: 'send-code'; email: string }
  | { action: 'verify-code'; email: string; code: string }
  | { action: 'google' }
  | { action: 'google-show' }
  | { action: 'google-cancel' }
  | { action: 'rename'; name: string }
  | { action: 'sign-out' }
  /** Deletes the signed-in account, confirmed by a code sent to its address. */
  | { action: 'delete'; code: string }

export type AccountResponse = { ok: true; state: AccountState } | { ok: false; error: string; state: AccountState }

export function accountState(stored: StoredAccount | undefined, google: GoogleSignIn | undefined): AccountState {
  return { user: stored?.token ? stored.user : null, ended: Boolean(stored && !stored.token && 'ended' in stored && stored.ended), google: google?.state ?? null }
}

/** What the interface calls a person: their name, else their address. */
export function accountName(user: AccountUser) {
  return user.name.trim() || user.email
}

/** Normalizes an address the way the service does, or returns null. */
export function normalEmail(input: string) {
  const email = input.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null
}
