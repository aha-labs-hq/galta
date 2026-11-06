import type { SpeechGrantRequest } from '../../../packages/capture/src/cloudSpeech'

// Admission limits, not a billing meter. Reserve conservatively before AI;
// uncertain upstream failures are never refunded into an attacker's budget.
export const SPEECH_ALLOWANCE = { accountSeconds: 1800, totalSeconds: 10_000, minimumSeconds: 5, grantsPerMinute: 6, grantLifetimeMs: 120_000 } as const
const dayOf = (now: number) => Math.floor(now / 86_400_000)
type Usage = { seconds: number; window: number; grants: number }
type Grant = { account: string; id: string; digest: string; expires: number }
export type Admission = { ok: true } | { ok: false; status: 403 | 429; error: string }

/** One ledger per upstream credential. It serializes only tiny admission
 * transactions, never audio uploads or inference. No audio or transcript lives here. */
export class SpeechLedger {
  constructor(private readonly storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS usage (account TEXT PRIMARY KEY, day INTEGER NOT NULL, seconds INTEGER NOT NULL, window INTEGER NOT NULL, grants INTEGER NOT NULL)')
    storage.sql.exec('CREATE TABLE IF NOT EXISTS grants (token TEXT PRIMARY KEY, account TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, expires INTEGER NOT NULL)')
    storage.sql.exec('CREATE INDEX IF NOT EXISTS grant_expiry ON grants(expires)')
  }
  private usage(account: string, now: number): Usage {
    return this.storage.sql.exec<Usage>('SELECT seconds, window, grants FROM usage WHERE account = ? AND day = ?', account, dayOf(now)).toArray()[0]
      ?? { seconds: 0, window: now, grants: 0 }
  }
  private save(account: string, now: number, usage: Usage) {
    this.storage.sql.exec('INSERT OR REPLACE INTO usage (account, day, seconds, window, grants) VALUES (?, ?, ?, ?, ?)', account, dayOf(now), usage.seconds, usage.window, usage.grants)
  }
  grant(account: string, request: SpeechGrantRequest, now = Date.now()) {
    return this.storage.transactionSync(() => {
      this.prune(now)
      const usage = this.usage(account, now), total = this.usage('*', now)
      if (usage.seconds >= SPEECH_ALLOWANCE.accountSeconds || total.seconds >= SPEECH_ALLOWANCE.totalSeconds)
        return { ok: false as const, code: 'rate_limit' as const, error: 'Today’s speech allowance is used. Your recording is saved; try again tomorrow.' }
      if (now - usage.window >= 60_000) { usage.window = now; usage.grants = 0 }
      if (usage.grants >= SPEECH_ALLOWANCE.grantsPerMinute)
        return { ok: false as const, code: 'rate_limit' as const, error: 'Too many recordings at once. Your recording is saved; try again in a minute.' }
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('')
      const expiresAt = now + SPEECH_ALLOWANCE.grantLifetimeMs
      this.save(account, now, { ...usage, grants: usage.grants + 1 })
      this.storage.sql.exec('INSERT INTO grants VALUES (?, ?, ?, ?, ?)', token, account, request.id, request.digest, expiresAt)
      return { ok: true as const, token, expiresAt }
    })
  }
  consume(token: string, request: SpeechGrantRequest, seconds: number, now = Date.now()): Admission {
    return this.storage.transactionSync(() => {
      const grant = this.storage.sql.exec<Grant>('SELECT account, id, digest, expires FROM grants WHERE token = ?', token).toArray()[0]
      if (!grant || grant.expires <= now || grant.id !== request.id || grant.digest !== request.digest)
        return { ok: false, status: 403, error: 'Speech authorization expired or does not match this recording. Your recording is saved; send again.' }
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error('Invalid admission duration')
      const cost = Math.max(SPEECH_ALLOWANCE.minimumSeconds, Math.ceil(seconds))
      const usage = this.usage(grant.account, now), total = this.usage('*', now)
      if (usage.seconds + cost > SPEECH_ALLOWANCE.accountSeconds || total.seconds + cost > SPEECH_ALLOWANCE.totalSeconds)
        return { ok: false, status: 429, error: 'Today’s speech allowance is used. Your recording is saved; try again tomorrow.' }
      this.storage.sql.exec('DELETE FROM grants WHERE token = ?', token)
      this.save(grant.account, now, { ...usage, seconds: usage.seconds + cost })
      this.save('*', now, { ...total, seconds: total.seconds + cost })
      return { ok: true }
    })
  }
  prune(now = Date.now()) {
    this.storage.sql.exec('DELETE FROM grants WHERE expires <= ?', now)
    this.storage.sql.exec('DELETE FROM usage WHERE day < ?', dayOf(now))
  }
  get occupied() {
    return this.storage.sql.exec<{ count: number }>('SELECT (SELECT COUNT(*) FROM grants) + (SELECT COUNT(*) FROM usage) AS count').one().count > 0
  }
}
