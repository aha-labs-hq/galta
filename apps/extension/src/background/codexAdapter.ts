import type { CodexAccount, CodexModel, CodexConnectResponse, CodexLoginResponse, GaltaMessage } from '../shared/messages'
import { NativeMessageDecoder, assertCodexEmbeddedConfig } from '@galta/runtime'
import { readCodexUsage } from '../shared/codexUsage'
import { CODEX_USAGE_UNAVAILABLE, CodexRequestError, connectionFailure, isCodexAuthError } from './codexAccount'

type JsonRpcResponse = { id?: string | number; result?: unknown; error?: { message?: string; code?: number; data?: unknown } }
type JsonRpcNotification = { id?: string | number; method: string; params?: Record<string, unknown>; ownerId?: string }
type Pending = { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
type OwnedTurn = { ownerId: string; id?: string; closing: boolean; interrupting?: boolean }

const HOST_NAME = 'com.galta.codex'
const CONNECTION_REQUESTS = new Set(['initialize', 'config/read', 'account/read', 'model/list', 'account/rateLimits/read', 'account/login/start', 'account/login/cancel'])
const MAX_MODEL_LIST_PAGES = 64

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

async function readModelCatalog(request: (method: string, params?: unknown) => Promise<unknown>): Promise<unknown[]> {
  const models: unknown[] = [], cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; ; page++) {
    if (page >= MAX_MODEL_LIST_PAGES) throw new Error('Codex returned too many model-list pages')
    const response = asRecord(await request('model/list', cursor ? { cursor } : {}))
    if (!response || !Array.isArray(response.data)) throw new Error('Codex returned an invalid model-list page')
    models.push(...response.data)
    const nextCursor = response.nextCursor
    if (nextCursor === undefined || nextCursor === null || nextCursor === '') return models
    if (typeof nextCursor !== 'string') throw new Error('Codex returned an invalid model-list cursor')
    if (cursors.has(nextCursor)) throw new Error('Codex returned a repeated model-list cursor')
    cursors.add(nextCursor)
    cursor = nextCursor
  }
}

export class NativeCodexAdapter {
  private port: chrome.runtime.Port | null = null
  private ready: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<(notification: JsonRpcNotification) => void>()
  private readonly decoder = new NativeMessageDecoder()
  private readonly turns = new Map<string, OwnedTurn>()
  private readonly serverRequests = new Map<string, { id: string | number; ownerId: string }>()
  private loginOpening: Promise<CodexLoginResponse> | null = null
  private connectionRead: { revision: number; promise: Promise<CodexConnectResponse> } | null = null
  private accountRevision = 0
  private loginAttempt: { id: string; windowId: number | undefined; parentWindowId: number | undefined } | null = null
  private readonly clients = new Set<string>()
  private closeWhenIdle = false
  private staleMessage: string | null = null
  private idleCloseTimer: ReturnType<typeof setTimeout> | undefined

  private retireIfUnused(): void {
    if (this.staleMessage) {
      if (this.turns.size || this.pending.size || this.loginAttempt || this.loginOpening) return
      const port = this.port, message = this.staleMessage
      this.staleMessage = null
      if (port) this.disconnect(port, message)
      return
    }
    if (!this.closeWhenIdle) return
    clearTimeout(this.idleCloseTimer)
    // Let a connection's promise chain finish before deciding whether it is idle.
    this.idleCloseTimer = setTimeout(() => { if (this.closeWhenIdle && !this.clients.size) this.reconnectWhenIdle() }, 0)
  }

  attachClient(ownerId: string): void { this.closeWhenIdle = false; this.clients.add(ownerId) }
  detachClient(ownerId: string): void {
    this.clients.delete(ownerId)
    this.releaseOwner(ownerId)
    if (!this.clients.size) { this.closeWhenIdle = true; this.reconnectWhenIdle() }
  }

  /** Never interrupt work or sign-in to adopt an updated runtime. */
  reconnectWhenIdle(): boolean {
    if (this.turns.size || this.pending.size || this.loginAttempt || this.loginOpening) return false
    if (this.port) this.disconnect(this.port, 'Reconnecting to the local runtime')
    return true
  }

  /** Codex fixes its tool list per connection, so a changed list is adopted
   * by reconnecting: now when idle, otherwise as soon as the work ends. */
  refreshTools(): void {
    if (!this.reconnectWhenIdle() && this.port) this.staleMessage ??= 'Reconnecting to the local runtime'
  }

