import { BROWSER_TOOLS } from '../../packages/canvas/src/browser'
import { CANVAS_TOOLS } from '../../packages/canvas/src/tools'
import type { ToolExecution } from '../../packages/canvas/src/execution'
export type CanvasRegistration = { id: string; projectId: string; title: string }
export type CanvasLease = { id: string; canvasId: string; projectId: string; cwd: string; client: string; mode: 'embedded' | 'external' }
type Dispatch = (canvasId: string, method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
const tools = new Map<string, ToolExecution>([...CANVAS_TOOLS, ...BROWSER_TOOLS].map(tool => [tool.name, tool.execution]))
type ActiveCall = { abort: AbortController; execution: ToolExecution }

/** Routing identity and exclusion live here. The browser still validates every edit. */
export class CanvasRegistry {
  private readonly canvases = new Map<string, CanvasRegistration>()
  private readonly leases = new Map<string, CanvasLease>()
  private readonly projects = new Map<string, Set<string>>()
  private readonly calls = new Map<string, Set<ActiveCall>>()
  private readonly preparations = new Map<string, AbortController>()
  private readonly endings = new Map<string, Promise<void>>()

  constructor(private readonly dispatch: Dispatch, private readonly workspace: (projectId: string) => Promise<string>) {}

  list() { return [...this.canvases.values()].map(canvas => ({ ...canvas, busy: this.projects.has(canvas.projectId) })) }

  /** Internal routing view for the MCP server. Lease identities never leave
   * this authenticated bridge protocol or enter the model-visible canvas list. */
  embeddedLeases() {
    return [...this.leases.values()]
      .filter(lease => lease.mode === 'embedded')
      .map(({ id, canvasId, projectId }) => ({ id, canvasId, projectId }))
  }

  /** Files an embedded execution generates belong to its workspace. */
  embeddedWorkspace(id: string) {
    const lease = this.lease(id)
    if (lease.mode !== 'embedded') throw new Error('This is not an active UI-owned tool execution')
    return { cwd: lease.cwd }
  }

  registration(canvasId: string) {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) throw new Error('The canvas is no longer registered')
    return canvas
  }

  /** Whether any open view or agent lease still uses a project. */
  inUse(projectId: string) {
    return this.projects.has(projectId) || [...this.canvases.values()].some(canvas => canvas.projectId === projectId)
  }

  register(canvas: CanvasRegistration) {
    if (![canvas.id, canvas.projectId, canvas.title].every(value => typeof value === 'string' && value.length > 0 && value.length <= 300)) throw new Error('Invalid canvas registration')
    const old = this.canvases.get(canvas.id)
    if (old && old.projectId !== canvas.projectId) throw new Error('A canvas connection cannot change its document')
    this.canvases.set(canvas.id, { ...canvas })
  }

  async unregister(canvasId: string) {
    this.canvases.delete(canvasId)
    for (const lease of this.leases.values()) if (lease.canvasId === canvasId) await this.release(lease.id)
  }

  async connect(canvasId: string, client: string, mode: CanvasLease['mode'] = 'external', signal?: AbortSignal): Promise<CanvasLease> {
    signal?.throwIfAborted()
    const canvas = this.canvases.get(canvasId)
    if (!canvas) throw new Error('The selected canvas is no longer open')
    // Embedded Galta tasks can observe one canvas concurrently. An external
    // client still reserves the document exclusively so it cannot race the UI.
    const active = this.projects.get(canvas.projectId)
    if (active && (mode === 'external' || [...active].some(id => this.leases.get(id)?.mode === 'external'))) throw new Error('This document already has an active agent')
    const id = crypto.randomUUID()
    const abort = new AbortController()
    const cancel = () => abort.abort(new Error('Canvas connection cancelled'))
    signal?.addEventListener('abort', cancel, { once: true })
    const projectLeases = this.projects.get(canvas.projectId) ?? new Set<string>()
    projectLeases.add(id); this.projects.set(canvas.projectId, projectLeases)
    const lease: CanvasLease = { id, canvasId, projectId: canvas.projectId, cwd: '', client, mode }
    this.leases.set(id, lease)
    this.preparations.set(id, abort)
    try {
      lease.cwd = await this.workspace(canvas.projectId)
      abort.signal.throwIfAborted()
      if (!this.canvases.has(canvasId)) throw new Error('The selected canvas disconnected')
      await this.dispatch(canvasId, 'begin', lease, abort.signal)
      abort.signal.throwIfAborted()
      if (this.leases.get(id) !== lease) throw new Error('Canvas execution was cancelled')
      return lease
    } catch (error) {
      await this.release(id)
      throw error
    } finally {
      signal?.removeEventListener('abort', cancel)
      this.preparations.delete(id)
    }
  }

  lease(id: string) {
    const lease = this.leases.get(id)
    if (!lease) throw new Error('Canvas execution is not active; connect again explicitly')
    return lease
  }

  async call(id: string, tool: string, args: unknown, signal?: AbortSignal) {
    const lease = this.lease(id)
    const execution = tools.get(tool)
    if (!execution) throw new Error(`Unknown Galta tool: ${tool}`)
    const calls = this.calls.get(id) ?? new Set<ActiveCall>()
    if ([...calls].some(call => call.execution.resource === execution.resource && (call.execution.exclusive || execution.exclusive))) {
      throw new Error(`A ${execution.resource} operation is already running`)
    }
    const abort = new AbortController()
    const cancel = () => abort.abort(signal?.reason ?? new Error('MCP call cancelled'))
    signal?.throwIfAborted()
    signal?.addEventListener('abort', cancel, { once: true })
    const call = { abort, execution }
    calls.add(call)
    this.calls.set(id, calls)
    try {
      const result = await this.dispatch(lease.canvasId, 'call', { leaseId: id, tool, args }, abort.signal)
      abort.signal.throwIfAborted()
      this.lease(id)
      return result
    } finally {
      signal?.removeEventListener('abort', cancel)
      calls.delete(call)
      if (!calls.size && this.calls.get(id) === calls) this.calls.delete(id)
    }
  }

  async boundCall(id: string, tool: string, args: unknown, signal?: AbortSignal) {
    if (this.lease(id).mode !== 'embedded' || !tools.has(tool)) throw new Error('This is not an active UI-owned tool execution')
    return this.call(id, tool, args, signal)
  }

  async release(id: string) {
    if (this.endings.has(id)) return this.endings.get(id)
    const lease = this.leases.get(id)
    if (!lease) return
    this.leases.delete(id)
    this.preparations.get(id)?.abort(new Error('Canvas execution ended'))
    for (const call of this.calls.get(id) ?? []) call.abort.abort(new Error('Canvas execution ended'))
    this.calls.delete(id)
    const ending = Promise.resolve().then(async () => {
      try { if (this.canvases.has(lease.canvasId)) await this.dispatch(lease.canvasId, 'end', { leaseId: id }) }
      catch (error) {
        // A surface that did not acknowledge teardown must register anew.
        this.canvases.delete(lease.canvasId)
        throw error
      } finally {
        const projectLeases = this.projects.get(lease.projectId)
        projectLeases?.delete(id)
        if (projectLeases?.size === 0) this.projects.delete(lease.projectId)
        this.endings.delete(id)
      }
    })
    this.endings.set(id, ending)
    return ending
  }

  async close() {
    this.canvases.clear()
    await Promise.all([...this.leases.keys()].map(id => this.release(id)))
  }
}
