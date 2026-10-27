import type { CodexJsonRpcNotification } from '@galta/runtime'
import type { CodexConnected, CodexConnectResponse, CodexLoginResponse } from '../shared/messages'
import { readCodexUsage } from '../shared/codexUsage'

type AccountClient = {
  connect(): Promise<CodexConnectResponse>
  login(): Promise<CodexLoginResponse>
  subscribe(listener: (notification: CodexJsonRpcNotification) => void): () => void
}

export type CodexConnectionState =
  | { status: 'connected'; data: CodexConnected; refreshing: boolean; error: string | null }
  | { status: 'disconnected' | 'connecting' | 'sign-in-required' | 'error'; error: string | null }

/** One account snapshot for the workspace, independent of the selected canvas. */
export class CodexConnection {
  private state: CodexConnectionState = { status: 'disconnected', error: null }
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private usageRevision = 0
  private pending: { promise: Promise<void> } | null = null
  private loginPending: Promise<void> | null = null
  private active = false
  private quotaDeadline: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly client: AccountClient) {}

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  start(): () => void {
    if (this.active) throw new Error('Codex account observer is already started')
    this.active = true
    this.scheduleQuotaRead()
    const unsubscribe = this.client.subscribe(this.receive)
    return () => { this.active = false; this.invalidate(); unsubscribe() }
  }

  private publish(state: CodexConnectionState) {
    this.state = state
    this.scheduleQuotaRead()
    for (const listener of this.listeners) listener()
  }

  private clearQuotaDeadline() {
    if (this.quotaDeadline !== null) clearTimeout(this.quotaDeadline)
    this.quotaDeadline = null
  }

  private scheduleQuotaRead() {
    this.clearQuotaDeadline()
    if (!this.active || this.state.status !== 'connected') return
    // App-server reports the next reset as Unix seconds. Re-read the provider's
    // snapshot at that deadline; never infer a reset or poll an expired window.
    const resetsAt = this.state.data.rateLimits?.primary?.resetsAt
    if (resetsAt === undefined) return
    const deadline = resetsAt * 1000, delay = deadline - Date.now()
    if (!Number.isFinite(delay) || delay <= 0) return
    const timer = setTimeout(() => {
      if (!this.active || this.quotaDeadline !== timer) return
      this.quotaDeadline = null
      // Native timers are bounded to a signed 32-bit delay. Longer deadlines
      // and a clock moving backwards need another timer, not another RPC.
      if (Date.now() < deadline) this.scheduleQuotaRead()
      else void this.refresh()
    }, Math.min(delay, 2_147_483_647))
    this.quotaDeadline = timer
  }

  private invalidate() { ++this.generation; this.pending = null; this.clearQuotaDeadline() }

  connect = (): Promise<void> => {
    if (!this.active) return Promise.resolve()
    if (this.pending) return this.pending.promise
    const generation = this.generation, usageRevision = this.usageRevision
    this.publish(this.state.status === 'connected'
      ? { ...this.state, refreshing: true }
      : { status: 'connecting', error: null })
    const pending = { promise: Promise.resolve() }
    this.pending = pending
    pending.promise = (async () => {
      try {
        const result = await this.client.connect()
        if (!this.active || generation !== this.generation) return
        if (!result.ok) this.publish({ status: 'error', error: result.error })
        else if (result.requiresAuth) this.publish({ status: 'sign-in-required', error: result.error ?? null })
        else {
          // A pushed usage update is newer than a read that started before it.
          const data = { ...result }
          if (usageRevision !== this.usageRevision && this.state.status === 'connected') {
            delete data.rateLimits; delete data.usageError
            if (this.state.data.rateLimits) data.rateLimits = this.state.data.rateLimits
            if (this.state.data.usageError) data.usageError = this.state.data.usageError
          }
          this.publish({ status: 'connected', data, refreshing: false, error: data.usageError ?? null })
        }
      } catch {
        if (this.active && generation === this.generation) this.publish({ status: 'error', error: 'Could not reach Codex. Try connecting again.' })
      } finally { if (this.pending === pending) this.pending = null }
    })()
    return pending.promise
  }

  refresh = (): Promise<void> => this.state.status === 'disconnected' || this.loginPending
    ? Promise.resolve() : this.connect()

  signIn = (): Promise<void> => {
    if (!this.active) return Promise.resolve()
    if (this.loginPending) return this.loginPending
    this.invalidate()
    const generation = this.generation
    this.publish({ status: 'connecting', error: null })
    const pending = (async () => {
      try {
        const result = await this.client.login()
        // Completion can arrive before Chrome finishes opening the popup.
        if (!this.active || generation !== this.generation) return
        this.publish(result.ok ? { status: 'sign-in-required', error: null } : { status: 'error', error: result.error })
      } catch {
        if (this.active && generation === this.generation) this.publish({ status: 'sign-in-required', error: 'Could not open ChatGPT sign-in. Try again.' })
      }
    })()
    this.loginPending = pending
    void pending.finally(() => { if (this.loginPending === pending) this.loginPending = null })
    return pending
  }

  private receive = (notification: CodexJsonRpcNotification) => {
    if (!this.active) return
    const params = notification.params
    if (notification.method === 'account/updated') {
      this.invalidate()
      this.publish(params?.authMode === null ? { status: 'sign-in-required', error: null } : { status: 'connecting', error: null })
      if (params?.authMode !== null) void this.connect()
    } else if (notification.method === 'account/login/completed') {
      this.invalidate()
      if (params?.success === true) void this.connect()
      else this.publish({ status: 'sign-in-required', error: 'Sign-in was not completed. Try again.' })
    } else if (notification.method === 'galta/auth-required') {
      this.invalidate()
      this.publish({ status: 'sign-in-required', error: typeof params?.message === 'string' ? params.message : null })
    } else if (notification.method === 'galta/login-cancelled' || notification.method === 'galta/login-error') {
      this.invalidate()
      this.publish({ status: 'sign-in-required', error: notification.method === 'galta/login-error' ? 'Could not complete sign-in. Try again.' : null })
    } else if (notification.method === 'galta/connection-lost') {
      this.invalidate()
      this.publish({ status: 'error', error: typeof params?.message === 'string' ? params.message : 'Codex disconnected. Try connecting again.' })
    } else if (notification.method === 'account/rateLimits/updated' && this.state.status === 'connected' && this.state.data.account?.type === 'chatgpt') {
      // Updates for other metered products must not replace the Codex bucket.
      const rateLimits = readCodexUsage(params)
      if (!rateLimits) return
      ++this.usageRevision
      const { usageError: _, ...data } = this.state.data
      this.publish({ ...this.state, data: { ...data, rateLimits }, error: null })
    } else if (notification.method === 'turn/completed') {
      void this.refresh()
    }
  }
}