  private readonly onLoginWindowRemoved = (windowId: number) => {
    const attempt = this.loginAttempt
    if (!attempt || attempt.windowId !== windowId) return
    this.loginAttempt = null
    chrome.windows.onRemoved.removeListener(this.onLoginWindowRemoved)
    void this.request('account/login/cancel', { loginId: attempt.id }).catch((error) => {
      this.handleMessage({ method: 'galta/login-error', params: { message: errorMessage(error, 'Unable to cancel sign-in') } })
    })
    this.handleMessage({ method: 'galta/login-cancelled', params: {} })
  }

  private async finishLogin(loginId: unknown): Promise<void> {
    // A returning account can complete before windows.create resolves. Wait
    // for ownership of the popup before closing it, including that fast path.
    await this.loginOpening
    const attempt = this.loginAttempt
    if (!attempt || attempt.id !== loginId) return
    this.loginAttempt = null
    chrome.windows.onRemoved.removeListener(this.onLoginWindowRemoved)
    if (attempt.windowId !== undefined) await chrome.windows.remove(attempt.windowId).catch(() => undefined)
    // A user may close the original window while signing in. Never create a
    // replacement tab or redirect an unrelated workspace in that case.
    if (attempt.parentWindowId !== undefined) await chrome.windows.update(attempt.parentWindowId, { focused: true }).catch(() => undefined)
    this.retireIfUnused()
  }

