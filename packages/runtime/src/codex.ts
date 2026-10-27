import { CODEX_EXECUTION_POLICY } from './codexConfig'
import { codexInstructions } from './codexInstructions'
import { assertGaltaToolContract, CANVAS_MESSAGE_LABEL, canvasMessageContextSchema } from '@galta/canvas'
import { artifactDeliveryDeclarationSchema, CANVAS_REGION_IDS, type CanvasChangeRegion } from '@galta/domain'
import type { AgentHost, AgentInput, AgentRunHandle, AgentUpdate, AgentRuntime, ConversationItem } from './index'
export type CodexAgentInput = AgentInput & (
  | { threadId?: string; fork?: never }
  | { threadId?: never; fork: { threadId: string; lastTurnId: string } }
)
export type CodexAgentUpdate = AgentUpdate & { threadId?: string; turnId?: string }

export type CodexJsonRpcNotification = { id?: string | number; method: string; params?: Record<string, unknown> }
// app-server normally follows an error with turn/completed. Keep a small
// bounded window for that receipt, but never leave the application waiting
// forever when a provider retry stream is orphaned.
const CODEX_RECONNECT_GRACE_MS = 30_000
const CODEX_TERMINAL_ERROR_GRACE_MS = 2_000
export interface CodexRpcClient {
  request(method: string, params?: unknown): Promise<unknown>
  respond(id: string | number, result?: unknown, error?: { code: number; message: string }): Promise<void>
  subscribe(listener: (notification: CodexJsonRpcNotification) => void): () => void
}

/** Execution policy stays in application context. The canvas observation is
 * attached to the user message it accompanies, with its pixels. */
export function additionalContext(input: AgentInput): Record<string, { kind: 'untrusted' | 'application'; value: string }> {
  const context: Record<string, { kind: 'untrusted' | 'application'; value: string }> = {
    canvas: { kind: 'application', value: JSON.stringify({ projectId: input.projectId, branchId: input.branchId }) },
    execution: { kind: 'application', value: JSON.stringify(input.execution) }
  }
  if (input.browser) context.browser = { kind: 'untrusted', value: JSON.stringify(input.browser) }
  return context
}

function record(value: unknown): Record<string, any> | undefined { return value && typeof value === 'object' ? value as Record<string, any> : undefined }
function failure(error: unknown) { return error instanceof Error ? error.message : String(error) }

/** A submitted preview is an evidence-bearing image. Check its bytes before
 * handing the message to the provider so a stale or hand-built context cannot
 * silently claim provenance for a different image. Legacy contexts without an
 * evidenceId remain readable, but new contexts are bound by the hash emitted
 * by the canvas capture. */
async function validateCanvasPreview(input: AgentInput['canvas']): Promise<void> {
  if (!input) return
  const context = canvasMessageContextSchema.parse(input.context)
  const preview = context.preview
  if (preview.status !== 'attached' && input.image) throw new Error(`A ${preview.status} canvas preview cannot carry pixels`)
  if (preview.status !== 'attached' || !preview.evidenceId) return
  const evidence = context.evidence?.find(item => item.id === preview.evidenceId)
  if (!evidence || evidence.type !== 'pixels') throw new Error('The canvas preview evidence is missing its pixel record')
  if (evidence.revision !== context.revision) throw new Error('The canvas preview evidence revision does not match its context')
  if (!input.image) throw new Error('The canvas preview declares pixels but no image was supplied')
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(input.image.dataUrl)
  const encoded = match?.[2]
  if (!encoded) throw new Error('The canvas preview must be a PNG, JPEG or WebP data URL')
  if (match?.[1] !== evidence.mimeType) throw new Error('The canvas preview MIME type does not match its pixel evidence')
  const binary = atob(encoded), bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  if (actual !== evidence.sha256) throw new Error('The canvas preview bytes do not match their evidence hash')
}
class Queue<T> {
  private values: T[] = []
  private offset = 0
  private waiter: ((value: T) => void) | undefined
  push(value: T) { if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(value) } else this.values.push(value) }
  next(): Promise<T> {
    if (this.offset < this.values.length) {
      const value = this.values[this.offset++]!
      if (this.offset === this.values.length) { this.values = []; this.offset = 0 }
      return Promise.resolve(value)
    }
    return new Promise(resolve => { this.waiter = resolve })
  }
}
type Active = { threadId?: string; turnId?: string; completedTurnId?: string; abort: AbortController; queue: Queue<CodexJsonRpcNotification>; interruption?: Promise<void> }

