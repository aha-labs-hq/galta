import { test, expect } from 'bun:test'
import { CodexConnection } from '../apps/extension/src/canvas/codexConnection.ts'

const connected = usedPercent => ({ ok: true, account: { type: 'chatgpt', planType: 'pro' }, models: [{ id: 'test-model' }], rateLimits: { primary: { usedPercent } } })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
function fixture() {
  let listener, next = connected(97), reads = 0
  const client = {
    connect: async () => { reads++; return next },
    login: async () => ({ ok: true }),
    subscribe: callback => { listener = callback; return () => { listener = null } }
  }
  const store = new CodexConnection(client), stop = store.start()
  return { store, client, stop, emit: (method, params = {}) => listener?.({ method, params }), set: value => { next = value }, reads: () => reads }
}

test('refresh failure removes the entire old snapshot and successful recovery clears the error', async () => {
  const f = fixture()
  await f.store.connect()
  expect(f.store.getSnapshot()).toMatchObject({ status: 'connected', data: connected(97) })
  f.set({ ok: true, requiresAuth: true, error: 'Sign in again.' })
  await f.store.refresh()
  expect(f.store.getSnapshot()).toEqual({ status: 'sign-in-required', error: 'Sign in again.' })
  f.set(connected(36))
  await f.store.refresh()
  expect(f.store.getSnapshot()).toEqual({ status: 'connected', data: connected(36), error: null, refreshing: false })
  f.stop()
})

test('unavailable usage clears the previous percentage while retaining the account', async () => {
  const f = fixture()
  await f.store.connect()
  const { rateLimits, ...withoutUsage } = connected(97)
  f.set({ ...withoutUsage, usageError: 'Usage is unavailable.' })
  await f.store.refresh()
  expect(f.store.getSnapshot()).toMatchObject({ status: 'connected', error: 'Usage is unavailable.' })
  expect(f.store.getSnapshot().data.rateLimits).toBeUndefined()
  f.emit('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 38 } } })
  expect(f.store.getSnapshot()).toMatchObject({ error: null, data: { rateLimits: { primary: { usedPercent: 38 } } } })
  expect(f.store.getSnapshot().data.usageError).toBeUndefined()
  f.stop()
})

test('simultaneous focus/menu reads share one request and newer pushed usage survives the older response', async () => {
  const f = fixture()
  await f.store.connect()
  const read = deferred(); f.set(read.promise)
  const first = f.store.refresh(), second = f.store.refresh()
  expect(first).toBe(second)
  expect(f.reads()).toBe(2)
  f.emit('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 42 } } })
  read.resolve(connected(36)); await first
  expect(f.store.getSnapshot().data.rateLimits.primary.usedPercent).toBe(42)
  f.stop()
})

test('logout invalidates pending reads so a late response cannot restore the old account', async () => {
  const f = fixture()
  await f.store.connect()
  const read = deferred(); f.set(read.promise)
  const pending = f.store.refresh()
  f.emit('account/updated', { authMode: null })
  expect(f.store.getSnapshot()).toEqual({ status: 'sign-in-required', error: null })
  read.resolve(connected(97)); await pending
  expect(f.store.getSnapshot()).toEqual({ status: 'sign-in-required', error: null })
  f.stop()
})

test('account switching fences old reads and immediately removes the old plan and quota', async () => {
  const f = fixture()
  await f.store.connect()
  const old = deferred(); f.set(old.promise)
  const pending = f.store.refresh()
  const replacement = deferred(); f.set(replacement.promise)
  f.emit('account/updated', { authMode: 'chatgpt', planType: 'plus' })
  expect(f.store.getSnapshot()).toEqual({ status: 'connecting', error: null })
  replacement.resolve({ ...connected(2), account: { type: 'chatgpt', planType: 'plus' } }); await flush()
  old.resolve(connected(97)); await pending
  expect(f.store.getSnapshot()).toMatchObject({ status: 'connected', data: { account: { planType: 'plus' }, rateLimits: { primary: { usedPercent: 2 } } } })
  f.stop()
})

test('login completion before popup creation cannot be overwritten by the login-start response', async () => {
  const f = fixture(), opening = deferred()
  f.client.login = () => opening.promise
  const login = f.store.signIn()
  expect(f.store.signIn()).toBe(login)
  f.set(connected(36)); f.emit('account/login/completed', { success: true })
  await flush()
  opening.resolve({ ok: true }); await login
  expect(f.store.getSnapshot()).toMatchObject({ status: 'connected', data: connected(36), error: null })
  f.stop()
})

test('disconnect and disposal fence requests, while explicit reconnect obtains a fresh snapshot', async () => {
  const f = fixture(), read = deferred(); f.set(read.promise)
  const pending = f.store.connect()
  f.emit('galta/connection-lost', { message: 'Host exited' })
  read.resolve(connected(97)); await pending
  expect(f.store.getSnapshot()).toEqual({ status: 'error', error: 'Host exited' })
  f.set(connected(36)); await f.store.connect()
  const closing = deferred(); f.set(closing.promise)
  const closingRead = f.store.refresh(); f.stop()
  closing.resolve({ ok: true, requiresAuth: true }); await closingRead
  expect(f.store.getSnapshot().status).toBe('connected')
})

test('only Codex usage notifications apply and a completed turn refreshes usage', async () => {
  const f = fixture(); await f.store.connect()
  f.emit('account/rateLimits/updated', { rateLimits: { limitId: 'other', primary: { usedPercent: 100 } } })
  expect(f.store.getSnapshot().data.rateLimits.primary.usedPercent).toBe(97)
  f.set(connected(98)); f.emit('turn/completed'); await flush()
  expect(f.store.getSnapshot().data.rateLimits.primary.usedPercent).toBe(98)
  f.stop()
})

test('an idle quota window refreshes once at its reported reset without inventing usage or polling', async () => {
  const f = fixture(), resetsAt = Math.floor(Date.now() / 1000) + 1
  f.set({ ...connected(97), rateLimits: { primary: { usedPercent: 97, resetsAt } } })
  await f.store.connect()
  // The provider remains authoritative even if its first read after the deadline
  // still reports the old reset time. This must not become a retry loop.
  f.set({ ...connected(4), rateLimits: { primary: { usedPercent: 4, resetsAt } } })
  try {
    await new Promise(resolve => setTimeout(resolve, resetsAt * 1000 - Date.now() + 50))
    expect(f.reads()).toBe(2)
    expect(f.store.getSnapshot().data.rateLimits.primary.usedPercent).toBe(4)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(f.reads()).toBe(2)
  } finally { f.stop() }
})

test('logout and disposal cancel quota deadlines belonging to the previous observer', async () => {
  const loggedOut = fixture(), disposed = fixture(), resetsAt = Math.floor(Date.now() / 1000) + 1
  for (const f of [loggedOut, disposed]) {
    f.set({ ...connected(97), rateLimits: { primary: { usedPercent: 97, resetsAt } } })
    await f.store.connect()
    f.set(connected(0))
  }
  loggedOut.emit('account/updated', { authMode: null })
  disposed.stop()
  try {
    await new Promise(resolve => setTimeout(resolve, resetsAt * 1000 - Date.now() + 50))
    expect(loggedOut.reads()).toBe(1)
    expect(loggedOut.store.getSnapshot().status).toBe('sign-in-required')
    expect(disposed.reads()).toBe(1)
  } finally { loggedOut.stop() }
})
