import { test, expect, beforeEach, afterEach } from 'bun:test'
import { NativeCodexAdapter } from '../apps/extension/src/background/codexAdapter.ts'
import { CODEX_SIGN_IN_REQUIRED, CODEX_USAGE_UNAVAILABLE, CodexRequestError, isCodexAuthError } from '../apps/extension/src/background/codexAccount.ts'
import { readCodexUsage } from '../apps/extension/src/shared/codexUsage.ts'
import { CodexConnection } from '../apps/extension/src/canvas/codexConnection.ts'
import { compatibleCodexConfig } from './helpers/codex-config.ts'

const account = { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true }
const limits = percent => ({ rateLimits: { limitId: 'codex', primary: { usedPercent: percent } } })
const revoked = () => new CodexRequestError('account/rateLimits/read', -32000, 'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; content-type=text/plain; body={ "error": { "message": "Encountered invalidated oauth token for user, failing request", "code": "token_revoked" }, "status": 401 }')
let originalChrome
beforeEach(() => { originalChrome = globalThis.chrome; globalThis.chrome = { runtime: { sendMessage: async () => {} } } })
afterEach(() => { globalThis.chrome = originalChrome })

test('a revoked token is recovered once by Codex before returning a fresh account snapshot; concurrent canvases share the recovery', async () => {
  const bridge = new NativeCodexAdapter(), calls = []
  let refreshed = false
  bridge.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'account/read') { refreshed ||= params.refreshToken; return account }
    if (method === 'model/list') return { data: [{ id: 'test-model' }] }
    if (!refreshed) throw revoked()
    return limits(36)
  }
  const responses = await Promise.all([bridge.connect(), bridge.connect(), bridge.connect()])
  for (const response of responses) expect(response).toMatchObject({ ok: true, account: account.account, rateLimits: { primary: { usedPercent: 36 } } })
  expect(calls.filter(call => call.method === 'account/read')).toEqual([
    { method: 'account/read', params: { refreshToken: false } },
    { method: 'account/read', params: { refreshToken: true } }
  ])
  expect(calls.filter(call => call.method === 'account/rateLimits/read')).toHaveLength(2)
})

test('unrecoverable auth presents sign-in with no account, catalog, usage or raw response body', async () => {
  for (const recovery of ['revoked', 'refresh-reused', 'missing-account']) {
    const bridge = new NativeCodexAdapter(), calls = []
    bridge.request = async (method, params) => {
      calls.push({ method, params })
      if (method === 'model/list') return { data: [{ id: 'old-model' }] }
      if (method === 'account/rateLimits/read') throw revoked()
      if (params.refreshToken && recovery === 'refresh-reused') throw new CodexRequestError(method, -32000, 'Your refresh token has already been used. Please log out and sign in again.')
      if (params.refreshToken && recovery === 'missing-account') return { account: null, requiresOpenaiAuth: true }
      return account
    }
    const result = await bridge.connect()
    expect(result).toEqual({ ok: true, requiresAuth: true, ...(recovery === 'missing-account' ? {} : { error: CODEX_SIGN_IN_REQUIRED }) })
    expect(calls.filter(call => call.params?.refreshToken)).toHaveLength(1)
    expect(calls.some(call => call.method === 'account/login/start')).toBe(false)
  }
})

test('usage service failures keep a usable account but never report stale or zero usage', async () => {
  for (const failure of [new CodexRequestError('account/rateLimits/read', -32000, '503 service unavailable'), new CodexRequestError('account/rateLimits/read', -32000, 'request timed out')]) {
    const bridge = new NativeCodexAdapter(), calls = []
    bridge.request = async (method, params) => {
      calls.push({ method, params })
      if (method === 'account/read') return account
      if (method === 'model/list') return { data: [{ id: 'test-model' }] }
      throw failure
    }
    expect(await bridge.connect()).toEqual({ ok: true, account: account.account, models: [{ id: 'test-model' }], usageError: CODEX_USAGE_UNAVAILABLE })
    expect(calls.some(call => call.params?.refreshToken)).toBe(false)
  }
})

