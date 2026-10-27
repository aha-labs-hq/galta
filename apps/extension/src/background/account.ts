import { ACCOUNT_API, ACCOUNT_KEY, ACCOUNT_ORIGIN, CODE_LENGTH, GOOGLE_KEY, GOOGLE_PATH, HANDOFF_PATH, accountState, isAccountHandoff, normalEmail, type AccountRequest, type AccountResponse, type AccountUser, type GoogleSignIn, type StoredAccount } from '../shared/account'

/** The one owner of this browser's Aha Labs account. It keeps the session as a
 * bearer token in `chrome.storage.local`, which Galta's own pages can read but
 * content scripts and web pages cannot (`protectAccountStorage`). Nothing else
 * uses the token, and the service is called without cookies.
 * Galta works signed out; nothing here gates the canvas. */

/** better-auth extends a session when it is used after a day; checking hourly
 * keeps an open Galta signed in and notices a revoked session soon. */
const CHECK_EVERY = 60 * 60 * 1000

class AccountFailure extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

const OFFLINE = 'Galta can’t reach its account service. Check your connection and try again.'
const ENDED = 'Your session ended. Sign in again.'
const COPY: Record<string, string> = {
  INVALID_OTP: 'That code isn’t right.',
  OTP_EXPIRED: 'That code has expired. Send a new one.',
  TOO_MANY_ATTEMPTS: 'Too many tries. Send a new code.',
  INVALID_EMAIL: 'Enter a valid email address.',
}

export async function protectAccountStorage() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
}

