import { DurableObject } from 'cloudflare:workers'
import { SpeechLedger } from './ledger'
import { isSpeechGrantRequest, type SpeechGrantRequest } from '../../../packages/capture/src/cloudSpeech'

export class SpeechBudget extends DurableObject<Env> {
  private readonly ledger: SpeechLedger
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); this.ledger = new SpeechLedger(ctx.storage) }
  async grant(account: string, request: SpeechGrantRequest) {
    if (!/^[0-9a-f]{64}$/.test(account) || !isSpeechGrantRequest(request)) throw new Error('Invalid grant')
    if (await this.ctx.storage.getAlarm() === null) await this.scheduleCleanup()
    return this.ledger.grant(account, request)
  }
  consume(token: string, request: SpeechGrantRequest, seconds: number) {
    if (!/^[0-9a-f]{64}$/.test(token) || !isSpeechGrantRequest(request)) throw new Error('Invalid admission')
    return this.ledger.consume(token, request, seconds)
  }
  async alarm() {
    this.ledger.prune()
    if (this.ledger.occupied) await this.scheduleCleanup()
  }
  private scheduleCleanup() {
    return this.ctx.storage.setAlarm((Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000 + 120_000)
  }
}