function itemLabel(raw: Record<string, any>, type: string): string {
  switch (type) {
    case 'userMessage': return ''
    case 'agentMessage': return String(raw.text ?? '')
    case 'dynamicToolCall': { const verb = String(raw.tool ?? '').replace(/^canvas_/, ''); return verb ? `Canvas: ${verb}` : 'Canvas' }
    case 'commandExecution': return String(raw.command ?? 'Running a command')
    case 'imageGeneration': return 'Generating image'
    case 'imageView': return 'Viewing an image'
    case 'webSearch': return 'Searching the web'
    case 'reasoning': return 'Thinking'
    case 'plan': return 'Making a plan'
    case 'fileChange': return 'Editing files'
    case 'collabToolCall': return 'Working with another agent'
    case 'functionCallOutput': return 'Receiving tool output'
    case 'enteredReviewMode': return 'Entering review mode'
    case 'exitedReviewMode': return 'Leaving review mode'
    case 'mcpToolCall': return String(raw.tool ?? 'Using a tool')
    // Codex compacts a thread on its own once the context nears the model
    // limit. Naming the item keeps that visible instead of silent.
    case 'contextCompaction': return 'Condensing earlier context'
    default: return type || 'Working'
  }
}

/** The region a receipt's changed elements cover. Elements without an id or
 * finite bounds do not count; a receipt with no geometry has no region. */
function changeRegion(elements: readonly unknown[]): CanvasChangeRegion | undefined {
  const placed = elements.flatMap(value => {
    const el = record(value), bounds = record(el?.bounds)
    return typeof el?.id === 'string' && bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) && bounds.width >= 0 && bounds.height >= 0
      ? [{ id: el.id, x: bounds.x as number, y: bounds.y as number, right: bounds.x + bounds.width as number, bottom: bounds.y + bounds.height as number }] : []
  })
  if (!placed.length) return undefined
  const x = Math.min(...placed.map(el => el.x)), y = Math.min(...placed.map(el => el.y))
  return { ids: placed.slice(0, CANVAS_REGION_IDS).map(el => el.id),
    bounds: { x, y, width: Math.max(...placed.map(el => el.right)) - x, height: Math.max(...placed.map(el => el.bottom)) - y } }
}

/** Public tool result content is the authority for completed effects. Never
 * infer a successful replacement from requested arguments or label prose. */
function canvasChanges(raw: Record<string, any>): ConversationItem['canvasChanges'] {
  if (raw.type !== 'mcpToolCall' || raw.server !== 'galta' || !['canvas_place', 'canvas_edit'].includes(raw.tool)) return undefined
  for (const part of Array.isArray(raw.result?.content) ? raw.result.content : []) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue
    let receipt: Record<string, any> | undefined
    try { receipt = record(JSON.parse(part.text)) } catch { continue }
    if (!receipt || typeof receipt.revision !== 'string') continue
    if (raw.tool === 'canvas_place' && ['created', 'updated'].includes(receipt.action) && ['image', 'video'].includes(receipt.kind)) {
      const region = changeRegion([receipt.element])
      return { created: Number(receipt.action === 'created'), updated: Number(receipt.action === 'updated'), deleted: 0, kind: receipt.kind, ...(region ? { region } : {}) }
    }
    if (raw.tool === 'canvas_edit' && Array.isArray(receipt.elements) && Array.isArray(receipt.deletedIds) && receipt.deletedIds.every((id: unknown) => typeof id === 'string') && receipt.elements.every((el: any) => el && ['created', 'updated'].includes(el.change))) {
      const region = changeRegion(receipt.elements)
      return { created: receipt.elements.filter((el: any) => el.change === 'created').length,
        updated: receipt.elements.filter((el: any) => el.change === 'updated').length, deleted: receipt.deletedIds.length, ...(region ? { region } : {}) }
    }
  }
  return undefined
}