async function api(path: string, { body, token }: { body?: unknown; token?: string } = {}) {
  let response: Response
  try {
    response = await fetch(`${ACCOUNT_ORIGIN}${ACCOUNT_API}${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch { throw new AccountFailure(OFFLINE) }
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const { code, message } = (data ?? {}) as { code?: unknown; message?: unknown }
    const known = typeof code === 'string' ? COPY[code] : undefined
    // The service's own messages (rate limits, email delivery) are written for people.
    const own = typeof code === 'string' && /^(RATE_LIMITED|EMAIL_)/.test(code) && typeof message === 'string' ? message : undefined
    throw new AccountFailure(known ?? own ?? (response.status === 401 ? ENDED : 'Something went wrong. Try again.'), response.status)
  }
  return { data, token: response.headers.get('set-auth-token') }
}

function userOf(value: unknown): AccountUser {
  const user = (value ?? {}) as Record<string, unknown>
  if (typeof user.id !== 'string' || typeof user.email !== 'string') throw new AccountFailure('The account service answered with no account. Try again.')
  return { id: user.id, email: user.email, name: typeof user.name === 'string' ? user.name : '', image: typeof user.image === 'string' && user.image.startsWith('https://') ? user.image : null }
}

const read = async (): Promise<StoredAccount> => (await chrome.storage.local.get(ACCOUNT_KEY))[ACCOUNT_KEY] ?? {}
const write = (value: StoredAccount) => chrome.storage.local.set({ [ACCOUNT_KEY]: value })
const readGoogle = async (): Promise<GoogleSignIn | undefined> => (await chrome.storage.session.get(GOOGLE_KEY))[GOOGLE_KEY]
const writeGoogle = (value: GoogleSignIn | null) => value ? chrome.storage.session.set({ [GOOGLE_KEY]: value }) : chrome.storage.session.remove(GOOGLE_KEY)
const state = async () => accountState(await read(), await readGoogle())

/** Calls made with the session; a refused session signs this browser out. */
async function authorized(stored: StoredAccount & { token: string }, path: string, body?: unknown) {
  try { return await api(path, { token: stored.token, ...(body === undefined ? {} : { body }) }) }
  catch (error) {
    if (error instanceof AccountFailure && error.status === 401) await write({ ended: true })
    throw error
  }
}

async function signedIn(): Promise<StoredAccount & { token: string }> {
  const stored = await read()
  if (!stored.token) throw new AccountFailure('You’re signed out.')
  return stored
}

/** Requests and Google handoffs run one at a time, so a status check never
 * races a sign-out and a handoff never lands after its cancel. */
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work)
  queue = run.catch(() => undefined)
  return run
}

/** `from` is the Galta tab that asked, when it is a tab: Google's tab opens
 * beside it, so closing that tab returns there. */
export function handleAccount(request: AccountRequest, from?: chrome.tabs.Tab): Promise<AccountResponse> {
  return serial(async () => {
    try {
      await perform(request, from)
      return { ok: true as const, state: await state() }
    } catch (error) {
      if (!(error instanceof AccountFailure)) console.error('[Galta] Account request failed', { action: request.action }, error)
      return { ok: false as const, error: error instanceof AccountFailure ? error.message : 'Something went wrong. Try again.', state: await state() }
    }
  })
}

async function perform(request: AccountRequest, from?: chrome.tabs.Tab) {
  switch (request.action) {
    case 'status': {
      const stored = await read()
      if (!stored.token || Date.now() - stored.checkedAt < CHECK_EVERY) return
      try {
        const { data } = await authorized(stored, '/get-session')
        await write(data ? { ...stored, user: userOf((data as { user?: unknown }).user), checkedAt: Date.now() } : { ended: true })
      } catch (error) {
        // Offline is ordinary for a local-first app: keep the session and check later.
        if (!(error instanceof AccountFailure) || error.message !== OFFLINE) throw error
      }
      return
    }
    case 'send-code': {
      const email = normalEmail(request.email)
      if (!email) throw new AccountFailure(COPY.INVALID_EMAIL!)
      await writeGoogle(null)
      await api('/email-otp/send-verification-otp', { body: { email, type: 'sign-in' } })
      return
    }
    case 'verify-code': {
      const email = normalEmail(request.email), code = request.code.trim()
      if (!email) throw new AccountFailure(COPY.INVALID_EMAIL!)
      if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)) throw new AccountFailure(`Enter the ${CODE_LENGTH}-digit code.`)
      const { data, token } = await api('/sign-in/email-otp', { body: { email, otp: code } })
      if (!token) throw new AccountFailure('The account service answered with no session. Try again.')
      await write({ token, user: userOf((data as { user?: unknown } | null)?.user), checkedAt: Date.now() })
      return
    }
    case 'google': {
      const handoff = randomId()
      const url = `${ACCOUNT_ORIGIN}${GOOGLE_PATH}?${new URLSearchParams({ extension: chrome.runtime.id, handoff })}`
      const tab = await chrome.tabs.create(from?.id !== undefined ? { url, openerTabId: from.id, index: from.index + 1, windowId: from.windowId } : { url })
      if (tab.id === undefined) throw new AccountFailure('Galta couldn’t open a tab for Google.')
      await writeGoogle({ handoff, tabId: tab.id, state: 'waiting' })
      return
    }
    case 'google-show': {
      const pending = await readGoogle()
      const tab = pending?.state === 'waiting' ? await chrome.tabs.get(pending.tabId).catch(() => null) : null
      if (!tab?.id) { await writeGoogle(null); throw new AccountFailure('The Google tab was closed. Start again.') }
      await chrome.tabs.update(tab.id, { active: true })
      await chrome.windows.update(tab.windowId, { focused: true })
      return
    }
    case 'google-cancel': {
      const pending = await readGoogle()
      await writeGoogle(null)
      if (pending?.state === 'waiting') await closeTab(pending.tabId)
      return
    }
    case 'rename': {
      const stored = await signedIn(), name = request.name.trim()
      if (name.length > 80) throw new AccountFailure('Use a name of 80 characters or fewer.')
      await authorized(stored, '/update-user', { name })
      await write({ ...stored, user: { ...stored.user, name } })
      return
    }
    case 'sign-out': {
      const stored = await read()
      const pending = await readGoogle()
      await writeGoogle(null)
      await write({})
      if (pending?.state === 'waiting') await closeTab(pending.tabId)
      if (stored.token) await api('/sign-out', { token: stored.token, body: {} }).catch(error => {
        // Signed out here either way; an unreachable service keeps the
        // discarded session until it expires.
        console.info('[Galta] The account service did not confirm sign-out', error instanceof Error ? error.message : error)
      })
      return
    }
    case 'delete': {
      const stored = await signedIn(), code = request.code.trim()
      if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)) throw new AccountFailure(`Enter the ${CODE_LENGTH}-digit code.`)
      // The code proves the person is here: it signs in afresh, and only a
      // fresh session may delete. Keep it, so a failed delete leaves them signed in.
      const { data, token } = await api('/sign-in/email-otp', { body: { email: stored.user.email, otp: code } })
      if (!token) throw new AccountFailure('The account service answered with no session. Try again.')
      const fresh = { token, user: userOf((data as { user?: unknown } | null)?.user), checkedAt: Date.now() }
      if (fresh.user.id !== stored.user.id) throw new AccountFailure('That code belongs to a different account.')
      await write(fresh)
      await authorized(fresh, '/delete-user', {})
      await write({})
      return
    }
  }
}

/** A Google sign-in hands its session to Galta from the service's page. */
export function receiveHandoff(message: unknown, sender: chrome.runtime.MessageSender): Promise<{ ok: true } | { ok: false; error: string }> {
  return serial(() => acceptHandoff(message, sender))
}

async function acceptHandoff(message: unknown, sender: chrome.runtime.MessageSender): Promise<{ ok: true } | { ok: false; error: string }> {
  if (sender.origin !== ACCOUNT_ORIGIN || !sender.url?.startsWith(`${ACCOUNT_ORIGIN}${HANDOFF_PATH}?`) || !isAccountHandoff(message)) return { ok: false, error: 'Galta didn’t accept this page.' }
  const pending = await readGoogle()
  if (pending?.state !== 'waiting' || pending.handoff !== message.handoff) return { ok: false, error: 'Galta isn’t waiting for this sign-in. Start again from Galta.' }
  if ('error' in message) {
    await writeGoogle({ ...pending, state: message.error })
  } else {
    let user: AccountUser
    try {
      const { data } = await api('/get-session', { token: message.token })
      user = userOf((data as { user?: unknown } | null)?.user)
    } catch (error) {
      await writeGoogle({ ...pending, state: 'failed' })
      return { ok: false, error: error instanceof AccountFailure ? error.message : 'Google sign-in didn’t finish. Return to Galta and try again.' }
    }
    await write({ token: message.token, user, checkedAt: Date.now() })
    await writeGoogle(null)
  }
  if (sender.tab?.id !== undefined) await closeTab(sender.tab.id)
  return { ok: true }
}

/** Closing the Google tab before it finishes cancels that sign-in. */
export function googleTabClosed(tabId: number) {
  return serial(async () => {
    const pending = await readGoogle()
    if (pending?.state === 'waiting' && pending.tabId === tabId) await writeGoogle(null)
  })
}

async function closeTab(tabId: number) {
  // The person may already have closed it; that is not an error.
  if (await chrome.tabs.get(tabId).catch(() => null)) await chrome.tabs.remove(tabId)
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
