import { asCommitId, asProjectId } from '@galta/domain'
import { BROWSER_TOOL_NAMES } from '@galta/canvas'
import { CodexAgentRuntime } from '@galta/runtime'
import type { CreativeConversationTurn, CreativeSession, WorkspaceBundle } from '@galta/storage'
import { CanvasAgentConnection, type CanvasExecution } from '../canvas/agentConnection'
import { CanvasTool } from '../canvas/canvasTool'
import { ExtensionCodexRpc } from '../canvas/codexRpc'
import { bindSessionThread, mergeSession, normalizeSessionBinding, sessionLabel } from '../canvas/conversationMetadata'
import { documentEquals } from '../canvas/documentEquality'
import { validateSnapshot } from '../canvas/scene'
import { SourceBrowser } from '../canvas/sourceBrowser'
import { TaskScene } from '../canvas/toolScene'
import { canvasChanges } from '../canvas/canvasChanges'
import { latestObservedTurn, prepareCanvasMessage, reusablePreview } from '../canvas/canvasMessage'
import { isWorkspaceDeliveryLink, markdownDeliveryLinks } from './artifactDelivery'
import { commitWorkspaceSnapshot, makeId, workspaceRepository } from '../canvas/workspace'
import { WorkspaceSync } from '../canvas/workspaceSync'
import { isTaskRunning, type TaskSubmission } from './protocol'
import type { TaskControl } from './registry'

