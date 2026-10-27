import type { CodexModel, CodexConnectResponse, CodexLoginResponse } from '../shared/messages'
import type { CodexJsonRpcNotification, CodexRpcClient } from '@galta/runtime'

type RpcResponse = { ok?: boolean; result?: unknown; error?: string }

export class ExtensionCodexRpc implements CodexRpcClient {
  private nextId = 1
  private readonly ownerId = crypto.randomUUID()
  private port: chrome.runtime.Port | null = null
  private readonly listeners = new Set<(notification: CodexJsonRpcNotification) => void>()

  private readonly onNotification = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'codex-notification') return
      const notification = (message as { notification?: unknown }).notification
      if (!notification || typeof notification !== 'object' || !('method' in notification) || typeof notification.method !== 'string') return
      if ('ownerId' in notification && notification.ownerId !== this.ownerId) return
      for (const listener of this.listeners) listener(notification as CodexJsonRpcNotification)
  }

  private openPort(): void {
    if (this.port || !this.listeners.size || typeof chrome === 'undefined') return
    const port = chrome.runtime?.connect?.({ name: `galta-codex-client:${this.ownerId}` })
    if (!port) return
    this.port = port
    port.onDisconnect.addListener(() => {
      // Chrome exposes this only during the callback. Read it even for a
      // retired port, but never let that port retire a newer connection.
      const message = chrome.runtime.lastError?.message ?? 'The connection to Galta closed. Reopen Galta and reconnect built-in chat.'
      if (this.port !== port) return
      this.port = null
      for (const listener of this.listeners) listener({ method: 'galta/connection-lost', params: { message } })
    })
  }

  subscribe(listener: (notification: CodexJsonRpcNotification) => void): () => void {
    if (!this.listeners.size && typeof chrome !== 'undefined') {
      chrome.runtime?.onMessage?.addListener(this.onNotification)
    }
    this.listeners.add(listener)
    this.openPort()
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size && typeof chrome !== 'undefined') {
        chrome.runtime?.onMessage?.removeListener(this.onNotification)
        const port = this.port; this.port = null
        port?.disconnect()
      }
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) throw new Error('Open the Galta browser extension to use built-in chat')
    const response = await chrome.runtime.sendMessage({ type: 'codex-rpc', ownerId: this.ownerId, requestId: String(this.nextId++), method, ...(params === undefined ? {} : { params }) }) as RpcResponse
    if (!response?.ok) throw new Error(response?.error ?? 'Codex request failed')
    return response.result
  }

  async respond(id: string | number, result?: unknown, error?: { code: number; message: string }): Promise<void> {
    const response = await chrome.runtime.sendMessage({ type: 'codex-respond', ownerId: this.ownerId, id, result, error }) as RpcResponse
    if (!response?.ok) throw new Error(response?.error ?? 'Unable to answer Codex tool request')
  }

  async connect(): Promise<CodexConnectResponse> {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return { ok: false, error: 'Open the Galta browser extension to use built-in chat' }
    try { this.openPort(); return await chrome.runtime.sendMessage({ type: 'codex-connect' }) as CodexConnectResponse }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Unable to connect to Codex.' } }
  }

  async login(): Promise<CodexLoginResponse> {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return { ok: false, error: 'Open the Galta browser extension to use built-in chat' }
    try { this.openPort(); return await chrome.runtime.sendMessage({ type: 'codex-login' }) as CodexLoginResponse }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Unable to start Codex sign-in.' } }
  }

  static modelLabel(model: CodexModel): string {
    return model.displayName ?? model.id
  }
}