function deliveryDeclaration(raw: Record<string, any>): ConversationItem['delivery'] {
  if (raw.type !== 'mcpToolCall' || raw.server !== 'galta' || raw.tool !== 'canvas_deliver') return undefined
  const structured = record(raw.result?.structuredContent)
  if (structured) {
    const parsed = artifactDeliveryDeclarationSchema.safeParse(structured)
    if (parsed.success) return parsed.data
  }
  for (const part of Array.isArray(raw.result?.content) ? raw.result.content : []) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue
    try {
      const parsed = artifactDeliveryDeclarationSchema.safeParse(JSON.parse(part.text))
      if (parsed.success) return parsed.data
    } catch { /* malformed tool output is not a delivery declaration */ }
  }
  return undefined
}

const MAX_ITEM_DETAILS = 16_000
const MAX_DETAIL_STRING = 12_000
const MAX_STREAM_OUTPUT = 64_000
const STREAM_DETAIL_TRUNCATION = '\n\n... details truncated while streaming ...'
const STREAM_OUTPUT_TRUNCATION = '\n\n... output truncated while streaming ...'
const DETAIL_OMIT_KEYS = new Set(['encrypted_content', 'encryptedContent', 'base64', 'bytes', 'data', 'image', 'blob'])

function appendBounded(previous: string, delta: string, limit: number, marker: string): string {
  if (!delta || previous.endsWith(marker) || previous.length >= limit) return previous
  const remaining = limit - previous.length
  if (delta.length < remaining) return previous + delta
  const keep = Math.max(0, remaining - marker.length)
  return previous + delta.slice(0, keep) + marker.slice(0, remaining)
}

/** Format provider payloads for the lazy activity disclosure. Keep this
 * deliberately bounded: tool receipts can contain large canvas pages or
 * binary-looking fields, while the transcript only needs an inspectable
 * summary of the input and output. Provider-bound encrypted reasoning is
 * never copied into the user-facing details. */
function formatDetail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value || undefined
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    const json = JSON.stringify(value, (key, nested) => {
      if (DETAIL_OMIT_KEYS.has(key)) return undefined
      if (typeof nested === 'string' && nested.length > MAX_DETAIL_STRING) return `${nested.slice(0, MAX_DETAIL_STRING)}…`
      if (Array.isArray(nested) && nested.length > 80) return [...nested.slice(0, 80), `… ${nested.length - 80} more items`]
      return nested
    }, 2)
    return typeof json === 'string' ? json : undefined
  } catch {
    return String(value)
  }
}

function textParts(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined
  if (!Array.isArray(value)) return undefined
  const text: string[] = []
  for (const part of value) {
    if (typeof part === 'string') { if (part) text.push(part); continue }
    const object = record(part)
    if (!object) continue
    if (typeof object.text === 'string' && object.text) text.push(object.text)
    else if (typeof object.summary_text === 'string' && object.summary_text) text.push(object.summary_text)
    else if (typeof object.content === 'string' && object.content) text.push(object.content)
  }
  return text.length ? text.join('\n') : undefined
}

function resultText(raw: Record<string, any>): string | undefined {
  const result = record(raw.result)
  const parts: string[] = []
  const content = textParts(result?.content ?? result?.contentItems ?? raw.contentItems ?? raw.content)
  if (content) parts.push(content)
  const structured = result?.structuredContent ?? result?.structured_content
  if (structured !== undefined) {
    const value = formatDetail(structured)
    if (value) parts.push(value)
  }
  const output = raw.output ?? result?.output ?? result?.text ?? (raw.type === 'plan' ? raw.text : undefined)
  if (output !== undefined) {
    const value = formatDetail(output)
    if (value && !parts.includes(value)) parts.push(value)
  }
  if (!parts.length && typeof raw.result === 'string') parts.push(raw.result)
  if (!parts.length && result) {
    const value = formatDetail(result)
    if (value) parts.push(value)
  }
  return parts.length ? parts.join('\n') : undefined
}

function appendDetail(sections: string[], label: string, value: unknown) {
  const formatted = formatDetail(value)
  if (formatted) sections.push(`${label}\n${formatted}`)
}