export async function executeTask(input: TaskSubmission, control: TaskControl, ready: Promise<unknown> = Promise.resolve()) {
  const projectId = asProjectId(input.projectId), { update } = control
  const lost = new AbortController(), signal = AbortSignal.any([control.signal, lost.signal])
  const sync = new WorkspaceSync(projectId), runtime = new CodexAgentRuntime(new ExtensionCodexRpc())
  const browser = new SourceBrowser()
  const conversation: CreativeConversationTurn = { id: input.id, instruction: input.instruction, status: 'preparing', startedAt: Date.now(), items: [],
    context: { canvasTitle: '', selection: [...input.submitted.selection], ...(input.page ? { page: { title: input.page.title, url: input.page.url } } : {}) } }
  // Items are replaced by the runtime, never mutated. Copy the small index;
  // keep potentially large text/output shared until transport serialization.
  const snapshot = (): CreativeConversationTurn => ({ ...conversation, items: [...conversation.items], ...(conversation.steering ? { steering: [...conversation.steering] } : {}) })
  let session: CreativeSession | undefined, scene: TaskScene | undefined, lease: CanvasExecution | undefined, tool: CanvasTool | undefined
  let head = input.commitId, runId: string | undefined, finishing = false, interrupted: Promise<void> | undefined, interruptError: unknown
  let savedAt = 0
  let steering = Promise.resolve()
  const persist = async (change: (current: WorkspaceBundle) => WorkspaceBundle) => {
    const saved = await workspaceRepository.update(projectId, current => {
      if (!current || current.project.archivedAt) throw new Error('This canvas is no longer available.')
      return change(current)
    })
    sync.publish(saved)
    return saved
  }
  const saveSession = async (cwd?: string) => {
    const captured = structuredClone(session!)
    const next = await persist(current => {
      const sessions = current.agentSessions ?? [], existing = sessions.find(item => item.id === captured.id)
      const merged = mergeSession(existing, captured)
      return { ...current, ...(cwd ? { codexProject: { ...current.codexProject, cwd } } : {}),
        agentSessions: existing ? sessions.map(item => item.id === captured.id ? merged : item) : [...sessions, merged] }
    })
    savedAt = Date.now()
    return next
  }
  const stop = () => {
    browser.close('The task was stopped')
    if (!runId) connection.close('Task preparation ended')
    if (runId && !interrupted) interrupted = runtime.stop(runId).catch(error => { interruptError = error })
  }
  signal.addEventListener('abort', stop, { once: true })
  const connection = new CanvasAgentConnection({
    async begin(execution, beginSignal) {
      signal.throwIfAborted(); beginSignal.throwIfAborted()
      if (execution.mode !== 'embedded' || lease) throw new Error('This endpoint belongs to an embedded task.')
      lease = execution
    },
    async call(name, args, callSignal) {
      const combined = AbortSignal.any([signal, callSignal])
      combined.throwIfAborted()
      if (BROWSER_TOOL_NAMES.includes(name)) return browser.execute(name, args, combined)
      if (!tool || !scene || !lease) throw new Error('The task canvas is not ready for another operation.')
      // The native registry owns tool exclusion. Revision and persistence
      // checks still protect against user edits while observations overlap.
      const current = await workspaceRepository.load(projectId)
      if (!current || current.project.archivedAt) throw new Error('This canvas is no longer available.')
      if (head !== current.project.headCommitId) {
        head = current.project.headCommitId
        scene.restore(validateSnapshot(current.snapshots[head]))
      }
      return await tool.execute(name, args, { executionId: lease.id, cwd: lease.cwd, signal: combined,
        provenance: { providerId: 'codex-app-server', sessionId: session!.id, ...(conversation.turnId ? { turnId: conversation.turnId } : {}) } })
    },
    async end() { if (!finishing) lost.abort(new Error('The task canvas connection ended.')) },
    disconnected(message) { if (!finishing) { update({ error: message }); lost.abort(new Error(message)) } }
  })
  const run = async () => {
    try {
      const current = await workspaceRepository.load(projectId)
      if (!current || current.project.archivedAt) throw new Error('This canvas is no longer available.')
      // Apply the same session invariant before choosing fork/resume, so a
      // consumed fork persisted by an older version cannot create another thread.
      session = normalizeSessionBinding(structuredClone(current.agentSessions?.find(item => item.id === input.runtime.sessionId) ?? { id: input.runtime.sessionId, label: input.runtime.sessionLabel, turns: [] }))
      const previous = session.turns[latestObservedTurn(session.turns)]
      const submitted = { ...input.submitted, changes: canvasChanges(current, input.commitId, previous?.context?.canvas?.commitId ?? null) }
      session.turns.push(conversation)
      conversation.context!.canvasTitle = current.project.title
      await saveSession()
      await ready
      signal.throwIfAborted()
      if (current.project.headCommitId !== input.commitId) throw new Error('The canvas changed before this task started. Review the latest canvas and submit again.')
      const viewport = input.submitted.viewport
      if (!viewport) throw new Error('The submitted canvas has no viewport.')
      // The pending turn has no provider turn ID yet, so it cannot be its own baseline.
      const unchangedPreview = reusablePreview(session, input.commitId, viewport)
      const taskScene = new TaskScene(validateSnapshot(current.snapshots[head]), [...input.submitted.selection], { ...viewport, center: { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 } })
      // The reader keeps looking while the task runs: work lands where they are.
      control.watchView(view => taskScene.view(view))
      scene = taskScene
      await connection.open(projectId, current.project.title)
      signal.throwIfAborted()
      const acquired = await connection.acquire()
      if (!lease || lease.id !== acquired.id || !acquired.bridgeId) throw new Error('The task canvas bridge is unavailable. Reconnect Galta.')
      lease = acquired
      signal.throwIfAborted()
      const browserContext = await browser.open(input.page?.tabId ?? null, `${lease.bridgeId}/${lease.id}`, input.page?.url)
      if (input.page && !browserContext.available) { conversation.context!.unavailablePage = browserContext.reason; delete conversation.context!.page }
      const saved = await saveSession(lease.cwd)
      session.label = sessionLabel(saved, session.id)
      const context = { ...input.runtime, sessionId: session.id, sessionLabel: session.label, providerId: 'codex-app-server' }
      update({ runtime: context, conversation: snapshot() })
      tool = new CanvasTool(scene, connection.artifacts(), async mutation => {
        const expected = head
        const next = await persist(current => {
          mutation.assertCurrent()
          if (current.project.headCommitId !== expected || !documentEquals(validateSnapshot(current.snapshots[expected]).document, mutation.before.document)) throw new Error('The canvas changed while saving. Read the canvas again before writing.')
          const next = commitWorkspaceSnapshot(current, asCommitId(expected), mutation.snapshot, 'agent', context)
          return current.canvasView?.commitId === expected ? { ...next, canvasView: { ...current.canvasView, commitId: next.project.headCommitId } } : next
        })
        try { mutation.apply(); head = next.project.headCommitId }
        catch (error) {
          // The commit is already durable even if Stop won before the local
          // projection advanced. A later read must reload that committed head.
          throw new Error(`${error instanceof Error ? error.message : String(error)} The canvas change was already saved in history (${next.project.headCommitId}).`)
        }
      }, submitted, slots => update({ slots }))
      const canvas = await prepareCanvasMessage(tool, submitted, input.commitId, { executionId: `${lease.bridgeId}/${lease.id}`, cwd: lease.cwd, signal }, unchangedPreview)
      const preview = canvas.context.preview, previewEvidenceId = preview.status === 'attached' || preview.status === 'unchanged' ? preview.evidenceId : undefined
      conversation.context!.canvas = { commitId: input.commitId, revision: canvas.context.revision, preview: preview.status, viewport: canvas.context.viewport, ...(previewEvidenceId ? { previewEvidenceId } : {}) }
      signal.throwIfAborted()
      const handle = await runtime.start({ projectId, branchId: current.project.activeBranchId,
        canvas,
        browser: browserContext, execution: { id: `${lease.bridgeId}/${lease.id}`, cwd: lease.cwd },
        instruction: input.instruction, runtime: context,
        ...(session.threadId ? { threadId: session.threadId } : session.forkFrom ? { fork: session.forkFrom } : {})
      }, { request: control.request })
      runId = handle.runId
      const steer = (message: { id: string; instruction: string }) => {
        const sent = steering.then(async () => {
          signal.throwIfAborted()
          await runtime.steer(handle.runId, message.instruction)
          // Anchor the accepted message to the last observed item. Timestamps
          // alone cannot reconstruct its position in a restored provider turn.
          const afterItemId = conversation.items.at(-1)?.id
          conversation.steering = [...(conversation.steering ?? []), { id: message.id, text: message.instruction, createdAt: Date.now(), ...(afterItemId ? { afterItemId } : {}) }]
          await saveSession()
          update({ conversation: snapshot() })
        })
        steering = sent.catch(() => undefined)
        return sent
      }
      // The runtime only knows the thread and turn after it has reached the
      // provider's turn boundary. Advertise steering at that boundary so the
      // composer never offers a follow-up that can race turn/start.
      let steerReady = false
      for await (const event of handle.updates) {
        if (!steerReady && event.threadId && event.turnId) {
          steerReady = true
          control.setSteer(steer)
        }
        conversation.status = event.state
        let checkpoint = false
        if (event.threadId) {
          conversation.threadId = event.threadId
          if (session.threadId !== event.threadId) { session = bindSessionThread(session, event.threadId); checkpoint = true }
        }
        if (event.turnId && conversation.turnId !== event.turnId) { conversation.turnId = event.turnId; checkpoint = true }
        if (event.item) {
          const index = conversation.items.findIndex(item => item.id === event.item!.id)
          if (index < 0) conversation.items.push(event.item)
          else conversation.items[index] = event.item
        }
        update({ conversation: snapshot(), ...(event.context ? { pressure: event.context } : {}) })
        if (checkpoint || Date.now() - savedAt >= 1000) await saveSession()
      }
      if (signal.aborted) stop()
      if (conversation.status === 'completed' && conversation.threadId && conversation.turnId) {
        const finalReplies = conversation.items.filter(item => item.type === 'agentMessage' && item.phase === 'final_answer' && item.status === 'completed')
        const explicitDeliveries = conversation.items
          .filter(item => item.type === 'mcpToolCall' && item.tool === 'canvas_deliver' && item.status === 'completed' && item.delivery)
          .map(item => item.delivery!)
        for (const [index, reply] of finalReplies.entries()) {
          const proseLinks = markdownDeliveryLinks(reply.text).filter(isWorkspaceDeliveryLink)
          // canvas_deliver is the authoritative user-delivery declaration. It
          // is bound to this execution by the host, so it remains actionable
          // when the model's final prose omits or mistypes the long path. Its
          // immutable source and hash are passed through to finalization.
          const declared = index === finalReplies.length - 1 ? explicitDeliveries : []
          const hrefs = declared.length ? [...new Set(declared.map(delivery => delivery.path))] : proseLinks
          if (!hrefs.length) continue
          try {
            reply.artifacts = await connection.finalizeArtifacts(hrefs, { threadId: conversation.threadId, turnId: conversation.turnId, messageId: reply.id }, declared.length ? declared : undefined)
          } catch (error) {
            reply.artifacts = hrefs.map(href => ({ href, status: 'failed' as const, error: error instanceof Error ? error.message : String(error) }))
          }
        }
        if (finalReplies.some(reply => reply.artifacts?.length)) {
          await saveSession()
          update({ conversation: snapshot() })
        }
      }
      await interrupted
      if (interruptError) throw interruptError
      if (lost.signal.aborted) throw lost.signal.reason
      if (conversation.turnId && conversation.threadId) {
        session.lastTurnId = conversation.turnId
        const checkpoint = { providerId: 'codex-app-server' as const, sessionId: session.id, threadId: conversation.threadId, turnId: conversation.turnId }
        await persist(current => ({ ...current, agentCheckpoints: { ...current.agentCheckpoints, [head]: checkpoint } }))
      }
    } catch (error) {
      // A runtime failure also retires the native turn, even if no view exists.
      stop(); await interrupted
      conversation.status = control.signal.aborted && !interruptError ? 'stopped' : 'failed'
      const reason = interruptError ?? error
      const message = reason instanceof Error ? reason.message : String(reason)
      if (conversation.status === 'failed') conversation.items.push({ id: makeId('error'), type: 'error', text: message })
      update({ error: conversation.status === 'failed' ? message : '' })
    } finally {
      finishing = true
      control.setSteer(null)
      await steering
      if (isTaskRunning(conversation.status)) conversation.status = 'failed'
      conversation.completedAt = Date.now()
      session ??= { id: input.runtime.sessionId, label: input.runtime.sessionLabel, turns: [conversation] }
      try { await saveSession() }
      finally {
        update({ conversation: snapshot() })
        browser.close(); scene?.close()
        try { await connection.release() }
        finally { connection.close(); sync.close(); signal.removeEventListener('abort', stop) }
      }
    }
  }
  // The same lifecycle fence as external agents prevents archiving while a
  // task is preparing, running, awaiting approval, or saving its final state.
  await navigator.locks.request(`galta-execution:${projectId}`, { mode: 'shared' }, run)
}

/** A new host never silently replays work interrupted by browser/host shutdown. */
export async function recoverInterruptedTasks(projectId: string) {
  // A provider can report a terminal status before Galta finishes receipts,
  // deliveries and persistence. Only completedAt establishes durable settlement.
  const unfinished = (turn: CreativeConversationTurn) => isTaskRunning(turn.status) || (typeof turn.startedAt === 'number' && !turn.completedAt)
  const saved = await workspaceRepository.update(asProjectId(projectId), current => {
    if (!current) throw new Error('This canvas is no longer available.')
    if (!current.agentSessions?.some(session => session.turns.some(unfinished))) return current
    return { ...current, agentSessions: current.agentSessions.map(session => ({ ...session, turns: session.turns.map(turn => unfinished(turn) ? { ...turn, status: 'failed' as const, completedAt: Date.now(), items: [...turn.items, { id: makeId('error'), type: 'error', text: 'The background task host closed before this task finished. Saved changes are preserved.' }] } : turn) })) }
  }, true)
  new WorkspaceSync(projectId).publish(saved)
}
