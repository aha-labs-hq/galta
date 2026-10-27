import type { CanvasArtifacts, CanvasToolScope, ToolResult } from '@galta/canvas'
import { MAX_VIDEO_BYTES, galtaToolContract, assertGaltaToolContract } from '@galta/canvas'
import type { ArtifactDeliveryDeclaration, ArtifactRead, ConversationArtifact } from '@galta/domain'

export type CanvasExecution = { id: string; canvasId: string; projectId: string; cwd: string; client: string; mode: 'embedded' | 'external'; bridgeId?: string }
export type CanvasConnectionHost = {
  begin(execution: CanvasExecution, signal: AbortSignal): Promise<void>
  call(tool: string, args: unknown, signal: AbortSignal): Promise<ToolResult>
  end(executionId: string): Promise<void>
  disconnected(message: string): void
}

export class CanvasAgentConnection {
  private readonly canvasId = crypto.randomUUID()
  /** Stable browser target; MCP discovery prefixes it with the bridge ID. */
  get id() { return this.canvasId }
  private port: chrome.runtime.Port | null = null
  private readonly pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private readonly calls = new Map<string, AbortController>()
  private lease: CanvasExecution | null = null

  constructor(private readonly host: CanvasConnectionHost) {}

  /** Open, or opening; a closed connection can open again with the same ID. */
  get isOpen() { return this.port !== null }

