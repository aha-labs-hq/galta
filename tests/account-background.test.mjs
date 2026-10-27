import { test, expect, beforeEach, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { ACCOUNT_ORIGIN } from '../apps/extension/src/shared/account.ts'

// The background's account owner against stubbed Chrome storage, tabs and
// network. The service has its own tests in aha-labs-hq/account.
const originalChrome = globalThis.chrome, originalFetch = globalThis.fetch
let local, session, tabs, accessLevel, routes, calls
const area = store => ({
  async get(key) { return key in store ? { [key]: store[key] } : {} },
  async set(values) { Object.assign(store, structuredClone(values)) },
  async remove(key) { delete store[key] },
  async setAccessLevel(options) { accessLevel = options.accessLevel },
})
globalThis.chrome = {
  runtime: { id: 'oocbicpnofichiglihkbmpkjegiakhgg' },
  storage: { local: area({}), session: area({}) },
  tabs: {
    async create(options) { const tab = { id: tabs.size + 10, windowId: 1, ...options }; tabs.set(tab.id, tab); return tab },
    async get(id) { if (!tabs.has(id)) throw new Error('No tab'); return tabs.get(id) },
    async update(id) { return tabs.get(id) },
    async remove(id) { tabs.delete(id) },
  },
  windows: { async update() {} },
}
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname.replace('/api/auth', '')
  calls.push({ path, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined, credentials: init.credentials })
  const route = routes[path]
  if (!route) throw new TypeError('Failed to fetch')
  const { status = 200, body = null, token } = await route(init)
  return new Response(JSON.stringify(body), { status, headers: token ? { 'set-auth-token': token } : {} })
}
const { handleAccount, receiveHandoff, googleTabClosed, protectAccountStorage } = await import('../apps/extension/src/background/account.ts')

const ADA = { id: 'u1', email: 'ada@example.com', name: '', image: null }
beforeEach(async () => {
  local = {}; session = {}; tabs = new Map(); routes = {}; calls = []
  chrome.storage.local = area(local); chrome.storage.session = area(session)
})
afterAll(() => { globalThis.chrome = originalChrome; globalThis.fetch = originalFetch })

async function signIn(user = ADA, token = 'token.signed') {
  routes['/email-otp/send-verification-otp'] = () => ({ body: { success: true } })
  routes['/sign-in/email-otp'] = () => ({ body: { token: 'raw', user }, token })
  expect(await handleAccount({ action: 'send-code', email: ' Ada@Example.com ' })).toMatchObject({ ok: true })
  return handleAccount({ action: 'verify-code', email: 'ada@example.com', code: '123456' })
}

test('content scripts cannot read the session: local storage is for trusted contexts only', async () => {
  await protectAccountStorage()
  expect(accessLevel).toBe('TRUSTED_CONTEXTS')
})

test('the manifest lets only the account service hand over a Google sign-in', () => {
  const manifest = JSON.parse(readFileSync('apps/extension/src/public/manifest.json', 'utf8'))
  expect(manifest.externally_connectable).toEqual({ matches: [`${ACCOUNT_ORIGIN}/*`] })
})

test('an email code signs in; answers to pages carry the person, not the token', async () => {
  const response = await signIn()
  expect(response).toEqual({ ok: true, state: { user: ADA, ended: false, google: null } })
  expect(calls[0]).toMatchObject({ path: '/email-otp/send-verification-otp', body: { email: 'ada@example.com', type: 'sign-in' }, credentials: 'omit' })
  expect(local['galta.account']).toMatchObject({ token: 'token.signed', user: ADA })
  expect(JSON.stringify(response)).not.toContain('token.signed')
})

test('codes and addresses are checked before anything is sent', async () => {
  expect(await handleAccount({ action: 'send-code', email: 'not an address' })).toMatchObject({ ok: false, error: 'Enter a valid email address.' })
  expect(await handleAccount({ action: 'verify-code', email: 'ada@example.com', code: '12' })).toMatchObject({ ok: false, error: 'Enter the 6-digit code.' })
  expect(calls).toEqual([])
})

test('the service’s refusals reach the person in plain words', async () => {
  routes['/sign-in/email-otp'] = () => ({ status: 400, body: { code: 'INVALID_OTP', message: 'Invalid OTP' } })
  expect(await handleAccount({ action: 'verify-code', email: 'ada@example.com', code: '000000' })).toMatchObject({ ok: false, error: 'That code isn’t right.' })
  routes['/email-otp/send-verification-otp'] = () => ({ status: 429, body: { code: 'RATE_LIMITED', message: 'Too many tries. Wait a minute, then try again.' } })
  expect(await handleAccount({ action: 'send-code', email: 'ada@example.com' })).toMatchObject({ ok: false, error: 'Too many tries. Wait a minute, then try again.' })
  routes['/email-otp/send-verification-otp'] = () => ({ status: 500, body: { message: 'internal detail' } })
  expect(await handleAccount({ action: 'send-code', email: 'ada@example.com' })).toMatchObject({ ok: false, error: 'Something went wrong. Try again.' })
  delete routes['/email-otp/send-verification-otp']
  expect((await handleAccount({ action: 'send-code', email: 'ada@example.com' })).error).toMatch(/can’t reach its account service/)
})