function itemDetails(raw: Record<string, any>, type: string): string | undefined {
  if (type === 'agentMessage' || type === 'commandExecution') return undefined
  const sections: string[] = []
  if (type === 'reasoning') {
    const summary = textParts(raw.summary) ?? formatDetail(raw.summaryText ?? raw.summary_text)
    // The app-server's public reasoning surface is its summary. `content` and
    // `text` may carry private reasoning or provider-specific internals; they
    // are deliberately not projected into the transcript.
    if (summary) sections.push(summary)
  } else {
    appendDetail(sections, 'Input', raw.arguments ?? raw.input ?? raw.parameters)
    if (type === 'webSearch') {
      appendDetail(sections, 'Query', raw.query)
      appendDetail(sections, 'Action', raw.action)
    } else if (type === 'imageView') {
      appendDetail(sections, 'Path', raw.path)
    } else if (type === 'fileChange') {
      appendDetail(sections, 'Changes', raw.changes ?? raw.diff)
    } else if (type === 'collabToolCall') {
      appendDetail(sections, 'Prompt', raw.prompt)
      appendDetail(sections, 'Receiver', raw.receiverThreadId ?? raw.receiver_thread_id)
    } else if (type === 'enteredReviewMode' || type === 'exitedReviewMode') {
      appendDetail(sections, 'Review', raw.review)
    }
    // Image-generation results can be a large provider payload. The durable
    // user-facing receipt is the saved path; do not copy the raw image body
    // into conversation history.
    const output = type === 'imageGeneration'
      ? formatDetail(raw.savedPath ?? raw.path)
      : resultText(raw) ?? formatDetail(type === 'imageView' ? raw.savedPath : raw.savedPath ?? raw.path)
    if (output) sections.push(`Output\n${output}`)
    if (type === 'dynamicToolCall' && raw.success !== undefined) appendDetail(sections, 'Success', raw.success)
  }
  const error = typeof raw.error === 'string' ? raw.error : typeof raw.error?.message === 'string' ? raw.error.message : undefined
  if (error && !sections.some(section => section.includes(error))) sections.push(`Error\n${error}`)
  const details = sections.join('\n\n').trim()
  return details ? details.slice(0, MAX_ITEM_DETAILS) : undefined
}

/**
 * How a thread item reads in the conversation. One owner, so a live item and
 * the same item restored by `thread/read` can never disagree, and a field
 * added here reaches both. `null` means the surface already shows the item and
 * must not repeat it.
 *
 * The tool name travels as itself. A surface with different copy per canvas
 * verb reads `tool`; nothing has to recover that fact from the label, which is
 * prose and free to change.
 */
export function conversationItem(raw: Record<string, any>, defaultStatus: string): ConversationItem | null {
  const type = String(raw.type ?? '')
  const text = itemLabel(raw, type)
  // An empty started message still carries its phase before the first delta.
  if (!text && type !== 'agentMessage') return null
  const toolFailed = (type === 'mcpToolCall' || type === 'dynamicToolCall') && ((raw.status ?? defaultStatus) === 'failed' || raw.result?.isError === true || raw.success === false)
  const changes = !toolFailed && (raw.status ?? defaultStatus) === 'completed' ? canvasChanges(raw) : undefined
  const delivery = !toolFailed && (raw.status ?? defaultStatus) === 'completed' ? deliveryDeclaration(raw) : undefined
  const error = typeof raw.error === 'string' ? raw.error : typeof raw.error?.message === 'string' ? raw.error.message : toolFailed ? (
    (Array.isArray(raw.result?.content) ? raw.result.content : Array.isArray(raw.contentItems) ? raw.contentItems : [])
      .filter((part: any) => typeof part?.text === 'string').map((part: any) => part.text).join('\n')) : undefined
  const details = itemDetails(raw, type)
  return {
    id: String(raw.id), type, text, status: toolFailed ? 'failed' : String(raw.status ?? defaultStatus),
    ...(type === 'agentMessage' && (raw.phase === 'commentary' || raw.phase === 'final_answer') ? { phase: raw.phase } : {}),
    ...(error ? { error } : {}),
    ...(type === 'commandExecution' ? {
      ...(Number.isInteger(raw.exitCode) ? { exitCode: raw.exitCode } : {}),
      ...(typeof raw.aggregatedOutput === 'string' ? { output: raw.aggregatedOutput } : {}),
      ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {})
    } : {}),
      ...(typeof raw.tool === 'string' ? { tool: raw.tool } : {}),
    ...(typeof raw.server === 'string' ? { server: raw.server } : {}),
    ...(details ? { details } : {}),
    ...(changes ? { canvasChanges: changes } : {}),
    ...(delivery ? { delivery } : {}),
    ...(typeof raw.savedPath === 'string' ? { imagePath: raw.savedPath } : {})
  }
}

