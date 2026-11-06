import type { Page } from '@playwright/test'
import { installCanvasPort } from './canvas-port'

// Deterministic native-message fixture for storage races. It does not certify
// a model/provider; the separate live acceptance exercises actual Codex.
export async function controlledCodex(page: Page) {
  await page.addInitScript(() => {
    const w = window as any, listeners = new Set<(message: unknown) => void>()
    const thread = JSON.parse(sessionStorage.getItem('durability-thread') ?? '{"id":"durability-thread","turns":[]}')
    const notify = (notification: any) => { for (const listener of listeners) listener({ type: 'codex-notification', notification }) }
    const finish = (status = 'completed') => {
      const turn = thread.turns.at(-1)
      turn.status = status
      sessionStorage.setItem('durability-thread', JSON.stringify(thread))
      notify({ method: 'turn/completed', params: { threadId: thread.id, turn } })
    }
    w.durability = {
      active: false, interrupts: 0, connections: 0, calls: [], finish,
      call(tool: string, args: unknown) {
        return w.__canvasToolCall(tool, args)
      },
      holdSave(mode: string) {
        const put = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
          if (this.name !== 'workspaces' || !Object.values(value?.project?.commits ?? {}).some((commit: any) => commit.source === 'agent')) return put.call(this, value, key!)
          IDBObjectStore.prototype.put = put
          const tx = this.transaction
          if (mode === 'failure') {
            const aborted = tx.onabort!
            tx.onabort = event => { w.durability.held = true; w.durability.release = () => aborted.call(tx, event) }
            throw new DOMException('Agent save test', 'QuotaExceededError')
          }
          const complete = tx.oncomplete!
          tx.oncomplete = event => { w.durability.held = true; w.durability.release = () => complete.call(tx, event) }
          if (mode === 'activation-failure') IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
            if (this.name === 'workspaces' && value?.project?.commits[value.project.headCommitId]?.source === 'agent') {
              IDBObjectStore.prototype.put = put
              throw new DOMException('Activation save test', 'QuotaExceededError')
            }
            return put.call(this, value, key!)
          }
          return put.call(this, value, key!)
        }
      }
    }
    Object.assign(window, { chrome: { ...(window as any).chrome,
      windows: { getCurrent: async () => ({ id: 1 }) },
      storage: {
        session: { get: async () => ({}) },
        local: {
          get: async () => JSON.parse(sessionStorage.getItem('durability-preferences') ?? '{}'),
          set: async (value: any) => { sessionStorage.setItem('durability-preferences', JSON.stringify({ ...JSON.parse(sessionStorage.getItem('durability-preferences') ?? '{}'), ...value })) }
        }
      }, runtime: {
      onMessage: { addListener: (listener: any) => listeners.add(listener), removeListener: (listener: any) => listeners.delete(listener) },
      connect: () => ({ onDisconnect: { addListener() {} }, disconnect() {} }),
      async sendMessage(message: any) {
        if (message.type === 'codex-connect') { w.durability.connections++; return { ok: true, models: [{ id: 'gpt-5.6-sol', displayName: 'Test model', isDefault: true }] } }
        if (message.type === 'codex-respond') throw new Error('Unexpected dynamic tool response')
        if (message.type !== 'codex-rpc') throw new Error(`Unexpected message ${message.type}`)
        w.durability.calls.push({ method: message.method, params: message.params })
        let result: any = {}
        switch (message.method) {
          case 'galta/config/read': result = { toolContract: (window as any).__galtaToolContract, conversationStorage: 'galta' }; break
          case 'thread/start':
            if (sessionStorage.getItem('durability-unavailable')) {
              thread.id = 'fresh-durability-thread'; thread.turns = []
              sessionStorage.removeItem('durability-unavailable')
            }
            result = { thread }; break
          case 'thread/resume': case 'thread/read':
            if (sessionStorage.getItem('durability-unavailable')) throw new Error(`no rollout found for thread id ${message.params.threadId}`)
            result = { thread }; break
          case 'thread/unsubscribe': result = { status: 'unsubscribed' }; break
          case 'thread/name/set': break
          case 'turn/start': {
            w.durability.input = message.params.input
            const turn = { id: `turn-${thread.turns.length + 1}`, status: 'inProgress', items: [] }
            thread.turns.push(turn); result = { turn }; w.durability.active = true
            notify({ method: 'turn/started', params: { threadId: thread.id, turn } }); break
          }
          case 'turn/interrupt': w.durability.interrupts++; finish('interrupted'); break
          default: throw new Error(`Unexpected RPC ${message.method}`)
        }
        return { ok: true, result }
      }
    } } })
  })
  await installCanvasPort(page)
}