test('a stale session is checked; a revoked one signs out, an unreachable service keeps it', async () => {
  await signIn()
  local['galta.account'].checkedAt = 0
  routes['/get-session'] = () => ({ body: { user: { ...ADA, name: 'Ada' }, session: {} } })
  expect((await handleAccount({ action: 'status' })).state.user.name).toBe('Ada')
  expect(calls.at(-1)).toMatchObject({ path: '/get-session', auth: 'Bearer token.signed' })
  local['galta.account'].checkedAt = 0
  delete routes['/get-session']
  expect((await handleAccount({ action: 'status' }))).toMatchObject({ ok: true, state: { user: { name: 'Ada' } } })
  local['galta.account'].checkedAt = 0
  routes['/get-session'] = () => ({ body: null })
  expect((await handleAccount({ action: 'status' })).state).toEqual({ user: null, ended: true, google: null })
  // A fresh check is not repeated within the hour.
  await signIn()
  const before = calls.length
  await handleAccount({ action: 'status' })
  expect(calls.length).toBe(before)
})

test('a refused session ends the sign-in wherever it is noticed', async () => {
  await signIn()
  routes['/update-user'] = () => ({ status: 401, body: { code: 'UNAUTHORIZED' } })
  expect(await handleAccount({ action: 'rename', name: 'Ada' })).toMatchObject({ ok: false, error: 'Your session ended. Sign in again.', state: { user: null, ended: true } })
})

test('renaming keeps the session and updates every page’s copy', async () => {
  await signIn()
  routes['/update-user'] = () => ({ body: { status: true } })
  expect((await handleAccount({ action: 'rename', name: '  Ada Lovelace ' })).state.user.name).toBe('Ada Lovelace')
  expect(calls.at(-1).body).toEqual({ name: 'Ada Lovelace' })
  expect(await handleAccount({ action: 'rename', name: 'x'.repeat(81) })).toMatchObject({ ok: false })
})

test('signing out forgets the session here even when the service cannot be told', async () => {
  await signIn()
  expect((await handleAccount({ action: 'sign-out' })).state).toEqual({ user: null, ended: false, google: null })
  expect(local['galta.account']).toEqual({})
  expect(calls.at(-1)).toMatchObject({ path: '/sign-out', auth: 'Bearer token.signed' })
})

test('deleting an account signs in afresh with the code, then deletes', async () => {
  await signIn()
  routes['/sign-in/email-otp'] = () => ({ body: { user: ADA }, token: 'fresh.signed' })
  routes['/delete-user'] = init => ({ body: { success: init.headers.Authorization === 'Bearer fresh.signed' } })
  expect((await handleAccount({ action: 'delete', code: '654321' })).state).toEqual({ user: null, ended: false, google: null })
  expect(calls.slice(-2).map(call => call.path)).toEqual(['/sign-in/email-otp', '/delete-user'])
  expect(calls.at(-2).body).toEqual({ email: 'ada@example.com', otp: '654321' })
})

test('a failed delete leaves the person signed in with the fresh session', async () => {
  await signIn()
  routes['/sign-in/email-otp'] = () => ({ body: { user: ADA }, token: 'fresh.signed' })
  routes['/delete-user'] = () => ({ status: 500, body: {} })
  expect(await handleAccount({ action: 'delete', code: '654321' })).toMatchObject({ ok: false, state: { user: ADA } })
  expect(local['galta.account'].token).toBe('fresh.signed')
  routes['/sign-in/email-otp'] = () => ({ body: { user: { ...ADA, id: 'someone-else' } }, token: 'other.signed' })
  expect(await handleAccount({ action: 'delete', code: '654321' })).toMatchObject({ ok: false, error: 'That code belongs to a different account.' })
  expect(local['galta.account'].token).toBe('fresh.signed')
})

const page = (extra = '') => ({ origin: ACCOUNT_ORIGIN, url: `${ACCOUNT_ORIGIN}/signed-in?extension=x&handoff=y${extra}`, tab: { id: 10 } })
async function startGoogle() {
  expect((await handleAccount({ action: 'google' })).state.google).toBe('waiting')
  const tab = tabs.get(10), url = new URL(tab.url)
  expect(url.origin + url.pathname).toBe(`${ACCOUNT_ORIGIN}/google`)
  expect(url.searchParams.get('extension')).toBe('oocbicpnofichiglihkbmpkjegiakhgg')
  return url.searchParams.get('handoff')
}