export class CodexAgentRuntime implements AgentRuntime<CodexAgentInput, CodexAgentUpdate> {
  readonly id = 'codex-app-server'
  readonly capabilities = { persistentSessions: true, forkAtTurn: true, contextUsage: true, steering: true } as const
  private active = new Map<string, Active>()
  constructor(private readonly rpc: CodexRpcClient) {}

  async readThread(threadId: string): Promise<unknown> {
    const response = record(await this.rpc.request('thread/read', { threadId, includeTurns: true }))
    if (!response?.thread) throw new Error('Codex returned no conversation history')
    return response.thread
  }

  async start(input: CodexAgentInput, host: AgentHost): Promise<AgentRunHandle<CodexAgentUpdate>> {
    if (!input.instruction.trim()) throw new Error('Instruction cannot be empty')
    if (input.threadId !== undefined && input.fork !== undefined) throw new Error('Choose either an existing Codex thread or a fork checkpoint, not both')
    if (!input.projectId || !input.runtime.modelId || input.runtime.providerId !== this.id) throw new Error('Connect Codex before running a command')
    if (!input.execution?.id || !input.execution.cwd) throw new Error('Acquire a Galta execution before running a command')
    if (input.canvas?.image && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(input.canvas.image.dataUrl)) throw new Error('The canvas observation must be a PNG, JPEG or WebP image')
    await validateCanvasPreview(input.canvas)
    const runId = crypto.randomUUID()
    const current: Active = { abort: new AbortController(), queue: new Queue<CodexJsonRpcNotification>() }
    this.active.set(runId, current)
    return { runId, updates: this.run(input, host, runId, current) }
  }

