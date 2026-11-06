import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SpeechLedger, SPEECH_ALLOWANCE } from '../apps/speech-worker/src/ledger.ts'
import worker from '../apps/speech-worker/src/index.ts'
import { prepareSpeechAudio } from '../packages/capture/src/speechAudio.ts'
import { speechDigest } from '../packages/capture/src/cloudSpeech.ts'

function fixture() {
  const db = new Database(':memory:')
  const storage = { sql: { exec(sql, ...args) {
    const rows = db.query(sql).all(...args)
    return { toArray: () => rows, one: () => { expect(rows).toHaveLength(1); return rows[0] } }
  } }, transactionSync: fn => db.transaction(fn)() }
  const ledger = new SpeechLedger(storage)
  let calls = 0, accountCalls = 0
  const env = {
    ENABLED: 'true', SPEECH_LIMIT: { limit: async () => ({ success: true }) },
    SPEECH_BUDGET: { getByName: () => ledger },
    ACCOUNT: { fetch: async (url, options) => {
      accountCalls++
      expect(url).toBe('https://account.ahalabs.site/api/auth/get-session')
      expect(Object.keys(options.headers)).toEqual(['Authorization'])
      return Response.json(options.headers.Authorization === 'Bearer session.signed'
        ? { user: { id: 'user-a', emailVerified: true }, session: { userId: 'user-a', expiresAt: new Date(Date.now() + 3600000).toISOString() } } : null)
    } },
    AI: { run: async () => { calls++; return { text: 'hello', segments: [{ words: [{ word: 'hello', start: .1, end: .5 }] }] } } },
  }
  return { db, storage, ledger, env, calls: () => calls, accountCalls: () => accountCalls }
}
const headers = { Origin: 'http://127.0.0.1:4471', 'CF-Connecting-IP': '192.0.2.1' }
const audio = prepareSpeechAudio(new Float32Array(16000)).wav
const input = async () => ({ id: crypto.randomUUID(), digest: await speechDigest(audio) })
const auth = (value, token = 'session.signed') => new Request('https://speech.galta.art/v1/authorize', {
  method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(value),
})
const transcribe = (value, token, body = audio) => new Request('https://speech.galta.art/v1/transcribe', {
  method: 'POST', headers: { ...headers, 'Content-Type': 'audio/wav', 'X-Galta-Recording': value.id, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body,
})

test('spoofed origins, random UUIDs and arbitrary bearer strings cannot spend inference', async () => {
  const f = fixture(), request = await input()
  expect((await worker.fetch(transcribe(request), f.env)).status).toBe(401)
  expect((await worker.fetch(transcribe(request, 'f'.repeat(64)), f.env)).status).toBe(403)
  expect((await worker.fetch(auth(request, 'fake-session'), f.env)).status).toBe(401)
  expect(f.calls()).toBe(0)
  expect(f.accountCalls()).toBe(1)
  f.db.close()
})
test('verified session mints an audio-bound one-use grant; concurrent replay makes one model call', async () => {
  const f = fixture(), request = await input()
  const response = await worker.fetch(auth(request), f.env), grant = await response.json()
  expect(response.status).toBe(200); expect(grant.token).toMatch(/^[0-9a-f]{64}$/)
  expect(JSON.stringify(grant)).not.toContain('user-a'); expect(JSON.stringify(grant)).not.toContain('session.signed')
  const changed = audio.slice(); changed[44] = 1
  expect((await worker.fetch(transcribe(request, grant.token, changed), f.env)).status).toBe(403)
  expect((await worker.fetch(transcribe({ ...request, id: crypto.randomUUID() }, grant.token), f.env)).status).toBe(403)
  const results = await Promise.all(Array.from({ length: 12 }, () => worker.fetch(transcribe(request, grant.token), f.env)))
  expect(results.filter(r => r.status === 200)).toHaveLength(1)
  expect(results.filter(r => r.status === 403)).toHaveLength(11)
  expect(f.calls()).toBe(1)
  f.db.close()
})
test('expired, unverified, revoked sessions and account outages fail closed before granting', async () => {
  const f = fixture(), request = await input()
  for (const data of [null, { user: { id: 'user-a', emailVerified: false }, session: { userId: 'user-a', expiresAt: '2099-01-01' } },
    { user: { id: 'user-a', emailVerified: true }, session: { userId: 'other', expiresAt: '2099-01-01' } },
    { user: { id: 'user-a', emailVerified: true }, session: { userId: 'user-a', expiresAt: '2000-01-01' } }]) {
    f.env.ACCOUNT.fetch = async () => Response.json(data)
    expect((await worker.fetch(auth(request), f.env)).status).toBe(401)
  }
  for (const status of [302, 503]) {
    f.env.ACCOUNT.fetch = async () => new Response(null, { status, headers: { Location: 'https://untrusted.invalid/' } })
    expect((await worker.fetch(auth(request), f.env)).status).toBe(503)
  }
  expect(f.calls()).toBe(0)
  expect(f.db.query('SELECT count(*) AS n FROM grants').get().n).toBe(0)
  f.db.close()
})
test('one account limit follows devices while another account on the same network is independent', async () => {
  const f = fixture(), request = await input(), now = Date.now()
  for (let i = 0; i < SPEECH_ALLOWANCE.grantsPerMinute; i++) expect(f.ledger.grant('a'.repeat(64), request, now).ok).toBe(true)
  expect(f.ledger.grant('a'.repeat(64), request, now).ok).toBe(false)
  expect(f.ledger.grant('b'.repeat(64), request, now).ok).toBe(true)
  expect(f.ledger.grant('a'.repeat(64), request, now + 60_000).ok).toBe(true)
  f.db.close()
})
test('daily account and credential budgets are reserved atomically and survive a ledger reload', async () => {
  const f = fixture(), request = await input(), start = Math.floor(Date.now() / 86400000) * 86400000 + 1000
  let accepted = 0
  for (let i = 0; i < 240; i++) {
    const now = start + i * 60_001, account = String(Math.floor(i / 30)).padStart(64, '0')
    const grant = f.ledger.grant(account, request, now)
    if (grant.ok && f.ledger.consume(grant.token, request, 60, now).ok) accepted++
  }
  expect(accepted).toBe(Math.floor(SPEECH_ALLOWANCE.totalSeconds / 60))
  expect(f.db.query("SELECT seconds FROM usage WHERE account = '*'").get().seconds).toBe(accepted * 60)
  // A recreated owner sees the same durable counters, not an in-memory allowance.
  const reloaded = new SpeechLedger(f.storage)
  const last = reloaded.grant('a'.repeat(64), request, start + 240 * 60_001)
  expect(last.ok).toBe(true)
  expect(reloaded.consume(last.token, request, 60, start + 240 * 60_001).ok).toBe(false)
  const tomorrow = start + 86400000
  const next = f.ledger.grant('a'.repeat(64), request, tomorrow)
  expect(f.ledger.consume(next.token, request, 60, tomorrow).ok).toBe(true)
  f.db.close()
})
test('grant expiry and UTC reset preserve valid cross-midnight submissions', async () => {
  const f = fixture(), request = await input(), midnight = (Math.floor(Date.now() / 86400000) + 1) * 86400000
  const grant = f.ledger.grant('a'.repeat(64), request, midnight - 1000)
  f.ledger.prune(midnight)
  expect(f.ledger.consume(grant.token, request, 1, midnight + 1000).ok).toBe(true)
  expect(f.db.query("SELECT seconds FROM usage WHERE account = '*'").get().seconds).toBe(SPEECH_ALLOWANCE.minimumSeconds)
  const expired = f.ledger.grant('b'.repeat(64), request, midnight)
  expect(f.ledger.consume(expired.token, request, 1, midnight + SPEECH_ALLOWANCE.grantLifetimeMs).ok).toBe(false)
  f.db.close()
})