  async open(projectId: string, title: string) {
    if (this.port) throw new Error('Canvas connection is already open')
    const port = chrome.runtime.connect({ name: `galta-canvas:${this.canvasId}` })
    this.port = port
    port.onMessage.addListener(message => {
      if (this.port !== port) return
      void this.receive(message, port).catch(error => { if (this.port === port) this.close(String(error)) })
    })
    port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message ?? 'Canvas bridge disconnected'
      if (this.port === port) this.close(message)
    })
    try { await this.rename(projectId, title) }
    catch (error) {
      this.close(error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  private async receive(message: any, port: chrome.runtime.Port) {
    if (!message.method) {
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      message.error ? pending?.reject(new Error(message.error.message)) : pending?.resolve(message.result)
      return
    }
    const p = message.params ?? {}
    if (message.method === 'canvas/disconnected') { this.close(p.message); return }
    if (message.method === 'canvas/cancel') { this.calls.get(p.requestId)?.abort(new Error('Cancelled')); return }
    try {
      let result: unknown = {}
      if (message.method === 'canvas/begin') {
        if (this.lease) throw new Error('Canvas already has an active execution')
        const lease = p as CanvasExecution, abort = new AbortController()
        this.lease = lease
        this.calls.set(message.id, abort)
        try {
          await this.host.begin(lease, abort.signal)
          abort.signal.throwIfAborted()
          if (this.lease !== lease) throw new Error('Canvas connection ended during preparation')
        } catch (error) {
          if (this.lease === lease) this.lease = null
          await this.host.end(lease.id)
          throw error
        } finally { this.calls.delete(message.id) }
      } else if (message.method === 'canvas/end') {
        if (this.lease?.id === p.leaseId) {
          this.lease = null
          for (const abort of this.calls.values()) abort.abort(new Error('Canvas execution ended'))
          await this.host.end(p.leaseId)
        }
      } else if (message.method === 'canvas/call') {
        if (!this.lease || this.lease.id !== p.leaseId) throw new Error('Canvas execution is no longer active')
        const abort = new AbortController()
        this.calls.set(message.id, abort)
        try { result = await this.host.call(p.tool, p.args, abort.signal) }
        finally { this.calls.delete(message.id) }
      } else throw new Error('Unknown canvas request')
      if (this.port === port) port.postMessage({ id: message.id, result })
    } catch (error) {
      if (this.port === port) port.postMessage({ id: message.id, error: { message: error instanceof Error ? error.message : String(error) } })
    }
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.port) return Promise.reject(new Error('Canvas bridge is unavailable'))
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.close(`Canvas bridge request timed out: ${method}`), 65_000)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value) },
        reject: error => { clearTimeout(timeout); reject(error) }
      })
      try { this.port!.postMessage({ id, method, params: { ...params, canvasId: this.canvasId } }) }
      catch (error) { this.close(error instanceof Error ? error.message : String(error)) }
    })
  }

  async acquire() { return await this.request('canvas/acquire', {}) as CanvasExecution }
  async rename(projectId: string, title: string) {
    const result = await this.request('canvas/register', { projectId, title, toolContract: await galtaToolContract() })
    await assertGaltaToolContract(result?.toolContract)
  }
  async release() {
    // Fence browser work immediately, before the bridge acknowledges release.
    for (const abort of this.calls.values()) abort.abort(new Error('Canvas execution ended'))
    if (this.lease) await this.request('canvas/release', { leaseId: this.lease.id })
  }

  async readArtifact(uri: string, offset = 0, version?: string, receipt?: ArtifactRead) {
    if (!this.port) throw new Error('Canvas bridge is unavailable')
    return await this.request('artifact/read-file', { uri, offset, ...(version ? { version } : {}), ...(receipt ? { receipt } : {}) }) as { dataBase64: string; mimeType: string; total: number; offset: number; nextOffset: number; version: string; name: string; sha256?: string }
  }

  async finalizeArtifacts(hrefs: readonly string[], identity: { threadId: string; turnId: string; messageId: string }, declarations?: readonly ArtifactDeliveryDeclaration[]): Promise<ConversationArtifact[]> {
    if (!this.port) throw new Error('Canvas bridge is unavailable')
    return await this.request('artifact/finalize', { hrefs, ...(declarations?.length ? { declarations } : {}), ...identity }) as ConversationArtifact[]
  }

  artifacts(): CanvasArtifacts {
    const call = (method: string, params: Record<string, unknown>, scope: CanvasToolScope) => {
      scope.signal.throwIfAborted()
      if (!this.lease || this.lease.id !== scope.executionId) throw new Error('Canvas execution is not active')
      return this.request(method, { ...params, leaseId: this.lease.id })
    }
    return {
      readImage: (path, scope) => call('artifact/read-image', { path }, scope),
      readVideo: async (path, scope) => {
        const chunks: BlobPart[] = []
        let offset = 0, version: string | undefined, mimeType = '', total = 0
        do {
          const chunk = await call('artifact/read-video', { path, offset, ...(version ? { version } : {}) }, scope)
          scope.signal.throwIfAborted()
          if (chunk.offset !== offset || !Number.isSafeInteger(chunk.total) || chunk.total <= 0 || chunk.total > MAX_VIDEO_BYTES ||
            typeof chunk.version !== 'string' || !chunk.version || typeof chunk.mimeType !== 'string' || !chunk.mimeType.startsWith('video/') ||
            version && (chunk.version !== version || chunk.total !== total || chunk.mimeType !== mimeType) || typeof chunk.dataBase64 !== 'string' || chunk.dataBase64.length > 512_000) throw new Error('Invalid video transfer')
          const bytes = Uint8Array.from(atob(chunk.dataBase64), c => c.charCodeAt(0))
          if (!bytes.length || chunk.nextOffset !== offset + bytes.length || chunk.nextOffset > chunk.total) throw new Error('Invalid video chunk')
          chunks.push(bytes); offset = chunk.nextOffset; total = chunk.total; version = chunk.version; mimeType = chunk.mimeType
        } while (offset < total)
        return new Blob(chunks, { type: mimeType })
      },
      readHtml: (path, scope) => call('artifact/read-html', { path }, scope),
      writeImage: (path, dataBase64, scope) => call('artifact/write-image', { path, dataBase64 }, scope),
      writeArtifact: (path, dataBase64, mimeType, scope) => call('artifact/write-file', { path, dataBase64, mimeType }, scope),
      deliver: (source, destination, scope) => call('artifact/deliver', { source, destination }, scope)
    }
  }

  close(message = 'Canvas closed') {
    const port = this.port
    if (!port) return
    this.port = null
    for (const abort of this.calls.values()) abort.abort(new Error(message))
    for (const pending of this.pending.values()) pending.reject(new Error(message))
    this.calls.clear()
    this.pending.clear()
    const lease = this.lease
    this.lease = null
    if (lease) void this.host.end(lease.id).catch(error => this.host.disconnected(`Canvas cleanup failed: ${String(error)}`))
    port.disconnect()
    this.host.disconnected(message)
  }
}