  private async *run(input: CodexAgentInput, host: AgentHost, runId: string, current: Active): AsyncGenerator<CodexAgentUpdate> {
    let unsubscribe: (() => void) | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let terminalErrorTimer: ReturnType<typeof setTimeout> | undefined
    const requests = new Map<string, AbortController>()
    const dismissRequests = () => {
      for (const request of requests.values()) request.abort(new Error('The Codex request is no longer pending'))
      requests.clear()
    }
    try {
      yield { state: 'preparing' }
      if (current.abort.signal.aborted) { yield { state: 'stopped' }; return }
      const settings = record(await this.rpc.request('galta/config/read'))
      if (current.abort.signal.aborted) { yield { state: 'stopped' }; return }
      await assertGaltaToolContract(settings?.toolContract)
      if (current.abort.signal.aborted) { yield { state: 'stopped' }; return }
      const instructions = codexInstructions()
      const config = { model: input.runtime.modelId, cwd: input.execution.cwd, sandbox: CODEX_EXECUTION_POLICY.sandbox, approvalPolicy: CODEX_EXECUTION_POLICY.approvalPolicy }
      // Galta's tool catalog and execution belong exclusively to MCP.
      // Turn paging is skipped here: the conversation is reconciled separately,
      // and resuming with full history only adds startup cost.
      const response = record(input.fork
        ? await this.rpc.request('thread/fork', { ...config, threadId: input.fork.threadId, lastTurnId: input.fork.lastTurnId, excludeTurns: true })
        : input.threadId
          ? await this.rpc.request('thread/resume', { ...config, threadId: input.threadId, excludeTurns: true })
          : await this.rpc.request('thread/start', { ...config, ephemeral: false }))
      const threadId = response?.thread?.id
      if (typeof threadId !== 'string') throw new Error('Codex did not return a thread id')
      yield { state: 'preparing', threadId }
      if (current.abort.signal.aborted) { yield { state: 'stopped' }; return }
      current.threadId = threadId
      const { queue } = current
      unsubscribe = this.rpc.subscribe(notification => {
        if (notification.params?.threadId !== threadId && notification.method !== 'galta/connection-lost') return
        // Events can arrive before the turn/start response or while the
        // consumer persists an update. Keep the terminal identity, so Stop
        // cannot interrupt a finished turn or be suppressed by an older one.
        const completedId = record(notification.params?.turn)?.id
        if (notification.method === 'turn/completed' && typeof completedId === 'string' && (!current.turnId || completedId === current.turnId)) {
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined }
          if (terminalErrorTimer) { clearTimeout(terminalErrorTimer); terminalErrorTimer = undefined }
          current.completedTurnId = completedId
          dismissRequests()
        }
        // Resolution can arrive while the consumer is persisting an item or
        // awaiting user input. Dismiss at receipt, not behind that same wait.
        if (notification.id !== undefined) requests.set(String(notification.id), new AbortController())
        if (notification.method === 'serverRequest/resolved') {
          const id = String(notification.params?.requestId)
          requests.get(id)?.abort(new Error('Codex resolved this request'))
          requests.delete(id)
        }
        if (notification.method === 'galta/connection-lost') dismissRequests()
        queue.push(notification)
      })
      const turn = record(await this.rpc.request('turn/start', {
        threadId, model: input.runtime.modelId, effort: input.runtime.effort.toLowerCase(),
        // Loaded threads ignore thread/resume configuration changes. Apply the
        // user-authorized execution policy at the actual turn boundary too.
        cwd: config.cwd,
        approvalPolicy: config.approvalPolicy,
        sandboxPolicy: CODEX_EXECUTION_POLICY.sandboxPolicy,
        // Application context is delivered as a developer message on the actual
        // turn, including loaded and forked threads. Keep the current contract
        // out of both the user request and Codex's collaboration/base policy.
        additionalContext: { ...additionalContext(input), galta_instructions: { kind: 'application', value: instructions } },
        input: [
          { type: 'text', text: input.instruction, text_elements: [] },
          ...(input.canvas ? [{ type: 'text', text: `${CANVAS_MESSAGE_LABEL}\n${JSON.stringify(input.canvas.context)}`, text_elements: [] }] : []),
          ...(input.canvas?.image ? [{ type: 'image', url: input.canvas.image.dataUrl }] : [])
        ]
      }))?.turn
      if (typeof turn?.id !== 'string') throw new Error('Codex did not return a turn id')
      current.turnId = turn.id
      yield { state: 'streaming', threadId, turnId: turn.id }
      const items = new Map<string, ConversationItem>()
      let retry: ConversationItem | undefined
      let retryCount = 0
      let turnError: string | undefined
      const clearReconnectTimer = () => { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined } }
      const scheduleFailure = (method: 'galta/reconnect-timeout' | 'galta/terminal-error', message: string, delay: number) => {
        if (method === 'galta/reconnect-timeout' ? reconnectTimer : terminalErrorTimer) return
        const timer = setTimeout(() => {
          if (method === 'galta/reconnect-timeout') reconnectTimer = undefined
          else terminalErrorTimer = undefined
          queue.push({ method, params: { threadId, turnId: turn.id, message } })
        }, delay)
        if (method === 'galta/reconnect-timeout') reconnectTimer = timer
        else terminalErrorTimer = timer
      }
      while (true) {
        // An interrupt acknowledgement is not completion. Drain final item
        // receipts and wait for this turn's authoritative terminal event.
        if (current.abort.signal.aborted) await this.interrupt(current)
        const n = await queue.next()
        const p = n.params
        if (n.method === 'galta/connection-lost') throw new Error(String(p?.message ?? 'Codex disconnected'))
        if (!p) continue
        const notificationTurn = p.turnId ?? record(p.turn)?.id
        if (notificationTurn && notificationTurn !== turn.id) continue
        if (n.method === 'galta/reconnect-timeout' || n.method === 'galta/terminal-error') {
          clearReconnectTimer()
          if (terminalErrorTimer) { clearTimeout(terminalErrorTimer); terminalErrorTimer = undefined }
          if (retry) {
            yield { state: 'streaming', item: { ...retry, status: 'failed', error: turnError ?? String(p.message ?? 'Codex did not reconnect') } }
            retry = undefined
          }
          throw new Error(String(p.message ?? turnError ?? 'Codex turn failed'))
        }
        if (n.method === 'error') {
          const message = String(record(p.error)?.message ?? 'Codex request failed')
          if (p.willRetry !== true) {
            turnError = message
            scheduleFailure('galta/terminal-error', message, CODEX_TERMINAL_ERROR_GRACE_MS)
            continue
          }
          // Codex owns retries. Project its notification without restarting the
          // turn, replaying tools, or adding another retry policy.
          retry = { id: retry?.id ?? `${turn.id}-model-retry-${++retryCount}`, type: 'modelRetry', text: 'Waiting for the model to reconnect', status: 'inProgress', error: message }
          scheduleFailure('galta/reconnect-timeout', 'Codex did not reconnect within 30 seconds', CODEX_RECONNECT_GRACE_MS)
          yield { state: 'streaming', item: retry }; continue
        }
        const modelProgress = n.method === 'item/agentMessage/delta' || n.method === 'item/plan/delta' || n.method === 'item/reasoning/summaryTextDelta' || n.method === 'item/reasoning/summaryPartAdded' || n.method === 'item/reasoning/textDelta'
          || (n.method === 'item/started' || n.method === 'item/completed') && ['agentMessage', 'reasoning'].includes(String(record(p.item)?.type))
        if (retry && (modelProgress && !turnError || n.method === 'turn/completed')) {
          clearReconnectTimer()
          const terminal = record(p.turn)
          const status = terminal?.status === 'failed' ? 'failed' : terminal?.status === 'interrupted' ? 'interrupted' : 'completed'
          yield { state: 'streaming', item: { ...retry, status, ...(status === 'failed' ? { error: String(record(terminal?.error)?.message ?? turnError ?? retry.error) } : {}) } }
          retry = undefined
        }
        if (n.method === 'thread/tokenUsage/updated') {
          const usage = record(p.tokenUsage)
          const last = record(usage?.last)
          if (typeof usage?.modelContextWindow === 'number' && typeof last?.inputTokens === 'number') yield { state: 'streaming', context: { tokens: last.inputTokens, window: usage.modelContextWindow } }
          continue
        }
        if (n.id !== undefined) {
          const id = String(n.id), request = requests.get(id)
          if (!request) continue
          let result: unknown
          let rpcError: { code: number; message: string } | undefined
          try {
            const signal = AbortSignal.any([current.abort.signal, request.signal])
            signal.throwIfAborted()
            result = await host.request(n.method, p, signal)
          }
          catch (error) { rpcError = { code: -32000, message: failure(error) } }
          // Transport failure is terminal. Never send a second answer for a
          // request whose first delivery may already have succeeded, or answer
          // one that the server cleared while its UI was awaiting input.
          if (!request.signal.aborted) {
            try { await this.rpc.respond(n.id, result, rpcError) }
            catch (error) { if (!request.signal.aborted) throw error }
          }
          requests.delete(id)
          continue
        }
        if (n.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
          const id = String(p.itemId ?? 'assistant')
          const item = { ...items.get(id), id, type: 'agentMessage', text: (items.get(id)?.text ?? '') + p.delta, status: 'inProgress' }
          items.set(id, item); yield { state: 'streaming', item }; continue
        }
        if (n.method === 'item/plan/delta' && typeof p.delta === 'string') {
          const id = String(p.itemId ?? 'plan')
          const previous = items.get(id)
          const item = { ...previous, id, type: 'plan', text: previous?.text ?? 'Making a plan', details: appendBounded(previous?.details ?? '', p.delta, MAX_ITEM_DETAILS, STREAM_DETAIL_TRUNCATION), status: 'inProgress' }
          items.set(id, item); yield { state: 'streaming', item }; continue
        }
        if (n.method === 'item/reasoning/summaryPartAdded') {
          // The protocol event carries a section boundary, not text. Preserve
          // that boundary so adjacent public summary deltas do not run together.
          const id = String(p.itemId ?? 'reasoning')
          const previous = items.get(id)
          const details = previous?.details ? appendBounded(previous.details, '\n\n', MAX_ITEM_DETAILS, STREAM_DETAIL_TRUNCATION) : previous?.details
          const item = { ...previous, id, type: 'reasoning', text: previous?.text ?? 'Thinking', ...(details ? { details } : {}), status: 'inProgress' }
          items.set(id, item); yield { state: 'streaming', item }; continue
        }
        if (n.method === 'item/reasoning/summaryTextDelta' && typeof p.delta === 'string') {
          const id = String(p.itemId ?? 'reasoning')
          const previous = items.get(id)
          const item = { ...previous, id, type: 'reasoning', text: previous?.text ?? 'Thinking', details: appendBounded(previous?.details ?? '', p.delta, MAX_ITEM_DETAILS, STREAM_DETAIL_TRUNCATION), status: 'inProgress' }
          items.set(id, item); yield { state: 'streaming', item }; continue
        }
        if (n.method === 'item/commandExecution/outputDelta' && typeof p.delta === 'string') {
          const id = String(p.itemId), previous = items.get(id)
          if (previous?.type !== 'commandExecution') continue
          const item = { ...previous, output: appendBounded(previous.output ?? '', p.delta, MAX_STREAM_OUTPUT, STREAM_OUTPUT_TRUNCATION) }
          items.set(id, item); yield { state: 'streaming', item }; continue
        }
        if (n.method === 'item/started' || n.method === 'item/completed') {
          const raw = record(p.item)
          if (!raw || typeof raw.id !== 'string') continue
          const item = conversationItem(raw, n.method === 'item/completed' ? 'completed' : 'inProgress')
          if (!item) continue
          const previous = items.get(item.id)
          const phase = previous?.phase
          if (item.type === 'agentMessage' && !item.phase && phase) item.phase = phase
          // Some app-server completion receipts omit fields that arrived on
          // the live delta channel. Keep those public fields until the
          // provider supplies an authoritative replacement; otherwise a
          // completion event can erase the text or output the user already
          // saw.
          if (item.type === 'agentMessage' && typeof raw.text !== 'string' && previous?.text) item.text = previous.text
          if (item.type === 'commandExecution' && typeof raw.aggregatedOutput !== 'string' && previous?.output !== undefined) item.output = previous.output
          if (previous?.details && !item.details) item.details = previous.details
          items.set(item.id, item); yield { state: 'streaming', item }; continue
        }
        if (n.method === 'turn/completed') {
          const completed = record(p.turn)
          if (completed?.status === 'failed') throw new Error(String(record(completed.error)?.message ?? turnError ?? 'Codex turn failed'))
          if (completed?.status !== 'completed' && completed?.status !== 'interrupted') throw new Error('Codex returned an invalid terminal turn status')
          yield { state: completed?.status === 'interrupted' ? 'stopped' : 'completed', threadId, turnId: turn.id }
          return
        }
      }
    } finally {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (terminalErrorTimer) clearTimeout(terminalErrorTimer)
      dismissRequests(); unsubscribe?.(); this.active.delete(runId)
    }
  }

  async steer(runId: string, instruction: string): Promise<void> {
    const current = this.active.get(runId)
    if (!instruction.trim()) throw new Error('A follow-up message cannot be empty')
    if (!current?.threadId || !current.turnId || current.completedTurnId === current.turnId || current.abort.signal.aborted) throw new Error('This turn has ended. Send your draft as a new message.')
    await this.rpc.request('turn/steer', { threadId: current.threadId, expectedTurnId: current.turnId, input: [{ type: 'text', text: instruction, text_elements: [] }] })
  }

  async stop(runId: string): Promise<void> {
    const current = this.active.get(runId)
    if (!current) return
    current.abort.abort(new Error('Stopped by the user'))
    current.queue.push({ method: 'galta/stopped', params: { threadId: current.threadId } })
    await this.interrupt(current)
  }
  private async interrupt(current: Active): Promise<void> {
    if (current.interruption) return current.interruption
    if (!current.turnId || current.completedTurnId === current.turnId) return
    current.interruption = this.rpc.request('turn/interrupt', { threadId: current.threadId, turnId: current.turnId }).then(() => {}, error => { if (current.completedTurnId !== current.turnId) throw error })
    return current.interruption
  }
}
