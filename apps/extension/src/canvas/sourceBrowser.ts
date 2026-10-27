import { validateBrowserInput, type BrowserContext, type ToolResult } from '@galta/canvas'

/** Capture which page the user means at submission, before canvas preparation. */
export async function sourceTab(): Promise<number | null> {
  if (!globalThis.chrome?.runtime?.id || !chrome.tabs?.query) return null
  const returnTab = new URLSearchParams(location.hash.slice(1)).get('returnTab')
  if (location.pathname === '/canvas/index.html') return returnTab && /^\d+$/.test(returnTab) ? Number(returnTab) : null
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.id ?? null
}

export class SourceBrowser {
  private port: chrome.runtime.Port | null = null
  private closed = false
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>()
  context: BrowserContext = { available: false, reason: 'No source webpage is bound to this execution.' }

  async open(tabId: number | null, executionId: string, expectedUrl?: string): Promise<BrowserContext> {
    if (this.closed) throw new Error('The webpage execution already ended')
    if (tabId === null) return this.context
    try {
      const port = chrome.runtime.connect({ name: `galta-browser:${executionId}` })
      this.port = port
      port.onMessage.addListener(message => {
        if (this.port !== port) return
        const pending = this.pending.get(message.id); this.pending.delete(message.id)
        message.error ? pending?.reject(new Error(message.error)) : pending?.resolve(message.result)
      })
      port.onDisconnect.addListener(() => { if (this.port === port) this.close(chrome.runtime.lastError?.message ?? 'The webpage connection closed') })
      const page = await this.request('open', { tabId, ...(expectedUrl ? { expectedUrl } : {}) })
      this.context = { available: true, page }
    } catch (error) {
      this.close()
      this.context = { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
    return this.context
  }

  private request(tool: string, args: unknown): Promise<any> {
    if (!this.port) return Promise.reject(new Error('The source webpage connection is unavailable'))
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.close('The webpage operation timed out; its outcome is unknown. Read before trying another action.'), 15_000)
      this.pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value) }, reject: error => { clearTimeout(timeout); reject(error) } })
      try { this.port!.postMessage({ id, tool, args }) } catch (error) { this.close(String(error)) }
    })
  }

  async execute(tool: string, args: unknown, signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted()
    validateBrowserInput(tool, args)
    const cancel = () => this.close('The webpage execution was stopped')
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const result = await this.request(tool, args)
      signal.throwIfAborted()
      if (tool !== 'browser_capture') return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
      let dataUrl: string = result.dataUrl
      const { dataUrl: _, ...metadata } = result
      if (result.rect) {
        const image = await createImageBitmap(await (await fetch(dataUrl)).blob())
        try {
          const sx = image.width / result.viewport.width, sy = image.height / result.viewport.height, r = result.rect
          const x = Math.max(0, r.x), y = Math.max(0, r.y), width = Math.min(r.x + r.width, result.viewport.width) - x, height = Math.min(r.y + r.height, result.viewport.height) - y
          if (width <= 0 || height <= 0) throw new Error('The webpage target is outside the viewport')
          const canvas = document.createElement('canvas'); canvas.width = Math.ceil(width * sx); canvas.height = Math.ceil(height * sy)
          canvas.getContext('2d')!.drawImage(image, x * sx, y * sy, width * sx, height * sy, 0, 0, canvas.width, canvas.height)
          dataUrl = canvas.toDataURL('image/jpeg', 0.92)
        } finally { image.close() }
      }
      signal.throwIfAborted()
      const structuredContent = { source: 'webpage', ...metadata }
      return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }, { type: 'image', mimeType: 'image/jpeg', data: dataUrl.split(',')[1]! }], structuredContent }
    } finally { signal.removeEventListener('abort', cancel) }
  }

  close(reason = 'The webpage execution ended') {
    this.closed = true
    const port = this.port; this.port = null
    for (const pending of this.pending.values()) pending.reject(new Error(reason))
    this.pending.clear(); port?.disconnect()
  }
}