  subscribe(listener: (notification: JsonRpcNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private ensurePort(): Promise<void> {
    if (!this.ready) {
      const ready = this.initialize().catch((error) => {
        if (this.ready === ready) this.ready = null
        throw error
      })
      this.ready = ready
    }
    return this.ready
  }

  private disconnect(port: chrome.runtime.Port, message: string): void {
    if (this.port !== port) return
    this.port = null
    this.accountRevision++
    this.ready = null
    this.decoder.reset()
    this.staleMessage = null
    this.turns.clear()
    this.serverRequests.clear()
    for (const pending of this.pending.values()) pending.reject(new Error(message))
    this.pending.clear()
    // Chrome does not fire onDisconnect on the end that calls disconnect().
    port.disconnect()
    this.handleMessage({ method: 'galta/connection-lost', params: { message } })
  }

  private async initialize(): Promise<void> {
    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connectNative(HOST_NAME)
    } catch (error) {
      throw new Error(`Galta runtime is unavailable. Open Galta for Mac and choose “Connect browser”. ${errorMessage(error, 'The local runtime could not start.')}`)
    }
    this.port = port
    port.onMessage.addListener((part) => {
      if (this.port !== port) return
      try {
        const message = this.decoder.push(part)
        if (message !== undefined) this.handleMessage(message as JsonRpcResponse | JsonRpcNotification)
      } catch (error) {
        this.disconnect(port, errorMessage(error, 'Invalid Codex transport message'))
      }
    })
    port.onDisconnect.addListener(() => {
      this.disconnect(port, chrome.runtime.lastError?.message ?? 'Built-in chat disconnected.')
    })
    try {
      await this.send('initialize', {
        clientInfo: { name: 'galta', title: 'Galta', version: '0.1.0' },
        // Required by turn/start.additionalContext in the bundled protocol.
        // This does not enable the code_mode feature.
        capabilities: { experimentalApi: true, requestAttestation: false }
      })
      port.postMessage({ method: 'initialized', params: {} })
      assertCodexEmbeddedConfig(await this.send('config/read', { includeLayers: false }))
    } catch (error) {
      this.disconnect(port, errorMessage(error, 'Unable to initialize Codex'))
      throw error
    }
  }

  private handleMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    if ('method' in message && message.id !== undefined) {
      const threadId = message.params?.threadId
      const turn = typeof threadId === 'string' ? this.turns.get(threadId) : undefined
      const ownerId = turn && !turn.closing && (!message.params?.turnId || !turn.id || message.params.turnId === turn.id) ? turn.ownerId : undefined
      if (!ownerId) {
        this.port?.postMessage({ id: message.id, error: { code: -32000, message: 'The canvas owning this Codex request is not available' } })
        return
      }
      this.serverRequests.set(String(message.id), { id: message.id, ownerId })
      void chrome.runtime.sendMessage({ type: 'codex-notification', notification: { ...message, ownerId } }).catch(() => this.releaseOwner(ownerId))
      return
    }
    if ('id' in message && message.id !== undefined) {
      const pending = this.pending.get(String(message.id))
      if (!pending) return
      this.pending.delete(String(message.id))
      const response = message as JsonRpcResponse
      if (response.error) pending.reject(new CodexRequestError(pending.method, response.error.code, response.error.message ?? 'Codex request failed', response.error.data))
      else pending.resolve(response.result)
      return
    }
    if ('method' in message && typeof message.method === 'string') {
      const notification = message as JsonRpcNotification
      if (notification.method === 'account/updated') this.accountRevision++
      const threadId = notification.params?.threadId
      const turn = asRecord(notification.params?.turn)
      if (notification.method === 'turn/started' && typeof threadId === 'string' && typeof turn?.id === 'string') {
        this.observeTurnStart(threadId, turn.id)
      }
      if (notification.method === 'turn/completed' && typeof threadId === 'string' && typeof turn?.id === 'string' && this.turns.get(threadId)?.id === turn.id) {
        this.turns.delete(threadId)
        this.retireIfUnused()
      }
      if (notification.method === 'serverRequest/resolved') this.serverRequests.delete(String(notification.params?.requestId))
      if (notification.method === 'account/login/completed') {
        if (!this.loginAttempt || this.loginAttempt.id !== notification.params?.loginId) return
        if (notification.params?.success === true) {
          this.accountRevision++
          void this.finishLogin(notification.params.loginId)
        }
      }
      for (const listener of this.listeners) listener(notification)
      void chrome.runtime.sendMessage({ type: 'codex-notification', notification }).catch(() => undefined)
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.ensurePort()
    return this.send(method, params)
  }

  async requestForOwner(ownerId: string, method: string, params?: unknown): Promise<unknown> {
    const request = asRecord(params)
    const threadId = request?.threadId
    if (method === 'turn/steer') {
      const expectedTurnId = request?.expectedTurnId
      const turn = typeof threadId === 'string' ? this.turns.get(threadId) : undefined
      if (!turn || turn.ownerId !== ownerId || turn.closing || typeof expectedTurnId !== 'string' || turn.id !== expectedTurnId) throw new Error('This Codex turn is not owned by the requesting task')
      return this.request(method, params)
    }
    if (method !== 'turn/start' || typeof threadId !== 'string') return this.request(method, params)
    if (this.turns.has(threadId)) throw new Error('This Codex session is already running in a canvas')
    const turn: OwnedTurn = { ownerId, closing: false }
    this.turns.set(threadId, turn)
    try {
      const result = await this.request(method, params)
      const id = asRecord(asRecord(result)?.turn)?.id
      if (typeof id === 'string' && this.turns.get(threadId) === turn) this.observeTurnStart(threadId, id)
      return result
    } catch (error) {
      if (this.turns.get(threadId) === turn) this.turns.delete(threadId)
      this.retireIfUnused()
      throw error
    }
  }

  respond(ownerId: string, id: string | number, result?: unknown, error?: { code: number; message: string }): void {
    const pending = this.serverRequests.get(String(id))
    if (!pending || pending.ownerId !== ownerId) throw new Error('This tool request no longer belongs to this canvas')
    if (!this.port) throw new Error('Built-in chat is unavailable')
    this.port.postMessage({ id: pending.id, ...(error ? { error } : { result }) })
    this.serverRequests.delete(String(id))
  }

  releaseOwner(ownerId: string): void {
    for (const [id, request] of this.serverRequests) if (request.ownerId === ownerId) {
      this.serverRequests.delete(id)
      this.port?.postMessage({ id: request.id, error: { code: -32000, message: 'The canvas was closed' } })
    }
    for (const [threadId, turn] of this.turns) if (turn.ownerId === ownerId) {
      if (turn.closing) continue
      // Keep ownership until completion. Closing during turn/start must stop
      // the turn when its started notification arrives, and block a new run.
      turn.closing = true
      this.interruptClosedThread(threadId, turn)
    }
  }

  private observeTurnStart(threadId: string, id: string): void {
    const turn = this.turns.get(threadId)
    if (!turn || turn.id && turn.id !== id) return
    turn.id = id
    if (turn.closing) this.interruptClosedThread(threadId, turn)
  }

  private interruptClosedThread(threadId: string, turn: OwnedTurn): void {
    const port = this.port
    if (!port || !turn.id || turn.interrupting) return
    turn.interrupting = true
    void this.request('turn/interrupt', { threadId, turnId: turn.id }).catch(error => {
      if (this.port !== port || this.turns.get(threadId) !== turn) return
      // An orphan that cannot be stopped must not keep running behind a false
      // disconnection notification. Retire the transport and clear its state.
      this.disconnect(port, `Unable to stop detached Codex turn ${threadId}/${turn.id}: ${errorMessage(error, 'Interruption failed')}`)
    })
  }

  private send(method: string, params?: unknown): Promise<unknown> {
    const port = this.port
    if (!port) throw new Error('Built-in chat is unavailable')
    const id = String(this.nextId++)
    const timeoutMs = CONNECTION_REQUESTS.has(method) ? 15_000 : 0
    return new Promise((resolve, reject) => {
      const timeout = timeoutMs ? setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        const message = 'Codex did not respond. Keep drawing and try connecting again.'
        this.pending.delete(id)
        this.staleMessage = message
        pending.reject(new Error(message))
        // A connection read that times out leaves the native host in an
        // unknown state. Retaining the resolved `ready` promise would make
        // every retry reuse that dead transport. Retire it when there is no
        // active turn to interrupt; active work keeps its ownership boundary
        // until its normal completion or interruption path runs.
      }, timeoutMs) : undefined
      this.pending.set(id, {
        method,
        resolve: value => { clearTimeout(timeout); resolve(value); this.retireIfUnused() },
        reject: error => { clearTimeout(timeout); reject(error); this.retireIfUnused() },
      })
      try {
        this.port?.postMessage({ method, id, ...(params === undefined ? {} : { params }) })
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(new Error(errorMessage(error, 'Unable to reach Codex')))
      }
    })
  }

  connect(): Promise<CodexConnectResponse> {
    const pending = this.connectionRead
    if (pending) return pending.revision === this.accountRevision ? pending.promise : pending.promise.then(() => this.connect())
    const revision = this.accountRevision
    const read = { revision, promise: this.readConnection(revision).then(result => {
      if (revision === this.accountRevision && result.ok && result.requiresAuth) {
        // Someone who never signed in is simply asked to; only a reason (an expired sign-in) is shown as an error.
        this.handleMessage({ method: 'galta/auth-required', params: { message: result.error ?? null } })
      }
      return result
    }) }
    this.connectionRead = read
    void read.promise.finally(() => { if (this.connectionRead === read) this.connectionRead = null })
    return read.promise
  }

  private async readConnection(revision: number): Promise<CodexConnectResponse> {
    try {
      const accountResult = await this.request('account/read', { refreshToken: false })
      return await this.readAccountConnection(accountResult)
    } catch (error) {
      if (!isCodexAuthError(error)) return connectionFailure(error)
      if (revision !== this.accountRevision) return { ok: false, error: 'The Codex account changed. Try connecting again.' }
      console.info('Codex authentication recovery started', { method: 'account/read' })
      try {
        // Codex owns reload/refresh and token persistence. Only an auth failure
        // requests a forced refresh; simultaneous callers share this attempt.
        const accountResult = await this.request('account/read', { refreshToken: true })
        const result = await this.readAccountConnection(accountResult)
        console.info('Codex authentication recovery completed', { requiresAuth: result.ok && result.requiresAuth === true })
        return result
      } catch (recoveryError) {
        console.warn('Codex authentication recovery failed', { requiresAuth: isCodexAuthError(recoveryError) })
        return connectionFailure(recoveryError)
      }
    }
  }

  private async readAccountConnection(accountResult: unknown): Promise<CodexConnectResponse> {
    const response = asRecord(accountResult), account = asRecord(response?.account)
    if (!response || typeof response.requiresOpenaiAuth !== 'boolean'
      || response.account !== null && (!account || typeof account.type !== 'string')) throw new Error('Codex returned an invalid account response')
    // This flag describes the provider, not whether credentials are valid.
    if (!account && response.requiresOpenaiAuth) return { ok: true, requiresAuth: true }
    const results = await Promise.allSettled([
      readModelCatalog((method, params) => this.request(method, params)),
      // Configured providers may need no OpenAI account. Their connection is
      // valid, but ChatGPT subscription limits do not apply.
      account?.type === 'chatgpt' ? this.readUsage() : Promise.resolve({})
    ])
    // Finish both reads before recovery; an obsolete model read must not
    // overlap a token refresh or conceal the accompanying auth failure.
    for (const result of results) if (result.status === 'rejected' && isCodexAuthError(result.reason)) throw result.reason
    const [models, usage] = results
    if (models.status === 'rejected') throw models.reason
    if (usage.status === 'rejected') throw usage.reason
    return {
      ok: true,
      ...(account ? {
        account: {
          type: account.type as string,
          ...(typeof account.planType === 'string' ? { planType: account.planType } : {}),
          ...(typeof account.email === 'string' ? { email: account.email } : {})
        } satisfies CodexAccount
      } : {}),
      models: models.value.flatMap((model): CodexModel[] => {
        const item = asRecord(model)
        if (!item || typeof item.id !== 'string') return []
        return [{
          id: item.id,
          ...(typeof item.displayName === 'string' ? { displayName: item.displayName } : {}),
          ...(Array.isArray(item.supportedReasoningEfforts) ? { supportedReasoningEfforts: item.supportedReasoningEfforts.flatMap((effort) => {
            const entry = asRecord(effort)
            return entry && typeof entry.reasoningEffort === 'string' ? [{ reasoningEffort: entry.reasoningEffort, ...(typeof entry.description === 'string' ? { description: entry.description } : {}) }] : []
          }) } : {}),
          ...(item.isDefault === true ? { isDefault: true } : {})
        }]
      }),
      ...usage.value,
    }
  }

  private async readUsage() {
    let response: unknown
    try {
      response = await this.request('account/rateLimits/read')
    } catch (error) {
      // A broken native transport is a connection failure, not an optional
      // service outage. Only a received RPC error can degrade to no usage.
      if (!(error instanceof CodexRequestError) || isCodexAuthError(error)) throw error
      console.warn('Codex usage unavailable', { method: 'account/rateLimits/read', code: error.code })
      return { usageError: CODEX_USAGE_UNAVAILABLE }
    }
    const rateLimits = readCodexUsage(response)
    if (rateLimits) return { rateLimits }
    console.warn('Codex usage unavailable', { method: 'account/rateLimits/read', reason: 'invalid-window' })
    return { usageError: CODEX_USAGE_UNAVAILABLE }
  }

  login(): Promise<CodexLoginResponse> {
    if (!this.loginOpening) {
      this.accountRevision++
      this.loginOpening = this.openLoginWindow().finally(() => { this.loginOpening = null; this.retireIfUnused() })
    }
    return this.loginOpening
  }

  private async openLoginWindow(): Promise<CodexLoginResponse> {
    try {
      if (this.loginAttempt?.windowId !== undefined) {
        await chrome.windows.update(this.loginAttempt.windowId, { focused: true })
        return { ok: true }
      }
      const parent = await chrome.windows.getLastFocused()
      const result = asRecord(await this.request('account/login/start', { type: 'chatgpt', useHostedLoginSuccessPage: true }))
      const authUrl = typeof result?.authUrl === 'string' ? result.authUrl : undefined
      const loginId = typeof result?.loginId === 'string' ? result.loginId : undefined
      if (!authUrl || !loginId) throw new Error('Codex did not return a sign-in window URL and login identifier')
      const attempt = { id: loginId, parentWindowId: parent.id, windowId: undefined as number | undefined }
      this.loginAttempt = attempt
      chrome.windows.onRemoved.addListener(this.onLoginWindowRemoved)
      try {
        const width = Math.min(480, parent.width ?? 480)
        const height = Math.min(720, parent.height ?? 720)
        const popup = await chrome.windows.create({
          url: authUrl, type: 'popup', focused: true, width, height,
          ...(parent.left === undefined ? {} : { left: Math.round(parent.left + ((parent.width ?? width) - width) / 2) }),
          ...(parent.top === undefined ? {} : { top: Math.round(parent.top + ((parent.height ?? height) - height) / 2) })
        })
        if (popup.id === undefined) throw new Error('The sign-in window could not be opened')
        attempt.windowId = popup.id
        return { ok: true }
      } catch (error) {
        this.loginAttempt = null
        chrome.windows.onRemoved.removeListener(this.onLoginWindowRemoved)
        await this.request('account/login/cancel', { loginId })
        throw error
      }
    } catch (error) {
      if (error instanceof CodexRequestError) {
        console.warn('Codex sign-in request failed', { method: error.method, code: error.code })
        return { ok: false, error: 'Could not start ChatGPT sign-in. Try again.' }
      }
      return { ok: false, error: errorMessage(error, 'Unable to start ChatGPT sign-in') }
    }
  }
}

export const codexAdapter = new NativeCodexAdapter()

export async function handleCodexMessage(message: GaltaMessage, sendResponse: (response: unknown) => void): Promise<boolean> {
  if (message.type === 'codex-connect') {
    sendResponse(await codexAdapter.connect())
    return true
  }
  if (message.type === 'codex-login') {
    sendResponse(await codexAdapter.login())
    return true
  }
  if (message.type === 'codex-rpc') {
    try {
      sendResponse({ ok: true, result: await codexAdapter.requestForOwner(message.ownerId, message.method, message.params) })
    } catch (error) {
      sendResponse({ ok: false, error: errorMessage(error, 'Codex request failed') })
    }
    return true
  }
  if (message.type === 'codex-respond') {
    try { codexAdapter.respond(message.ownerId, message.id, message.result, message.error); sendResponse({ ok: true }) }
    catch (error) { sendResponse({ ok: false, error: errorMessage(error, 'Unable to answer Codex') }) }
    return true
  }
  return false
}
