import type { Page, BrowserContext } from '@playwright/test'
import { galtaToolContract } from '../../packages/canvas/src/contract'

/** A returning signed-in user for layout tests, without starting a model. */
export async function installReturningAccount(page: Page | BrowserContext) {
  await page.addInitScript(() => {
    Object.assign(window, { chrome: {
      storage: { local: { get: async () => ({ 'galta.ai.enabled': true }), set: async () => {} } },
      runtime: {
        onMessage: { addListener() {}, removeListener() {} },
        connect: () => ({ onDisconnect: { addListener() {} }, disconnect() {} }),
        sendMessage: async (message: any) => message.type === 'codex-connect'
          ? { ok: true, models: [{ id: 'gpt-test', displayName: 'GPT Test', supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) }] }
          : { ok: true, result: { thread: { id: 'layout-fixture', turns: [] } } }
      }
    } })
  })
  await installCanvasPort(page, false)
}

/** Deterministic Chrome/host lease fixture for browser persistence race tests.
 * Real native framing and MCP are covered by verify-canvas-mcp.ts. */
export async function installCanvasPort(page: Page | BrowserContext, exposeExtensionId = true) {
  await page.addInitScript(({ exposeExtensionId, toolContract }) => {
    ;(window as any).__galtaToolContract = toolContract
    const runtime = (window as any).chrome.runtime, original = runtime.connect
    // Vite serves source entries during browser tests; the acceptance server
    // serves the exact production bundle. Detect the entry format instead of
    // coupling the fixture to a page pathname.
    // The init script runs before the page parser has inserted its module
    // script, so resolve the development/production entry lazily when the
    // first task-host request arrives.
    const taskEntry = () => document.querySelector('script[type="module"][src$=".tsx"]') ? '/tasks/main.ts' : '/tasks.js'
    if (exposeExtensionId) runtime.id = 'galta-test'
    // The acceptance host models the browser APIs used by the mounted canvas
    // without depending on every individual test to repeat the same baseline.
    // Scenarios that need stricter behavior replace these methods afterwards.
    const browser = (window as any).chrome
    browser.windows ??= { getCurrent: async () => ({ id: 1 }) }
    browser.tabs ??= { getCurrent: async () => ({ id: 1, windowId: 1 }), onRemoved: { addListener() {}, removeListener() {} } }
    browser.storage ??= {}
    browser.storage.session ??= { get: async () => ({}), set: async () => {}, remove: async () => {} }
    const sendMessage = runtime.sendMessage.bind(runtime)
    let tasks: Promise<unknown> | undefined
    runtime.sendMessage = (message: any) => message.type === 'task-host-ensure'
      // The deterministic fixture hosts the real service in this document.
      // verify-background-tasks.ts separately proves real offscreen lifetime.
      ? (tasks ??= import(new URL(taskEntry(), location.href).href)).then(() => ({ ok: true }))
      : message.type === 'setup-status'
      ? Promise.resolve({ state: 'ready', health: { protocol: 1, version: '0.1.0', releaseId: 'test', channel: 'development', capabilities: ['canvas/1', 'codex/1', 'mcp/1'], runtime: { available: true, version: 'test' } } })
      : sendMessage(message)
    runtime.connect = (options: { name: string }) => {
      if (!options.name.startsWith('galta-canvas:')) return original(options)
      const listeners = new Set<(message: any) => void>(), pending = new Map<string, (message: any) => void>()
      let lease: any, projectId: string
      const emit = (message: any) => queueMicrotask(() => listeners.forEach(fn => fn(message)))
      ;(window as any).__canvasToolCall = (tool: string, args: unknown) => new Promise(resolve => {
        const id = crypto.randomUUID()
        pending.set(id, message => resolve(message.error ? { isError: true, content: [{ type: 'text', text: message.error.message }] } : message.result))
        emit({ id, method: 'canvas/call', params: { leaseId: lease?.id, tool, args } })
      })
      return {
        onMessage: { addListener: (fn: any) => listeners.add(fn) }, onDisconnect: { addListener() {} }, disconnect() {},
        postMessage(message: any) {
          if (!message.method) { pending.get(message.id)?.(message); pending.delete(message.id); return }
          if (message.method === 'canvas/register') {
            projectId = message.params.projectId
            emit({ id: message.id, result: { toolContract } })
            ;(window as any).__beginExternalAgent = (client: string) => new Promise(resolve => {
              lease = { id: crypto.randomUUID(), bridgeId: 'test-bridge', canvasId: 'test-canvas', projectId, cwd: '/tmp/galta-test', client, mode: 'external' }
              const id = crypto.randomUUID()
              pending.set(id, resolve)
              emit({ id, method: 'canvas/begin', params: lease })
            })
          } else if (message.method === 'canvas/acquire') {
            lease = { id: crypto.randomUUID(), bridgeId: 'test-bridge', canvasId: message.params.canvasId, projectId, cwd: '/tmp/galta-test', client: 'Galta', mode: 'embedded' }
            const id = crypto.randomUUID()
            pending.set(id, () => emit({ id: message.id, result: lease }))
            const gate = (window as any).__canvasAcquireGate
            if (gate) {
              (window as any).__canvasAcquireHeld = true
              void gate.then(() => emit({ id, method: 'canvas/begin', params: lease }))
            } else emit({ id, method: 'canvas/begin', params: lease })
          } else if (message.method === 'canvas/release') {
            const id = crypto.randomUUID()
            pending.set(id, () => emit({ id: message.id, result: {} }))
            emit({ id, method: 'canvas/end', params: { leaseId: lease.id } })
          } else emit({ id: message.id, result: {} })
        }
      }
    }
  }, { exposeExtensionId, toolContract: await galtaToolContract() })
}

export async function connectCodex(page: Page) {
  const action = page.locator('.conversation-dock').getByRole('button', { name: /^(Connect an agent|Reconnect agent)$/ })
  const reconnect = await action.innerText() === 'Reconnect agent'
  await action.click()
  if (!reconnect) {
    await page.getByRole('dialog').getByRole('button', { name: /^Chat in Galta/ }).click()
  }
  await page.getByRole('button', { name: 'Back to your canvas', exact: true }).click()
}
