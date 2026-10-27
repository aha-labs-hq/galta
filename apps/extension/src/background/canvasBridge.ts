import { NativeMessageDecoder } from '@galta/runtime'

/** Separate from the Codex transport: MCP remains usable without a Codex account. */
export class NativeCanvasBridge {
  private native: chrome.runtime.Port | null = null
  private readonly surfaces = new Map<string, chrome.runtime.Port>()
  private readonly requests = new Map<string, string>()
  private readonly decoder = new NativeMessageDecoder()

  attach(surface: chrome.runtime.Port) {
    const canvasId = surface.name.slice('galta-canvas:'.length)
    if (!canvasId || this.surfaces.has(canvasId)) { surface.disconnect(); return }
    this.surfaces.set(canvasId, surface)
    surface.onMessage.addListener(message => {
      if (this.surfaces.get(canvasId) !== surface) return
      try {
        const native = this.connect()
        if (typeof message.method === 'string') {
          if (message.id) this.requests.set(String(message.id), canvasId)
          native.postMessage({ ...message, params: { ...message.params, canvasId } })
        } else if (this.requests.get(String(message.id)) === canvasId) {
          this.requests.delete(String(message.id))
          native.postMessage(message)
        }
      } catch (error) {
        this.close(error instanceof Error ? error.message : String(error))
      }
    })
    surface.onDisconnect.addListener(() => {
      if (this.surfaces.get(canvasId) !== surface) return
      this.surfaces.delete(canvasId)
      try { this.native?.postMessage({ method: 'canvas/unregister', params: { canvasId } }) }
      catch (error) { this.close(error instanceof Error ? error.message : String(error)) }
      for (const [id, owner] of this.requests) if (owner === canvasId) this.requests.delete(id)
      if (!this.surfaces.size) this.close('All canvases closed')
    })
  }

  private connect() {
    if (this.native) return this.native
    const native = chrome.runtime.connectNative('com.galta.canvas')
    this.native = native
    native.onMessage.addListener(part => {
      if (this.native !== native) return
      try {
        const message = this.decoder.push(part) as any
        if (!message) return
        const canvasId = message.params?.canvasId ?? this.requests.get(String(message.id))
        const surface = this.surfaces.get(canvasId)
        if (message.method && message.id) this.requests.set(String(message.id), canvasId)
        else if (!message.method) this.requests.delete(String(message.id))
        if (message.method === 'canvas/cancel') this.requests.delete(String(message.params?.requestId))
        if (surface) surface.postMessage(message)
        else if (message.id && message.method) native.postMessage({ id: message.id, error: { message: 'The canvas has closed' } })
      } catch (error) { this.close(error instanceof Error ? error.message : String(error)) }
    })
    native.onDisconnect.addListener(() => {
      if (this.native === native) this.close(chrome.runtime.lastError?.message ?? 'Canvas bridge disconnected')
    })
    return native
  }

  private close(message: string) {
    const native = this.native
    this.native = null
    this.decoder.reset()
    this.requests.clear()
    native?.disconnect()
    const surfaces = [...this.surfaces.values()]
    this.surfaces.clear()
    for (const surface of surfaces) {
      try { surface.postMessage({ method: 'canvas/disconnected', params: { message } }) }
      catch { /* A surface can close before its disconnect event is delivered. */ }
      finally { surface.disconnect() }
    }
  }
}

export const canvasBridge = new NativeCanvasBridge()
