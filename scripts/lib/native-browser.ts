import type { Page } from '@playwright/test'
import { resolve } from 'node:path'
import { codexTestHome } from './codex-test-home'
import { COMPANION_FIXTURE_HEALTH } from './companion-fixture'

/** Adapt Chrome delivery only. Production background, native hosts, browser
 * canvas and IndexedDB execute unchanged in an isolated Playwright profile.
 * Installation status is the companion fixture. This adapter does not certify
 * installation. */
export async function nativeBrowser(root: string, environment: Record<string, string> = {}, observe?: (message: any) => void) {
  const { NativeCanvasBridge } = await import(resolve(root, 'apps/extension/src/background/canvasBridge.ts'))
  const { codexAdapter, handleCodexMessage } = await import(resolve(root, 'apps/extension/src/background/codexAdapter.ts'))
  const isolated = await codexTestHome()
  const canvas = new NativeCanvasBridge()
  const children: ReturnType<typeof Bun.spawn>[] = []
  const hosts: string[] = [], errors: string[] = []
  const ports = new Map<string, { page: Page; disconnect(): void; receive(value: unknown): void }>()
  const pages = new Set<Page>()
  let closing = false
  Object.assign(globalThis, { chrome: { runtime: {
    connectNative(name: string) {
      const entry = name === 'com.galta.canvas' ? 'native/bridge/galta-canvas-bridge' : name === 'com.galta.codex' ? 'native/adapters/codex/galta-codex-bridge' : undefined
      if (!entry) throw new Error(`Unexpected host: ${name}`)
      hosts.push(name)
      const child = Bun.spawn([resolve(root, entry), 'chrome-extension://oocbicpnofichiglihkbmpkjegiakhgg/'], { env: { ...process.env, GALTA_MCP_BIN: resolve(root, 'native/mcp/galta-mcp'), ...isolated.environment, ...environment, CODEX_HOME: isolated.home }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
      children.push(child)
      const messages = new Set<(value: any) => void>(), disconnects = new Set<() => void>()
      void new Response(child.stderr).text().then(text => { if (text.trim()) errors.push(text.trim()) })
      void (async () => {
        let buffer = Buffer.alloc(0)
        try {
          for await (const chunk of child.stdout) {
            buffer = Buffer.concat([buffer, chunk])
            while (buffer.length >= 4) {
              const length = buffer.readUInt32LE()
              if (length > 64 * 1024 * 1024) throw new Error('Native frame too large')
              if (buffer.length < length + 4) break
              const message = JSON.parse(buffer.subarray(4, length + 4).toString())
              buffer = buffer.subarray(length + 4)
              messages.forEach(fn => fn(message))
            }
          }
          if (buffer.length && !closing) throw new Error('Incomplete native frame')
        } catch (error) { if (!closing) errors.push(String(error)) }
        finally { disconnects.forEach(fn => fn()) }
      })()
      return {
        onMessage: { addListener: (fn: any) => messages.add(fn) }, onDisconnect: { addListener: (fn: any) => disconnects.add(fn) },
        postMessage(message: unknown) {
          const body = Buffer.from(JSON.stringify(message)), frame = Buffer.alloc(body.length + 4)
          frame.writeUInt32LE(body.length); body.copy(frame, 4); child.stdin.write(frame)
        },
        disconnect() { child.stdin.end() }
      }
    },
    async sendMessage(message: unknown) {
      await Promise.all([...pages].filter(page => !page.isClosed()).map(page => page.evaluate(message => (window as any).__galtaDeliver?.(message), message)))
    }
  } } })
  return {
    hosts, errors, codexHome: isolated.home, runtimeDirectory: isolated.environment.GALTA_RUNTIME_DIRECTORY!,
    async attach(page: Page) {
      pages.add(page)
      const release = () => {
        for (const [id, port] of ports) if (port.page === page) { port.disconnect(); ports.delete(id) }
      }
      // Playwright's framenavigated also fires for history.replaceState, which
      // does not close Chrome extension ports. Use document commits instead.
      const lifecycle = await page.context().newCDPSession(page)
      await lifecycle.send('Page.enable')
      lifecycle.on('Page.frameNavigated', ({ frame }) => { if (!frame.parentId) release() })
      page.on('close', () => { release(); pages.delete(page) })
      await page.exposeBinding('__galtaTransport', async (_, message) => {
        observe?.(message)
        if (message.type === 'port-open') {
          const name: string = message.name
          const messages = new Set<(value: any) => void>(), disconnects = new Set<() => void>()
          const port = {
            name, onMessage: { addListener: (fn: any) => messages.add(fn) }, onDisconnect: { addListener: (fn: any) => disconnects.add(fn) },
            postMessage: (value: unknown) => { void page.evaluate(({ name, value }) => (window as any).__galtaPortDeliver(name, value), { name, value }).catch(error => { if (!closing && !page.isClosed()) errors.push(String(error)) }) },
            disconnect: () => disconnects.forEach(fn => fn())
          }
          ports.set(name, { page, disconnect: port.disconnect, receive: value => messages.forEach(fn => fn(value)) })
          if (name.startsWith('galta-canvas:')) canvas.attach(port as any)
          else if (name.startsWith('galta-codex-client:')) {
            const owner = name.slice('galta-codex-client:'.length)
            codexAdapter.attachClient(owner)
            disconnects.add(() => codexAdapter.detachClient(owner))
          }
          else if (name !== 'galta-task-host') throw new Error(`Unexpected port: ${name}`)
          return
        }
        if (message.type === 'port-post') { ports.get(message.name)?.receive(message.value); return }
        if (message.type === 'port-close') { ports.get(message.name)?.disconnect(); ports.delete(message.name); return }
        if (message.type === 'setup-status') return { state: 'ready', health: COMPANION_FIXTURE_HEALTH }
        let response: unknown
        if (!await handleCodexMessage(message, (value: unknown) => { response = value })) throw new Error(`Unexpected extension message: ${message.type}`)
        return response
      })
      await page.addInitScript(() => {
        const w = window as any, listeners = new Set<(message: any) => void>(), ports = new Map<string, Set<(message: any) => void>>()
        let tasks: Promise<unknown> | undefined
        w.__galtaDeliver = (message: any) => listeners.forEach(fn => fn(message))
        w.__galtaPortDeliver = (name: string, value: any) => ports.get(name)?.forEach(fn => fn(value))
        w.chrome = { ...w.chrome, runtime: {
          id: 'oocbicpnofichiglihkbmpkjegiakhgg',
          onMessage: { addListener: (fn: any) => listeners.add(fn), removeListener: (fn: any) => listeners.delete(fn) },
          // This HTTP adapter exercises the actual task service in the page;
          // installed-extension acceptance owns offscreen lifecycle evidence.
          sendMessage: (message: any) => message.type === 'task-host-ensure'
            ? (tasks ??= import(new URL('/tasks.js', location.href).href)).then(() => ({ ok: true }))
            : w.__galtaTransport(message),
          connect({ name }: { name: string }) {
            const messages = new Set<(message: any) => void>(), ready = w.__galtaTransport({ type: 'port-open', name })
            ports.set(name, messages)
            return {
              onMessage: { addListener: (fn: any) => messages.add(fn) }, onDisconnect: { addListener() {} },
              postMessage: (value: any) => { void ready.then(() => w.__galtaTransport({ type: 'port-post', name, value })) },
              disconnect: () => { ports.delete(name); void ready.then(() => w.__galtaTransport({ type: 'port-close', name })) }
            }
          }
        } }
      })
    },
    async close() {
      closing = true
      for (const port of ports.values()) port.disconnect()
      ports.clear()
      for (const child of children) { child.stdin.end(); child.kill() }
      await Promise.all(children.map(child => child.exited))
      await isolated.close()
    }
  }
}