test('Google sign-in: the tab hands over the session Galta asked for, then closes', async () => {
  const handoff = await startGoogle()
  expect(handoff).toMatch(/^[A-Za-z0-9_-]{43}$/)
  routes['/get-session'] = init => ({ body: init.headers.Authorization === 'Bearer google.signed' ? { user: ADA } : null })
  expect(await receiveHandoff({ type: 'aha-account-handoff', handoff, token: 'google.signed' }, page())).toEqual({ ok: true })
  expect(local['galta.account']).toMatchObject({ token: 'google.signed', user: ADA })
  expect(session['galta.account.google']).toBeUndefined()
  expect(tabs.has(10)).toBe(false)
})

test('Google sign-in refuses other pages, other requests and unasked handoffs', async () => {
  const message = { type: 'aha-account-handoff', handoff: 'x'.repeat(43), token: 'google.signed' }
  expect(await receiveHandoff(message, page())).toMatchObject({ ok: false })
  const handoff = await startGoogle()
  for (const sender of [{ ...page(), origin: 'https://evil.example' }, { ...page(), url: `${ACCOUNT_ORIGIN}/google?x` }]) {
    expect(await receiveHandoff({ ...message, handoff }, sender)).toMatchObject({ ok: false })
  }
  expect(await receiveHandoff(message, page())).toMatchObject({ ok: false })
  expect(await receiveHandoff({ type: 'aha-account-handoff', handoff, token: 'x', error: 'failed' }, page())).toMatchObject({ ok: false })
  expect(local['galta.account']).toBeUndefined()
  expect(session['galta.account.google'].state).toBe('waiting')
})

test('a cancelled Google sign-in says so; closing its tab simply ends it', async () => {
  let handoff = await startGoogle()
  expect(await receiveHandoff({ type: 'aha-account-handoff', handoff, error: 'cancelled' }, page())).toEqual({ ok: true })
  expect((await handleAccount({ action: 'status' })).state.google).toBe('cancelled')
  expect(tabs.size).toBe(0)
  handoff = await startGoogle()
  await googleTabClosed(10)
  expect((await handleAccount({ action: 'status' })).state.google).toBeNull()
  // Starting an email sign-in clears a past Google result.
  handoff = await startGoogle()
  await receiveHandoff({ type: 'aha-account-handoff', handoff, error: 'failed' }, page())
  routes['/email-otp/send-verification-otp'] = () => ({ body: { success: true } })
  expect((await handleAccount({ action: 'send-code', email: 'ada@example.com' })).state.google).toBeNull()
})

test('Galta can cancel the Google tab it opened', async () => {
  await startGoogle()
  expect((await handleAccount({ action: 'google-cancel' })).state.google).toBeNull()
  expect(tabs.size).toBe(0)
})

test('Google’s tab opens beside the Galta tab that asked, so closing it returns there', async () => {
  const from = { id: 4, index: 2, windowId: 7 }
  await handleAccount({ action: 'google' }, from)
  const tab = [...tabs.values()].at(-1)
  expect(tab).toMatchObject({ openerTabId: 4, index: 3, windowId: 7 })
})

test('a handoff that arrives after Cancel is refused; they never interleave', async () => {
  const handoff = await startGoogle()
  let release
  routes['/get-session'] = () => new Promise(resolve => { release = () => resolve({ body: { user: ADA } }) })
  const cancel = handleAccount({ action: 'google-cancel' })
  const landing = receiveHandoff({ type: 'aha-account-handoff', handoff, token: 'late.signed' }, page())
  await cancel
  expect(await landing).toMatchObject({ ok: false })
  expect(release).toBeUndefined()
  expect(local['galta.account']).toBeUndefined()
})

test('signing out also cancels a pending Google sign-in in another Galta page', async () => {
  await signIn()
  const handoff = await startGoogle()
  routes['/get-session'] = () => ({ body: { user: ADA } })
  await handleAccount({ action: 'sign-out' })
  expect(await receiveHandoff({ type: 'aha-account-handoff', handoff, token: 'late.signed' }, page())).toMatchObject({ ok: false })
  expect((await handleAccount({ action: 'status' })).state.user).toBeNull()
  expect(tabs.size).toBe(0)
})

test('closing the new Google tab while it opens cannot leave a phantom wait', async () => {
  const create = chrome.tabs.create
  let closed
  chrome.tabs.create = async options => {
    const tab = await create(options)
    tabs.delete(tab.id)
    closed = googleTabClosed(tab.id)
    return tab
  }
  try {
    await handleAccount({ action: 'google' })
    await closed
    expect((await handleAccount({ action: 'status' })).state.google).toBeNull()
  } finally { chrome.tabs.create = create }
})