test('a lost native transport while reading usage cannot report a connected account', async () => {
  const bridge = new NativeCodexAdapter()
  bridge.request = async method => {
    if (method === 'account/read') return account
    if (method === 'model/list') return { data: [] }
    throw new Error('Built-in chat disconnected.')
  }
  expect(await bridge.connect()).toEqual({ ok: false, error: 'Built-in chat disconnected.' })
})

test('network failure during forced refresh is actionable without falsely declaring revocation', async () => {
  const bridge = new NativeCodexAdapter()
  bridge.request = async (method, params) => {
    if (method === 'account/read') {
      if (params.refreshToken) throw new CodexRequestError(method, -32000, '502 Bad Gateway; body=private response')
      return account
    }
    if (method === 'model/list') return { data: [] }
    throw revoked()
  }
  expect(await bridge.connect()).toEqual({ ok: false, error: 'Could not check your Codex account. Try connecting again.' })
})

test('account read failures recover through the same bounded auth path', async () => {
  const bridge = new NativeCodexAdapter(), calls = []
  bridge.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'account/read') {
      if (!params.refreshToken) throw revoked()
      return account
    }
    if (method === 'model/list') return { data: [] }
    return limits(0)
  }
  expect(await bridge.connect()).toMatchObject({ ok: true, rateLimits: { primary: { usedPercent: 0 } } })
  expect(calls.filter(call => call.params?.refreshToken)).toHaveLength(1)
})

test('usage selects the canonical bucket and does not substitute another product or malformed value', () => {
  expect(readCodexUsage({ ...limits(97), rateLimitsByLimitId: { codex: limits(36).rateLimits } })).toEqual({ primary: { usedPercent: 36 } })
  for (const value of [-1, 101, NaN, Infinity, '36', null]) expect(readCodexUsage(limits(value))).toBeUndefined()
  expect(readCodexUsage({ ...limits(97), rateLimitsByLimitId: { other: limits(36).rateLimits } })).toBeUndefined()
  expect(readCodexUsage({ rateLimits: { limitId: 'other', primary: { usedPercent: 99 } } })).toBeUndefined()
})

test('auth classification preserves structured RPC data and never treats throttling or server outages as sign-out', () => {
  expect(isCodexAuthError(new CodexRequestError('account/read', -32000, 'request failed', { status: 401 }))).toBe(true)
  expect(isCodexAuthError(new CodexRequestError('account/read', -32000, 'request failed', { code: 'refresh_token_expired' }))).toBe(true)
  for (const message of ['429 Too Many Requests', '403 Forbidden', '500 Internal Server Error', 'network timeout']) expect(isCodexAuthError(new Error(message))).toBe(false)
})

test('native JSON-RPC errors preserve structured auth status through credential recovery', async () => {
  const listeners = new Set(), calls = []
  let refreshed = false
  globalThis.chrome.runtime.connectNative = () => ({
    onMessage: { addListener: fn => listeners.add(fn) }, onDisconnect: { addListener() {} }, disconnect() {},
    postMessage(message) {
      if (message.id === undefined) return
      calls.push(message)
      let result = {}
      if (message.method === 'config/read') result = compatibleCodexConfig()
      if (message.method === 'account/read') { refreshed ||= message.params.refreshToken; result = account }
      if (message.method === 'model/list') result = { data: [] }
      if (message.method === 'account/rateLimits/read') result = limits(36)
      const response = message.method === 'account/rateLimits/read' && !refreshed
        ? { id: message.id, error: { code: -32000, message: 'Request rejected', data: { status: 401 } } }
        : { id: message.id, result }
      queueMicrotask(() => listeners.forEach(fn => fn(response)))
    }
  })
  const bridge = new NativeCodexAdapter()
  expect(await bridge.connect()).toMatchObject({ ok: true, rateLimits: { primary: { usedPercent: 36 } } })
  expect(calls.filter(call => call.method === 'account/read' && call.params.refreshToken)).toHaveLength(1)
})

test('a terminal auth failure reaches every workspace observer, including views that did not request a refresh', async () => {
  const bridge = new NativeCodexAdapter()
  let expired = false
  bridge.request = async method => {
    if (method === 'account/read') return account
    if (method === 'model/list') return { data: [] }
    if (expired) throw revoked()
    return limits(97)
  }
  const client = { connect: () => bridge.connect(), login: async () => ({ ok: true }), subscribe: fn => bridge.subscribe(fn) }
  const first = new CodexConnection(client), second = new CodexConnection(client)
  const stopFirst = first.start(), stopSecond = second.start()
  try {
    await Promise.all([first.connect(), second.connect()])
    expired = true
    await first.refresh()
    for (const store of [first, second]) expect(store.getSnapshot()).toEqual({ status: 'sign-in-required', error: CODEX_SIGN_IN_REQUIRED })
  } finally { stopFirst(); stopSecond() }
})

test('an account change queues a fresh shared check and suppresses an obsolete sign-in notification', async () => {
  const bridge = new NativeCodexAdapter(), notifications = []
  let release, reads = 0
  const held = new Promise(resolve => { release = resolve })
  bridge.subscribe(notification => notifications.push(notification))
  bridge.request = async method => {
    if (method === 'account/read') return ++reads === 1 ? held : account
    if (method === 'model/list') return { data: [] }
    return limits(36)
  }
  const old = bridge.connect()
  bridge.handleMessage({ method: 'account/updated', params: { authMode: 'chatgpt' } })
  const next = bridge.connect()
  release({ account: null, requiresOpenaiAuth: true })
  expect(await old).toEqual({ ok: true, requiresAuth: true })
  expect(await next).toMatchObject({ ok: true, rateLimits: { primary: { usedPercent: 36 } } })
  expect(reads).toBe(2)
  expect(notifications.some(notification => notification.method === 'galta/auth-required')).toBe(false)
})

test('a person who never signed in is asked to sign in, with no error', async () => {
  const bridge = new NativeCodexAdapter(), notifications = []
  bridge.subscribe(notification => notifications.push(notification))
  bridge.request = async method => { if (method === 'account/read') return { account: null, requiresOpenaiAuth: true }; throw new Error(`unexpected ${method}`) }
  expect(await bridge.connect()).toEqual({ ok: true, requiresAuth: true })
  const required = notifications.filter(notification => notification.method === 'galta/auth-required')
  expect(required).toHaveLength(1)
  expect(required[0].params.message).toBeNull()
})

test('malformed account state cannot silently select a provider without authentication', async () => {
  for (const result of [{}, { requiresOpenaiAuth: false }, { account: {}, requiresOpenaiAuth: false }]) {
    const bridge = new NativeCodexAdapter(), methods = []
    bridge.request = async method => { methods.push(method); return result }
    expect(await bridge.connect()).toEqual({ ok: false, error: 'Codex returned an invalid account response' })
    expect(methods).toEqual(['account/read'])
  }
})

test('a failed check for a former account cannot force-refresh its replacement', async () => {
  const bridge = new NativeCodexAdapter(), calls = []
  let rejectOld, reads = 0
  const held = new Promise((_, reject) => { rejectOld = reject })
  bridge.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'account/read') return ++reads === 1 ? held : account
    if (method === 'model/list') return { data: [] }
    return limits(36)
  }
  const old = bridge.connect()
  bridge.handleMessage({ method: 'account/updated', params: { authMode: 'chatgpt' } })
  const next = bridge.connect()
  rejectOld(revoked())
  expect((await old).ok).toBe(false)
  expect(await next).toMatchObject({ ok: true, rateLimits: { primary: { usedPercent: 36 } } })
  expect(calls.some(call => call.params?.refreshToken === true)).toBe(false)
})

test('login RPC failures do not expose upstream response bodies as product copy', async () => {
  globalThis.chrome.windows = { getLastFocused: async () => ({ id: 1 }) }
  const bridge = new NativeCodexAdapter()
  bridge.request = async () => { throw new CodexRequestError('account/login/start', -32000, '502 Bad Gateway; body=private response') }
  expect(await bridge.login()).toEqual({ ok: false, error: 'Could not start ChatGPT sign-in. Try again.' })
})
