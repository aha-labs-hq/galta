import { CanvasWork } from './canvasWork'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ExcalidrawCanvas } from './ExcalidrawCanvas'
import { validateSnapshot, type CanvasScene } from './scene'
import { DrawingTools } from './DrawingTools'
import { RuntimeMenu, SessionMenu } from './RuntimeMenu'
import { SettingsDialog } from '../setup/SettingsDialog'
import type { SettingsView } from '../setup/settings'
import { useAccount } from '../setup/account'
import { SettingsCorner } from './SettingsCorner'
import { AgentInvitation } from './AgentInvitation'
import { WorkspaceMenu } from './WorkspaceMenu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import '../styles.css'
import { asCommitId, type ArtifactRead, type RuntimeContext } from '@galta/domain'
import { normalizeCapture, type CaptureRecord } from '@galta/capture'
import { CodexAgentRuntime, type AgentRunState, type ContextPressure } from '@galta/runtime'
import { type WorkspaceBundle, type CreativeSession } from '@galta/storage'
import { portableMedia } from './portableMedia'
import { commitWorkspaceSnapshot, stageAgentSnapshot, activateCanvasSnapshot, restoreVersion, nameVersion, initializeWorkspaceSnapshot, defaultRuntime, makeId, workspaceRepository } from './workspace'
import { ImportFeedback, useMediaImports } from './useMediaImports'
import { SelectionActions } from './SelectionActions'
import { htmlDocument } from './htmlEmbed'
import { CanvasFocus } from './CanvasFocus'
import { CanvasViewControls } from './CanvasViewControls'
import { CanvasChromeSurface } from './CanvasChrome'
import { receivePresentation, type CanvasView } from './canvasViewNavigation'
import { useCanvasViewport } from './useCanvasViewport'
import { ComposerContext } from './ComposerContext'
import { canvasFrame, useCanvasInsets, visibleCanvasFrame } from './useCanvasInsets'
import { CanvasLocator } from './agentFocus'
import { AgentMark } from './AgentMark'
import { CanvasSlots } from './CanvasSlots'
import { videoFile, type CanvasSlot } from '@galta/canvas'
import { readImageDrop, type ImageReference } from './referenceDrop'
import { HistoryBrowser } from './HistoryBrowser'
import { CollectionPanel } from './CollectionPanel'
import { missingObjects, takeBack } from './historyRecovery'
import { refreshRelationships } from './relationships'
import { cloneCanvasElement } from './cloneSnapshot'
import { trimHistory } from './historyTrim'
import type { StageCamera } from './HistoryStage'
import type { AppState } from '@excalidraw/excalidraw/types'
import { captureSubmittedContext, type SubmittedContext } from './context'
import { useMessageDrafts } from './messageDrafts'
import { CanvasTool, type PendingCanvasMutation } from './canvasTool'
import { CanvasAgentConnection, type CanvasConnectionHost, type CanvasExecution } from './agentConnection'
import { ConversationDock, type PendingQuestion } from './ConversationDock'
import { checkpointAt, reconcileCodexSession } from './conversationState'
import { ConversationStore } from './conversationStore'
import { WorkspaceSync, type WorkspaceRevision } from './workspaceSync'
import { BROWSER_TOOL_NAMES } from '@galta/canvas'
import { SourceBrowser, sourceTab } from './sourceBrowser'
import { useSourcePage } from './useSourcePage'
import { mergeSession, renameSession, sessionLabel } from './conversationMetadata'
import { useConversationMetadata } from './useConversationMetadata'
import { TaskClient } from '../tasks/client'
import { isTaskRunning, isTaskStateNewer, type TaskState, type TaskStatus } from '../tasks/protocol'
import './canvas.css'

import { CanvasWorkspace } from './CanvasWorkspace'
import type { CanvasSessionProps } from './canvasNavigation'
import { announceCatalog } from './canvasLibrary'
import { canvasPreviews, previewIdentity } from './canvasPreviews'
type CanvasExecutionState = { lease: CanvasExecution; abort: AbortController; tool?: CanvasTool; browser?: SourceBrowser; provenance?: { providerId: string; sessionId: string; turnId?: string } }

export function CanvasApp() { return <CanvasWorkspace Session={CanvasSession} /> }

function CanvasSession({ projectId, initial, navigation, sessionRef, codexConnection, codexRpc }: CanvasSessionProps) {
  const shellRef = useRef<HTMLElement | null>(null)
  const codexRuntime = useMemo(() => new CodexAgentRuntime(codexRpc), [codexRpc])
  const workspaceSync = useMemo(() => new WorkspaceSync(projectId), [])
  const editorRef = useRef<CanvasScene | null>(null)
  const workspaceRef = useRef<WorkspaceBundle | null>(initial)
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve())
  const cursorRef = useRef<{ id: string | null; cameraCommitId?: string | null }>({ id: initial.project.headCommitId })
  const flushTimerRef = useRef<number | null>(null)
  const pendingDocumentRef = useRef(false)
  const activeRunRef = useRef<{ runId: string; stop: () => Promise<void> } | null>(null)
  const taskClientRef = useRef<TaskClient | null>(null)
  const hostedTaskRef = useRef<TaskState | null>(null)
  const taskStatesRef = useRef(new Map<string, TaskState>())
  const taskStopsRef = useRef(new Map<string, () => Promise<void>>())
  const [taskStates, setTaskStates] = useState<Map<string, TaskState>>(() => new Map())
  const [taskReady, setTaskReady] = useState(!globalThis.chrome?.runtime?.id)
  const canvasConnectionRef = useRef<{ connection: CanvasAgentConnection; ready: Promise<void>; register(): void } | null>(null)
  /** Why this canvas is not registered with the canvas bridge; null while registered or registering. */
  const [canvasLinkProblem, setCanvasLinkProblem] = useState<string | null>(null)
  const executionRef = useRef<CanvasExecutionState | null>(null)
  const historyOpenRef = useRef(false)
  const [presenting, setPresenting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [canvasNotice, setCanvasNotice] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceBundle | null>(initial)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [hasMigrationBackup, setHasMigrationBackup] = useState(false)
  const [runtimeContext, setRuntimeContext] = useState<RuntimeContext>(initial.runtimeDefaults ?? defaultRuntime)
  const { drafts, read: readDraft, command, ready: draftReady, copyTo: copyDraftTo, flush: flushDraft, reload: reloadDraft } = useMessageDrafts(workspace?.project.id, runtimeContext.sessionId, setImportError)
  const source = useSourcePage()
  const [submitted, setSubmitted] = useState<SubmittedContext | null>(null)
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState<'Conversation' | 'Model' | null>(null)
  const [settingsView, setSettingsView] = useState<SettingsView>(null)
  // Closing Settings returns focus to where it was opened: the corner, or the composer.
  const settingsFromCorner = useRef(false)
  const account = useAccount()
  const connection = useSyncExternalStore(codexConnection.subscribe, codexConnection.getSnapshot)
  const codexStatus = connection.status, codexError = connection.error
  const connectedCodex = connection.status === 'connected' ? connection.data : null
  const codexPlan = connectedCodex?.account?.planType ?? ''
  const codexUsage = connectedCodex?.rateLimits?.primary?.usedPercent ?? null
  const codexModels = connectedCodex?.models ?? []
  const connectCodex = codexConnection.connect, signInCodex = codexConnection.signIn
  const [agentState, setAgentState] = useState<AgentRunState>('idle')
  const [agentMessage, setAgentMessage] = useState('')
  const [externalAgent, setExternalAgent] = useState<string | null>(null)
  const [externalSlots, setExternalSlots] = useState<readonly CanvasSlot[]>([])
  const [contextPressure, setContextPressure] = useState<ContextPressure | null>(null)
  const [conversation] = useState(() => new ConversationStore())
  const setLiveTurn = conversation.set
  const liveContext = useSyncExternalStore(conversation.subscribe, conversation.getContext)
  const [conversationOpen, setConversationOpen] = useState(false)
  const [composerFocusRequest, setComposerFocusRequest] = useState(0)
  const [question, setQuestion] = useState<PendingQuestion | null>(null)
  const [historyCursor, setHistoryCursor] = useState<string | null>(initial.project.headCommitId)
  const [shapeCount, setShapeCount] = useState(0)
  const [scene, setScene] = useState<CanvasScene | null>(null)
  // Where the agent worked, for this view's camera. It flies only on request.
  const canvasRef = useRef<HTMLElement>(null)
  const [locator, setLocator] = useState<CanvasLocator | null>(null)
  useEffect(() => {
    const surface = canvasRef.current, shell = shellRef.current
    if (!scene || !surface || !shell) return
    const created = new CanvasLocator(scene, () => canvasFrame(shell), surface)
    const unseen = scene.seenThrough(() => visibleCanvasFrame(shell))
    setLocator(created)
    return () => { created.close(); unseen(); setLocator(null) }
  }, [scene])
  // Built-in tasks run in the background page, where there is no reader. While
  // any runs on this canvas, this view reports what its reader can see, so work
  // without a place of its own lands there, as it does for an agent working in
  // the open canvas. The view changes with the camera, the window and the
  // reading sheet, which rises as a request is sent and grows with the reply.
  const runningTasks = [...taskStates.values()].filter(task => task.active).map(task => task.id).join(' ')
  useEffect(() => {
    const shell = shellRef.current, client = taskClientRef.current
    if (!scene || !shell || !client || !runningTasks) return
    let frame = 0, reported = ''
    const report = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (scene.disposed) return
        const { x, y, width, height, zoom } = scene.viewport, viewport = { x, y, width, height, zoom }, key = JSON.stringify(viewport)
        if (key === reported) return
        reported = key
        for (const taskId of runningTasks.split(' ')) void client.command({ method: 'view', projectId, taskId, viewport })
          .catch(error => console.warn('The canvas view did not reach its task', { projectId, taskId, error: String(error) }))
      })
    }
    const stopScroll = scene.api.onScrollChange(report), observer = new ResizeObserver(report)
    for (const element of [shell, shell.querySelector('.conversation-dock')]) if (element) observer.observe(element)
    report()
    return () => { cancelAnimationFrame(frame); stopScroll(); observer.disconnect() }
  }, [scene, runningTasks, projectId])
  const [externalWorkspace, setExternalWorkspace] = useState<WorkspaceBundle | null>(null)
  useEffect(() => {
    if (!canvasNotice) return
    const timer = window.setTimeout(() => setCanvasNotice(null), 4_500)
    return () => window.clearTimeout(timer)
  }, [canvasNotice])
  const hasHostedTask = () => [...taskStatesRef.current.values()].some(task => task.active)
  const hasAnyRun = () => Boolean(activeRunRef.current) || hasHostedTask()
  useCanvasInsets(shellRef, workspace !== null && scene !== null)

  const receiveTaskRef = useRef<(state: TaskState | null) => void>(() => {})
  const applyTaskResponse = useCallback((response: TaskStatus) => {
    if (Array.isArray(response)) response.forEach(state => receiveTaskRef.current(state))
    else receiveTaskRef.current((response ?? null) as TaskState | null)
  }, [])
  const taskHostClosed = useCallback(() => {
    const previous = hostedTaskRef.current
    // A confirmed host loss retires every active projection, including
    // conversations other than the selected one. Durable recovery stays in
    // the replacement host; this view never writes or replays those tasks.
    let changed = false
    for (const task of taskStatesRef.current.values()) if (task.active) {
      taskStatesRef.current.set(task.id, { ...task, active: false, canSteer: false, error: 'The background task host closed. Saved changes are preserved.', conversation: { ...task.conversation, status: 'failed', completedAt: Date.now() } })
      taskStopsRef.current.delete(task.id); changed = true
    }
    if (changed) setTaskStates(new Map(taskStatesRef.current))
    if (previous?.active) {
      const failed = taskStatesRef.current.get(previous.id)!
      hostedTaskRef.current = null
      if (activeRunRef.current?.runId === previous.id) activeRunRef.current = null
      setSubmitted(null); setQuestion(null); setAgentState('failed'); setLiveTurn(failed.conversation); setAgentMessage(failed.error)
    }
  }, [setLiveTurn])
  receiveTaskRef.current = state => {
    if (!state) return
    const previousState = taskStatesRef.current.get(state.id)
    // BroadcastChannel delivery and command responses can cross. A lower
    // sequence is an older snapshot and must never roll the background task
    // map, stop handle, or selected conversation back in time.
    if (!isTaskStateNewer(previousState, state)) return
    taskStatesRef.current.set(state.id, state)
    setTaskStates(new Map(taskStatesRef.current))
    // Keep a stop handle for every live task, including tasks belonging to a
    // conversation that is currently in the background. Selecting that
    // conversation later must restore its controls without waiting for another
    // task event.
    if (state.active) {
      taskStopsRef.current.set(state.id, taskStopsRef.current.get(state.id) ?? (async () => {
        const next = await taskClientRef.current!.command({ method: 'stop', projectId, taskId: state.id })
        applyTaskResponse(next)
      }))
    } else taskStopsRef.current.delete(state.id)
    // A task can continue while another conversation is selected. Its state is
    // retained in the map, but only the selected session projects into the dock.
    if (state.runtime.sessionId !== runtimeContext.sessionId) return
    const previous = hostedTaskRef.current
    hostedTaskRef.current = state
    if (state.active) {
      activeRunRef.current = { runId: state.id, stop: taskStopsRef.current.get(state.id)! }
      setRuntimeContext(current => Object.keys(state.runtime).every(key => current[key as keyof RuntimeContext] === state.runtime[key as keyof RuntimeContext]) ? current : state.runtime)
    } else {
      if (activeRunRef.current?.runId === state.id) activeRunRef.current = null
      taskStopsRef.current.delete(state.id)
      setSubmitted(null)
    }
    setAgentState(state.active && !isTaskRunning(state.conversation.status) ? 'streaming' : state.conversation.status as AgentRunState)
    setLiveTurn(state.conversation)
    setContextPressure(current => current?.tokens === state.pressure?.tokens && current?.window === state.pressure?.window ? current : state.pressure)
    setAgentMessage(state.error)
    const question = state.question
    if (question?.id !== previous?.question?.id) setQuestion(question ? { ...question, answer: value => {
      void taskClientRef.current!.command({ method: 'answer', projectId, taskId: state.id, questionId: question.id, value })
        .then(next => applyTaskResponse(next)).catch(error => setAgentMessage(String(error)))
    } } : null)
    if (question && previous?.question?.id !== question.id) setConversationOpen(true)
  }
  useEffect(() => {
    if (!globalThis.chrome?.runtime?.id) return
    let active = true
    const wake = () => {
      if (document.visibilityState === 'visible') void client.refresh().then(() => { if (active) setTaskReady(true) }).catch(error => { if (active) { setTaskReady(false); setAgentMessage(String(error)) } })
    }
    const client = new TaskClient(projectId, state => { if (active) receiveTaskRef.current(state) }, () => {
      if (!active) return
      taskHostClosed(); setTaskReady(false); wake()
    })
    taskClientRef.current = client
    void client.open().then(() => { if (active) setTaskReady(true) }).catch(error => { if (active) setAgentMessage(String(error)) })
    document.addEventListener('visibilitychange', wake); document.addEventListener('resume', wake)
    return () => {
      active = false; client.close()
      if (taskClientRef.current === client) taskClientRef.current = null
      document.removeEventListener('visibilitychange', wake); document.removeEventListener('resume', wake)
    }
  }, [projectId, taskHostClosed])

  useEffect(() => {
    if (codexStatus !== 'connected') setRuntimeMenuOpen(null)
  }, [codexStatus])

  useEffect(() => {
    const result = connectedCodex
    if (!result || hasAnyRun()) return
    const defaultModel = result.models?.find((model) => model.isDefault)?.id ?? result.models?.[0]?.id
    if (defaultModel) setRuntimeContext((current) => ({ ...current, providerId: 'codex-app-server', modelId: result.models?.some((model) => model.id === current.modelId) ? current.modelId : defaultModel }))
  }, [connectedCodex, agentState])

  const openRuntimeMenu = useCallback((open: boolean) => {
    setRuntimeMenuOpen(open ? 'Model' : null)
    if (open) void codexConnection.refresh()
  }, [codexConnection])

  const leavingRef = useRef(false)
  const unsavedSessionsRef = useRef(new Map<string, CreativeSession>())
  const releaseExecutionRef = useRef<{ id: string; release(): void } | null>(null)
  useEffect(() => () => { releaseExecutionRef.current?.release(); releaseExecutionRef.current = null }, [])
  useEffect(() => {
    let active = true
    void workspaceRepository.hasMigrationBackup(projectId).then(value => { if (active) setHasMigrationBackup(value) }).catch(error => setImportError(String(error)))
    return () => { active = false }
  }, [projectId])
  useEffect(() => {
    if (initial.project.title !== workspaceRef.current?.project.title) {
      const { titleSource: _, ...project } = workspaceRef.current!.project
      const next = { ...workspaceRef.current!, project: { ...project, title: initial.project.title, ...(initial.project.titleSource ? { titleSource: initial.project.titleSource } : {}) } }
      workspaceRef.current = next; setWorkspace(next)
    }
  }, [initial.project.title])

  const persist = useCallback((change: (current: WorkspaceBundle) => WorkspaceBundle, saved?: (next: WorkspaceBundle) => void) => {
    const write = persistQueueRef.current.catch(() => undefined).then(async () => {
      const next = await workspaceRepository.update(projectId, current => {
        if (!current) throw new Error('The saved workspace is unavailable. Reopen Galta before editing.')
        return change(current)
      })
      workspaceRef.current = next
      setWorkspace(next)
      try { saved?.(next) }
      finally { workspaceSync.publish(next) }
      return next
    })
    persistQueueRef.current = write.then(() => undefined, () => undefined)
    return write
  }, [workspaceSync])

  useConversationMetadata(workspace, workspaceRef, persist, codexRpc, codexStatus === 'connected', agentState === 'preparing' || agentState === 'streaming', runtimeContext.modelId)

  const commitCanvasSnapshot = useCallback(async (source: 'user' | 'import', runtimeForCommit?: RuntimeContext, capture?: CaptureRecord | null, preserveCurrent = false): Promise<void> => {
    const current = workspaceRef.current
    const editor = editorRef.current
    if (!current || !editor || current.project.archivedAt) return
    if (flushTimerRef.current !== null) { window.clearTimeout(flushTimerRef.current); flushTimerRef.current = null }
    pendingDocumentRef.current = false
    // This position belongs to one history visit. Queued edits advance it;
    // navigating elsewhere creates a new position and cannot retarget them.
    const position = cursorRef.current
    const snapshot = editor.snapshot(), saveView = document.visibilityState !== 'hidden'
    let committedId: string | null = null
    await persist(current => {
      let next = commitWorkspaceSnapshot(current, asCommitId(position.id ?? current.project.headCommitId), snapshot, source, runtimeForCommit, preserveCurrent)
      if (next !== current) committedId = next.project.headCommitId
      if (capture && !next.captures.some(item => item.mediaUrl === capture.mediaUrl)) next = { ...next, captures: [...next.captures, capture] }
      const viewId = committedId ?? position.cameraCommitId ?? position.id ?? current.project.headCommitId
      // An unchanged stale view has no authority to replace the newer view's
      // camera or selected artwork. Explicit history continuation owns that.
      if (saveView && viewId === next.project.headCommitId) {
        const canvasView = { commitId: viewId, ...snapshot.view }
        if (JSON.stringify(next.canvasView) !== JSON.stringify(canvasView)) next = { ...next, canvasView }
      }
      return next
    }, () => {
      if (committedId) position.id = committedId
      if (cursorRef.current === position) setHistoryCursor(position.id)
    })
  }, [persist])

  const saveAgentMutation = useCallback(async (mutation: PendingCanvasMutation, runtime: RuntimeContext) => {
    const editor = editorRef.current, position = cursorRef.current
    if (!editor || !position.id) throw new Error('The canvas has been closed')
    let candidateId: string | undefined, baseId: string | undefined, durable = false, applied = false
    try {
      await persist(current => {
        mutation.assertCurrent()
        const staged = stageAgentSnapshot(current, asCommitId(position.id!), mutation.before, mutation.snapshot, runtime)
        candidateId = staged.candidateId; baseId = staged.baseId
        return { ...staged.workspace, canvasView: { commitId: baseId, ...mutation.before.view } }
      }, () => {
        durable = true
        // Staging also preserves any drawing that preceded the agent request.
        position.id = baseId!
        if (cursorRef.current === position) setHistoryCursor(position.id)
        mutation.apply()
        applied = true
        // Earlier queued artwork keeps its parent; camera-only saves follow
        // the successfully applied result in this same live viewport.
        position.cameraCommitId = candidateId!
        cursorRef.current = { id: candidateId! }
        setHistoryCursor(candidateId!)
      })
      // Application has happened. Only now select this already durable version
      // for reopening; destruction before application leaves the base selected.
      const view = editor.view
      await persist(current => activateCanvasSnapshot(current, asCommitId(candidateId!), view))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (durable && !applied) {
        if (editorRef.current === editor && !editor.disposed) {
          try { await commitCanvasSnapshot('user', undefined, undefined, true) }
          catch (saveError) { throw new Error(`The agent result is saved in history (${candidateId}) but was not applied. Later current edits could not be saved: ${saveError instanceof Error ? saveError.message : String(saveError)}`) }
        }
        throw new Error(`${reason} The agent result is saved in history (${candidateId}) and was not applied.`)
      }
      if (applied) throw new Error(`The agent result is on canvas and saved in history (${candidateId}), but selecting it for reopening failed: ${reason}`)
      throw error
    }
  }, [persist, commitCanvasSnapshot])

  const finishImport = useCallback(async (reference: ImageReference) => {
    const capture = reference.kind !== 'video' && !videoFile(reference.url.split('?')[0]!) && reference.url.startsWith('http') ? normalizeCapture({ kind: 'image', sourceUrl: reference.sourceUrl ?? reference.url, mediaUrl: reference.url, pageUrl: reference.sourceUrl ?? reference.url, userGestureId: makeId('drop') }) : null
    await commitCanvasSnapshot('import', runtimeContext, capture)
  }, [commitCanvasSnapshot, runtimeContext])
  const imports = useMediaImports(editorRef, finishImport)
  const cancelImports = imports.cancel

  // Archiving may race another view's debounce. Retain those already-made
  // edits as history, without selecting them or reopening the archived project.
  const retainLocalEditsOnArchive = useCallback(async () => {
    const editor = editorRef.current, local = workspaceRef.current, position = cursorRef.current
    if (!editor || !local || !position.id) return
    const snapshot = editor.snapshot()
    const saved = local.snapshots[position.id] as { document?: unknown } | undefined
    if (JSON.stringify(saved?.document) === JSON.stringify(snapshot.document)) return
    let retainedId = position.id
    const next = await workspaceRepository.update(projectId, current => {
      if (!current) throw new Error('The saved workspace is unavailable.')
      const retained = commitWorkspaceSnapshot(current, asCommitId(position.id!), snapshot, 'user', undefined, true)
      retainedId = retained.project.headCommitId
      return { ...retained, project: { ...retained.project, headCommitId: current.project.headCommitId, activeBranchId: current.project.activeBranchId } }
    }, true)
    position.id = retainedId
    workspaceRef.current = next; setWorkspace(next); setHistoryCursor(retainedId)
    workspaceSync.publish(next)
  }, [projectId, workspaceSync])

  const applyExternalWorkspace = useCallback((next: WorkspaceBundle) => {
    const editor = editorRef.current
    const snapshot = next.snapshots[next.project.headCommitId]
    if (!editor || !snapshot) { setImportError('The other Galta window saved an unreadable canvas. Your current work is preserved.'); return }
    try {
      if (hasAnyRun() && !hostedTaskRef.current) { setImportError('Stop the current task before loading changes from another Galta window.'); return }
      cancelImports()
      if (flushTimerRef.current !== null) { window.clearTimeout(flushTimerRef.current); flushTimerRef.current = null }
      pendingDocumentRef.current = false
      const hosted = hostedTaskRef.current !== null
      if (hosted) editor.applyPrepared(validateSnapshot(snapshot), true)
      else editor.restore(next.canvasView?.commitId === next.project.headCommitId ? { ...validateSnapshot(snapshot), view: next.canvasView } : snapshot)
      workspaceRef.current = next
      cursorRef.current = { id: next.project.headCommitId }
      setWorkspace(next)
      setHistoryCursor(next.project.headCommitId)
      setShapeCount(editor.elements.length)
      if (!hosted) {
        setRuntimeContext(next.runtimeDefaults ? { ...defaultRuntime, ...next.runtimeDefaults } : defaultRuntime)
        setLiveTurn(null); setAgentState('idle'); setAgentMessage('')
      }
      setExternalWorkspace(null)
    } catch (error) { setImportError(error instanceof Error ? error.message : 'Unable to load changes from another Galta window.') }
  }, [cancelImports])

  const loadExternalWorkspace = useCallback(async (external: WorkspaceBundle) => {
    if (hasAnyRun() && !hostedTaskRef.current) return
    try {
      cancelImports()
      const editor = editorRef.current!, version = editor.restorationVersion
      const localDocument = JSON.stringify(editor.snapshot().document)
      // First preserve any local edit as a branch of its original cursor.
      await commitCanvasSnapshot('user')
      const next = await persist(current => {
        const id = external.project.headCommitId, commit = current.project.commits[id]
        if (!commit || !current.snapshots[id]) throw new Error('The other canvas version is no longer available.')
        return { ...current, project: { ...current.project, headCommitId: id, activeBranchId: commit.branchId } }
      })
      if (editor.restorationVersion !== version || JSON.stringify(editor.snapshot().document) !== localDocument) {
        throw new Error('The canvas changed while loading the other version. Your current edits are preserved; load it again when ready.')
      }
      applyExternalWorkspace(next)
    } catch (error) { setImportError(error instanceof Error ? error.message : 'Unable to load the other canvas version.') }
  }, [commitCanvasSnapshot, persist, applyExternalWorkspace, cancelImports])

  useEffect(() => {
    const synchronize = async (revision?: WorkspaceRevision) => {
      const current = workspaceRef.current
      if (!current || revision && !workspaceSync.isNewer(current, revision) && cursorRef.current.id === current.project.headCommitId) return
      const next = await workspaceRepository.load(projectId).catch(error => { setImportError(String(error)); return null })
      const latest = workspaceRef.current
      if (!next || !latest || (next.revision ?? 0) <= (latest.revision ?? 0) && cursorRef.current.id === next.project.headCommitId) return
      if (next.project.archivedAt) {
        cancelImports()
        if (flushTimerRef.current !== null) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null }
        pendingDocumentRef.current = false
        workspaceRef.current = next; setWorkspace(next)
        try { await retainLocalEditsOnArchive() }
        catch (error) { setImportError(`This canvas was archived elsewhere. Keep this view open: its latest edits could not be saved. ${String(error)}`) }
        return
      }
      if (next.project.headCommitId === latest.project.headCommitId && cursorRef.current.id === next.project.headCommitId) {
        workspaceRef.current = next; setWorkspace(next)
        return
      }
      const editor = editorRef.current
      const saved = latest.snapshots[cursorRef.current.id ?? latest.project.headCommitId] as { document?: unknown } | undefined
      const dirty = editor && JSON.stringify(editor.snapshot().document) !== JSON.stringify(saved?.document)
      if (leavingRef.current || historyOpenRef.current || hasAnyRun() && !hostedTaskRef.current || dirty || imports.isPending() || cursorRef.current.id !== latest.project.headCommitId && !hostedTaskRef.current) setExternalWorkspace(next)
      else applyExternalWorkspace(next)
    }
    const unsubscribe = workspaceSync.subscribe(synchronize)
    void synchronize()
    // Chrome can cache a closed panel while its invalidations are suspended.
    const wake = () => { if (document.visibilityState === 'visible') void synchronize() }
    document.addEventListener('visibilitychange', wake)
    document.addEventListener('resume', wake)
    return () => {
      unsubscribe(); workspaceSync.close()
      document.removeEventListener('visibilitychange', wake)
      document.removeEventListener('resume', wake)
    }
  }, [applyExternalWorkspace, workspaceSync, imports.isPending, retainLocalEditsOnArchive])
  const placeDroppedReference = useCallback(async (reference: ImageReference, screenPoint?: { x: number; y: number }) => {
    const editor = editorRef.current
    if (!editor || !workspaceRef.current || leavingRef.current || workspaceRef.current.project.archivedAt) return
    return imports.start(reference, screenPoint ? editor.point(screenPoint) : editor.viewport.center)
  }, [imports.start])
  const editSelection = (edit: () => void) => {
    try { edit(); void commitCanvasSnapshot('user').catch(error => setImportError(String(error))) }
    catch (error) { setImportError(error instanceof Error ? error.message : 'Unable to edit this selection.') }
  }

  const openSelectedPage = async (elementId: string) => {
    const element = editorRef.current?.elements.find(element => element.id === elementId)
    const html = element && htmlDocument(element)?.html
    if (html === undefined) throw new Error('This webpage is no longer on the canvas.')
    // Open with the gesture, then flush the editor. The preview reads one
    // immutable snapshot, so reload works without a second HTML store.
    const preview = window.open('about:blank', '_blank')
    if (!preview) throw new Error('Allow Galta to open a new tab, then open the page again.')
    preview.opener = null
    const position = cursorRef.current
    try {
      await commitCanvasSnapshot('user')
      const commitId = position.id, snapshot = commitId && workspaceRef.current?.snapshots[commitId]
      const saved = snapshot ? validateSnapshot(snapshot).document.elements.find(element => element.id === elementId && !element.isDeleted) : undefined
      if (!saved || htmlDocument(saved)?.html !== html) throw new Error('The webpage changed while saving. Open it again to preview the current version.')
      if (preview.closed) throw new Error('The preview tab was closed before the page finished saving.')
      const url = new URL('../page/index.html', location.href)
      url.search = new URLSearchParams({ project: projectId, version: commitId!, element: elementId }).toString()
      preview.location.replace(url.href)
    } catch (error) { preview.close(); throw error }
  }

  const persistCanvasView = useCallback(() => {
    const editor = editorRef.current, position = cursorRef.current
    if (!editor || !position.id || document.visibilityState === 'hidden') return Promise.resolve()
    const state = editor.api.getAppState()
    const view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value }
    const write = persistQueueRef.current.then(async () => {
      const canvasView = { commitId: position.cameraCommitId ?? position.id!, ...view }
      if (await workspaceRepository.saveView(projectId, canvasView)) {
        const current = workspaceRef.current
        if (current?.project.headCommitId === canvasView.commitId) workspaceRef.current = { ...current, canvasView }
      }
    })
    persistQueueRef.current = write.then(() => undefined, () => undefined)
    return write
  }, [projectId])

  const scheduleCanvasCommit = useCallback((documentChanged = true) => {
    pendingDocumentRef.current ||= documentChanged
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current)
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null
      const documentChanged = pendingDocumentRef.current
      pendingDocumentRef.current = false
      void (documentChanged ? commitCanvasSnapshot('user') : persistCanvasView()).catch((error: unknown) => {
        pendingDocumentRef.current ||= documentChanged
        setImportError(error instanceof Error ? error.message : 'Unable to save your canvas.')
      })
    }, 650)
  }, [commitCanvasSnapshot, persistCanvasView])

  const viewportChanged = useCallback(() => scheduleCanvasCommit(false), [scheduleCanvasCommit])
  const { ready: viewReady, present: presentViewport } = useCanvasViewport(scene, shellRef, draftReady, viewportChanged, setImportError)

  const handleMount = useCallback(async (editor: CanvasScene) => {
    const current = workspaceRef.current
    if (!current) return
    const snapshot = current.snapshots[current.project.headCommitId]
    try {
      if (snapshot) {
        await editor.restoreCooperatively(current.canvasView?.commitId === current.project.headCommitId ? { ...validateSnapshot(snapshot), view: current.canvasView } : snapshot, new CanvasWork(new AbortController().signal))
      }
      else if (current.project.commits[current.project.headCommitId]?.parentId !== null) throw new Error('This version is missing its snapshot. Your workspace has been preserved.')
      else {
        const id = current.project.headCommitId, initial = editor.snapshot()
        void persist(current => initializeWorkspaceSnapshot(current, id, initial)).catch(error => setLoadError(String(error)))
      }
    } catch (error) {
      if (!editor.disposed) setLoadError(error instanceof Error ? error.message : 'Unable to restore the canvas.')
      return
    }
    if (editor.disposed) return
    editorRef.current = editor
    setScene(editor)
    editor.observe(editor.api.getSceneElementsIncludingDeleted(), editor.files)
    setShapeCount(editor.elements.length)
    const initialState = editor.api.getAppState()
    let camera = `${initialState.scrollX}:${initialState.scrollY}:${initialState.zoom.value}`
    const cleanup = editor.api.onChange((elements, appState, files) => {
      if (leavingRef.current || workspaceRef.current?.project.archivedAt) return
      setShapeCount(editor.elements.length)
      const nextCamera = `${appState.scrollX}:${appState.scrollY}:${appState.zoom.value}`
      const moved = camera !== nextCamera
      camera = nextCamera
      const changed = editor.observe(elements, files)
      if (changed || moved) scheduleCanvasCommit(changed)
    })
    const flush = () => { void commitCanvasSnapshot('user').catch(error => setImportError(String(error))) }
    const flushWhenHidden = () => {
      // Side panels can be frozen before pagehide; flush the current scene at
      // the first lifecycle signal while the document still has an event loop.
      if (document.visibilityState === 'hidden') flush()
    }
    const onPageHide = flush
    document.addEventListener('visibilitychange', flushWhenHidden)
    document.addEventListener('freeze', flushWhenHidden)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      cancelImports()
      cleanup()
      document.removeEventListener('visibilitychange', flushWhenHidden)
      document.removeEventListener('freeze', flushWhenHidden)
      window.removeEventListener('pagehide', onPageHide)
      if (flushTimerRef.current !== null) { window.clearTimeout(flushTimerRef.current); flushTimerRef.current = null }
      pendingDocumentRef.current = false
      if (editorRef.current === editor) editorRef.current = null
    }
  }, [persist, scheduleCanvasCommit, commitCanvasSnapshot, cancelImports])

  const openHistory = async () => {
    if (hasAnyRun() || imports.isPending()) throw new Error('Finish the current canvas change before opening Time Machine.')
    hostedTaskRef.current = null
    historyOpenRef.current = true
    try {
      // The editor's change signal owns dirtiness. A read-only history visit
      // drains outstanding work without cloning unchanged artwork again.
      await persistQueueRef.current
      if (pendingDocumentRef.current) await commitCanvasSnapshot('user')
      else if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current); flushTimerRef.current = null
        await persistCanvasView()
      }
      return cursorRef.current.id!
    } catch (error) { historyOpenRef.current = false; throw error }
  }
  /** `camera` is Time Machine's: the canvas opens on what the user was looking at. */
  const restoreHistory = async (id: string, expectedHead: string, camera?: StageCamera) => {
    const editor = editorRef.current!
    if (hasAnyRun() || imports.isPending()) throw new Error('Finish the current canvas change before restoring.')
    const snapshot = validateSnapshot(workspaceRef.current!.snapshots[id])
    const version = editor.restorationVersion, original = JSON.stringify(editor.snapshot().document)
    const view = camera ?? editor.view
    const sessionId = makeId('session'), label = 'Exploration ' + ((workspaceRef.current!.agentSessions?.length ?? 0) + 1)
    const nextRuntime = { ...runtimeContext, sessionId, sessionLabel: label }
    await copyDraftTo(sessionId)
    const next = await persist(current => {
      if (editor.restorationVersion !== version || JSON.stringify(editor.snapshot().document) !== original) throw new Error('The canvas changed while Time Machine was open. Close Time Machine and try again.')
      const next = restoreVersion(current, asCommitId(id), asCommitId(expectedHead), view)
      const checkpoint = checkpointAt(current, id, runtimeContext.sessionId)
      const previous = current.agentSessions?.find(item => item.id === runtimeContext.sessionId)
      const session: CreativeSession = { id: sessionId, label, turns: checkpoint && previous ? previous.turns.slice(0, previous.turns.findIndex(turn => turn.turnId === checkpoint.turnId) + 1) : [],
        ...(checkpoint ? { forkFrom: { threadId: checkpoint.threadId, lastTurnId: checkpoint.turnId } } : {}) }
      return { ...next, agentSessions: [...(current.agentSessions ?? []), session], runtimeDefaults: nextRuntime }
    }, next => {
      editor.restore({ ...snapshot, view })
      cursorRef.current = { id: next.project.headCommitId }
      setHistoryCursor(next.project.headCommitId)
      setShapeCount(editor.elements.length)
      setRuntimeContext(nextRuntime); setLiveTurn(null); setAgentState('idle'); setAgentMessage('')
    })
    setExternalWorkspace(null)
    return next
  }
  /** Take back what a moment shows, as one undoable change: the objects the
   * user chose, or else everything the canvas no longer shows, each as it was
   * and as itself. The rest of the canvas is untouched. It opens on Time
   * Machine's camera, moving only if what returned is out of view. */
  const bringBackFromHistory = async (id: string, expectedHead: string, objects?: readonly string[], camera?: StageCamera) => {
    const editor = editorRef.current!
    const snapshot = validateSnapshot(workspaceRef.current!.snapshots[id])
    const original = JSON.stringify(editor.snapshot().document), version = editor.restorationVersion
    const taken = takeBack(snapshot.document, editor.document, objects ?? missingObjects(snapshot.document, editor.document).map(element => element.id))
    if (!taken.ids.length) throw new Error(objects ? 'Your canvas already shows these objects as they were.' : 'Your canvas already shows everything this moment has.')
    const ids = new Set(taken.ids)
    // What returned moved its labels and arrows with it, through the engine's
    // own relationship update, on a draft of the canvas.
    const draft = taken.elements.filter(element => !element.isDeleted).map(cloneCanvasElement)
    refreshRelationships(draft, ids)
    const prepared = editor.prepare(draft, { ...editor.assets, ...taken.files })
    await persist(current => {
      if (hasAnyRun() || current.project.headCommitId !== expectedHead || editor.restorationVersion !== version || JSON.stringify(editor.snapshot().document) !== original) throw new Error('The current canvas changed. Close Time Machine and load the latest work before bringing anything back.')
      return commitWorkspaceSnapshot(current, asCommitId(expectedHead), prepared, 'user')
    }, next => {
      editor.applyPrepared(prepared, true, { selectedElementIds: Object.fromEntries([...ids].map(id => [id, true])), ...(camera ? { scrollX: camera.scrollX, scrollY: camera.scrollY, zoom: { value: camera.zoom as AppState['zoom']['value'] } } : {}) })
      cursorRef.current = { id: next.project.headCommitId }; setHistoryCursor(next.project.headCommitId)
      setShapeCount(editor.elements.length)
      // They return where they were; show them if that is out of view.
      const returned = editor.elements.filter(element => ids.has(element.id)), view = editor.viewport
      if (!returned.some(element => element.x < view.x + view.width && element.x + element.width > view.x && element.y < view.y + view.height && element.y + element.height > view.y)) {
        editor.api.scrollToContent(returned, { animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches })
      }
    })
  }
  const historyLiveView = () => {
    const editor = editorRef.current
    if (!editor || editor.disposed) return undefined
    const state = editor.api.getAppState()
    return { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value, offsetLeft: state.offsetLeft, offsetTop: state.offsetTop, width: state.width, height: state.height }
  }
  /** Remove versions for good; the write releases what no version uses. A
   * newer head from another window does not matter: it is never cut, and a
   * window standing on a cut version saves from where its work continues. */
  const cutHistory = async (ids: readonly string[]) => {
    await persist(current => trimHistory(current, ids))
  }

  const isPreview = Boolean(workspace && historyCursor && historyCursor !== workspace.project.headCommitId)

  // Stable connection, current browser policy. A re-render never changes the
  // registered surface or the execution's captured context.
  const connectionHostRef = useRef<CanvasConnectionHost>(null!)
  connectionHostRef.current = {
    async begin(lease, signal) {
      const editor = editorRef.current, current = workspaceRef.current
      if (!editor || !current || current.project.id !== lease.projectId || executionRef.current || leavingRef.current || current.project.archivedAt) throw new Error('This canvas is unavailable')
      if (lease.mode !== 'external') throw new Error('Embedded tasks execute in the background task host.')
      // The lifecycle lock prevents archiving between a run's validation and
      // its final durable write. The native registry still owns agent exclusion.
      await new Promise<void>((resolve, reject) => {
        void navigator.locks.request(`galta-execution:${projectId}`, { mode: 'shared', signal }, async () => {
          try {
            const stored = await workspaceRepository.load(projectId)
            if (!stored || stored.project.archivedAt || leavingRef.current) throw new Error('This canvas is no longer available for an agent.')
            await new Promise<void>(release => { releaseExecutionRef.current = { id: lease.id, release }; resolve() })
          } catch (error) { reject(error) }
        }).catch(reject)
      })
      if (hasAnyRun() || imports.isPending() || historyOpenRef.current || externalWorkspace || cursorRef.current.id !== current.project.headCommitId) throw new Error('Finish the current canvas change before connecting an agent')
      const abort = new AbortController(), frozen = captureSubmittedContext(editor)
      const execution: CanvasExecutionState = { lease, abort }
      executionRef.current = execution
      activeRunRef.current = { runId: lease.id, stop: async () => {
        abort.abort(new Error('Stopped'))
        await canvasConnectionRef.current?.connection.release()
      } }
      setSubmitted(frozen); setExternalAgent(lease.client); setAgentState('preparing'); setAgentMessage('')
      execution.browser = new SourceBrowser()
      await execution.browser.open(await sourceTab(), lease.id)
      await commitCanvasSnapshot('user')
      signal.throwIfAborted(); abort.signal.throwIfAborted()
      if (executionRef.current !== execution) throw new Error('Canvas execution ended')
      const runtime: RuntimeContext = { providerId: 'mcp', sessionId: lease.id, sessionLabel: lease.client, modelId: '', effort: '' }
      execution.tool = new CanvasTool(editor, canvasConnectionRef.current!.connection.artifacts(), async mutation => {
        await saveAgentMutation(mutation, runtime)
        setShapeCount(editor.elements.length)
      }, frozen, slots => { if (executionRef.current === execution) setExternalSlots(slots) })
      setAgentState('streaming')
    },
    async call(tool, args, signal) {
      const execution = executionRef.current
      if (execution && BROWSER_TOOL_NAMES.includes(tool)) {
        if (!execution.browser) throw new Error('The source webpage is unavailable')
        return execution.browser.execute(tool, args, AbortSignal.any([signal, execution.abort.signal]))
      }
      if (!execution?.tool) throw new Error('Canvas execution is not ready')
      return execution.tool.execute(tool, args, {
        executionId: execution.lease.id, cwd: execution.lease.cwd,
        signal: AbortSignal.any([signal, execution.abort.signal]),
        provenance: execution.provenance ?? { providerId: 'mcp', sessionId: execution.lease.id }
      })
    },
    async end(id) {
      const execution = executionRef.current
      if (releaseExecutionRef.current?.id === id) {
        releaseExecutionRef.current.release(); releaseExecutionRef.current = null
      }
      if (execution?.lease.id !== id) return
      executionRef.current = null
      setExternalSlots([])
      execution.browser?.close()
      execution.abort.abort(new Error('Canvas execution ended'))
      if (execution.lease.mode === 'external') {
        if (activeRunRef.current?.runId === id) activeRunRef.current = null
        setSubmitted(null); setExternalAgent(null); setAgentState('completed'); setAgentMessage('')
      }
    },
    disconnected(message) { setAgentMessage(message) }
  }

  useEffect(() => {
    if (!scene || !workspace?.project.id || !globalThis.chrome?.runtime?.id) return
    const projectId = workspace.project.id
    let disposed = false
    const connection = new CanvasAgentConnection({
      begin: (...args) => connectionHostRef.current.begin(...args),
      call: (...args) => connectionHostRef.current.call(...args),
      end: (...args) => connectionHostRef.current.end(...args),
      disconnected: message => {
        if (!disposed) setCanvasLinkProblem(message)
        connectionHostRef.current.disconnected(message)
      }
    })
    const current = { connection, ready: Promise.resolve(), register: () => {} }
    // The canvas registers with the canvas bridge under one ID for as long as
    // it is open. A registration lost before Galta for Mac was connected, or to
    // a host that exited, is renewed when the canvas is shown again or Settings
    // checks the connection; agents were given that same ID.
    current.register = () => {
      if (disposed || connection.isOpen) return
      setCanvasLinkProblem(null)
      const ready = connection.open(projectId, workspaceRef.current?.project.title ?? workspace.project.title)
      current.ready = ready
      void ready.catch(error => setAgentMessage(String(error)))
    }
    canvasConnectionRef.current = current
    current.register()
    const shown = () => { if (document.visibilityState === 'visible') current.register() }
    window.addEventListener('focus', shown)
    document.addEventListener('visibilitychange', shown)
    return () => {
      disposed = true
      window.removeEventListener('focus', shown)
      document.removeEventListener('visibilitychange', shown)
      if (canvasConnectionRef.current === current) canvasConnectionRef.current = null
      connection.close()
    }
  }, [scene, workspace?.project.id])

  useEffect(() => {
    const binding = canvasConnectionRef.current
    if (!binding || !workspace) return
    void binding.ready.then(() => binding.connection.rename(projectId, workspace.project.title)).catch(error => setAgentMessage(String(error)))
  }, [workspace?.project.title, scene, projectId])

  useEffect(() => {
    if (!scene || !workspace || workspace.project.archivedAt) return
    let active = true
    const head = workspace.project.headCommitId, raw = workspace.snapshots[head]
    if (!raw) return
    let request: ReturnType<typeof canvasPreviews.acquire> | undefined
    const timer = window.setTimeout(() => {
      request = canvasPreviews.acquire(previewIdentity(projectId, head, raw), raw, 240, 2)
      void request.promise.then(async canvas => {
        if (!active) return
        if (canvas) { await workspaceRepository.preview(projectId, head, canvas.toDataURL('image/webp', .75)); announceCatalog() }
        // Only the current version's preview is ever read again; earlier ones
        // are disposable and released, even when the current canvas is empty.
        await workspaceRepository.prunePreviews(projectId, head)
      }).catch((error: unknown) => { if (active) console.warn('Canvas preview unavailable', { projectId, head, error: String(error) }) })
    }, 500)
    return () => { active = false; clearTimeout(timer); request?.release() }
  }, [scene, workspace?.project.headCommitId, workspace?.snapshots[workspace.project.headCommitId], workspace?.project.archivedAt, projectId])

  sessionRef.current = {
    export: () => exportCurrentWorkspace(),
    activity: () => executionRef.current?.lease.mode === 'external' ? 'external' : activeRunRef.current && !hostedTaskRef.current ? 'agent' : imports.isPending() ? 'import' : null,
    stop: async () => {
      if (executionRef.current?.lease.mode === 'external') throw new Error('End the external agent connection before switching.')
      if (activeRunRef.current) await activeRunRef.current.stop()
      cancelImports()
    },
    prepare: async () => {
      const current = workspaceRef.current!, editor = editorRef.current
      if (!editor || !draftReady) throw new Error('The canvas is still opening.')
      if (hasAnyRun() && !hostedTaskRef.current || imports.isPending()) throw new Error('Finish the current canvas change before switching.')
      if (historyOpenRef.current) throw new Error('Close Time Machine before switching canvases.')
      if (current.project.archivedAt) {
        leavingRef.current = true
        await retainLocalEditsOnArchive()
        await flushDraft()
        return workspaceRef.current!
      }
      const state = editor.api.getAppState()
      if (state.editingTextElement || state.newElement) throw new Error('Finish the current drawing or text before switching.')
      leavingRef.current = true
      try {
        const before = JSON.stringify(editor.snapshot())
        await commitCanvasSnapshot('user')
        await flushDraft()
        for (const session of unsavedSessionsRef.current.values()) await saveSession(session)
        await persistQueueRef.current
        if (before !== JSON.stringify(editor.snapshot())) throw new Error('The canvas changed while saving. Try switching again.')
        return workspaceRef.current!
      } catch (error) { leavingRef.current = false; throw error }
    },
    resume: () => { leavingRef.current = false }
  }

  const receiveViewRef = useRef(async (_view: CanvasView) => {})
  receiveViewRef.current = async view => {
    if (!scene || !draftReady) throw new Error('The canvas is still opening.')
    // The reusable tab may have been used independently since the last visit.
    // Its save boundary protects edits and refuses to interrupt a live task.
    await sessionRef.current!.prepare()
    try {
      const latest = await workspaceRepository.load(projectId)
      if (!latest || latest.project.archivedAt) throw new Error('This canvas is no longer available.')
      applyExternalWorkspace(latest)
      await reloadDraft()
      const selection = view.selection.filter(id => scene.elements.some(element => element.id === id))
      await new Promise<void>(resolve => {
        let framed = false
        const frame = () => {
          if (framed || scene.selectedIds.length !== selection.length || selection.some(id => !scene.selectedIds.includes(id))) return
          framed = true; unsubscribe()
          const finish = () => { presentViewport(view.viewport); resolve() }
          if (document.visibilityState === 'hidden') finish()
          else requestAnimationFrame(finish)
        }
        const unsubscribe = scene.api.onChange(frame)
        scene.select(selection); frame()
      })
      await persistCanvasView()
    } finally { sessionRef.current?.resume() }
  }
  useEffect(() => {
    if (!scene || !draftReady || !viewReady) return
    return receivePresentation(projectId, view => receiveViewRef.current(view), setImportError)
  }, [projectId, scene, draftReady, viewReady])

  const saveSession = useCallback(async (session: CreativeSession, cwd?: string) => {
    const captured = structuredClone(session)
    const pending = unsavedSessionsRef.current.get(captured.id)
    const turns = new Map(pending?.turns.map(turn => [turn.id, turn]))
    for (const turn of captured.turns) turns.set(turn.id, turn)
    captured.turns = [...turns.values()]
    try {
      await persist(current => {
        const sessions = current.agentSessions ?? [], existing = sessions.find(item => item.id === captured.id)
        const merged = mergeSession(existing, captured)
        return { ...current,
          ...(cwd ? { codexProject: { ...current.codexProject, cwd } } : {}),
          agentSessions: existing ? sessions.map(item => item.id === captured.id ? merged : item) : [...sessions, merged]
        }
      })
      unsavedSessionsRef.current.delete(captured.id)
    } catch (error) { unsavedSessionsRef.current.set(captured.id, captured); throw error }
  }, [persist])

  useEffect(() => {
    if (codexStatus !== 'connected' || hasAnyRun() || !taskReady) return
    const session = workspaceRef.current?.agentSessions?.find(item => item.id === runtimeContext.sessionId)
    if (!session?.threadId) return
    let cancelled = false
    void codexRuntime.readThread(session.threadId).then(async raw => {
      if (cancelled || hasAnyRun()) return
      const thread = raw as { name?: string; cwd?: string }
      const name = thread.name
      if (name && name !== session.label && (session.publishedName === session.label || !session.publishedName && !session.labelSource && !['Moodboard', 'New conversation'].includes(name))) {
        await persist(w => ({ ...w, agentSessions: (w.agentSessions ?? []).map(s => s.id === session.id && s.label === session.label && s.labelSource === session.labelSource && s.publishedName === session.publishedName ? { ...s, label: name, labelSource: 'user', publishedName: name } : s) }))
      }
      await saveSession(reconcileCodexSession(session, thread), workspaceRef.current?.codexProject ? undefined : thread.cwd)
    }).catch(error => { if (!cancelled) setAgentMessage(error instanceof Error ? error.message : 'Unable to restore Codex conversation') })
    return () => { cancelled = true }
  }, [codexStatus, runtimeContext.sessionId, codexRuntime, saveSession, persist, taskReady])

  const newSession = useCallback(async () => {
    hostedTaskRef.current = null
    activeRunRef.current = null
    const active = workspaceRef.current?.agentSessions?.find(s => s.id === runtimeContext.sessionId)
    const activeTask = [...taskStatesRef.current.values()].find(task => task.runtime.sessionId === runtimeContext.sessionId && task.active)
    if (!activeTask && !active?.turns.length && !active?.threadId && active?.labelSource !== 'user' && !readDraft().command.trim()) {
      setConversationOpen(false); setComposerFocusRequest(value => value + 1); return
    }
    const session: CreativeSession = { id: makeId('session'), label: 'New conversation', turns: [] }
    const nextRuntime = { ...runtimeContext, sessionId: session.id, sessionLabel: session.label, providerId: 'codex-app-server' }
    await persist(current => {
      const sessions = [...(current.agentSessions ?? [])]
      if (!sessions.some(s => s.id === runtimeContext.sessionId)) sessions.push({ id: runtimeContext.sessionId, label: runtimeContext.sessionLabel, turns: [] })
      return { ...current, agentSessions: [...sessions, session], runtimeDefaults: nextRuntime }
    })
    setRuntimeContext(nextRuntime)
    setLiveTurn(null)
    setAgentState('idle')
    setAgentMessage('')
    setSubmitted(null)
    setQuestion(null)
    setContextPressure(null)
    setConversationOpen(false)
    setComposerFocusRequest(value => value + 1)
  }, [persist, runtimeContext, readDraft])

  const renameConversation = useCallback(async (label: string) => {
    await persist(w => {
      const sessions = w.agentSessions ?? []
      const current = sessions.some(s => s.id === runtimeContext.sessionId) ? w : { ...w, agentSessions: [...sessions, { id: runtimeContext.sessionId, label: 'New conversation', turns: [] }] }
      return renameSession(current, runtimeContext.sessionId, label)
    })
  }, [persist, runtimeContext.sessionId])

  const runAgent = useCallback(async () => {
    const editor = editorRef.current, current = workspaceRef.current, client = taskClientRef.current
    const submittedCommand = readDraft().command
    const instruction = submittedCommand.trim()
    if (!current || !editor || !instruction || !draftReady || !taskReady || leavingRef.current || current.project.archivedAt) return
    const activeTask = [...taskStatesRef.current.values()].find(task => task.runtime.sessionId === runtimeContext.sessionId && task.active)
    if (activeTask) {
      if (!client) { setAgentMessage('The background task host is unavailable.'); return }
      const steerId = makeId('steer')
      setAgentMessage('')
      await client.command({ method: 'steer', projectId, taskId: activeTask.id, message: { id: steerId, instruction } })
        .then(response => { applyTaskResponse(response); if (readDraft().command === submittedCommand) command.set('') })
        // A refused follow-up leaves the draft intact: the user's words are the
        // only copy of what they asked for, and the turn may still accept it.
        .catch(error => setAgentMessage(error instanceof Error ? error.message : String(error)))
      return
    }
    if (activeRunRef.current) return
    if (codexStatus !== 'connected') { setSettingsView('chat'); return }
    if (!client) { setAgentMessage('The background task host is unavailable.'); return }
    const id = makeId('task')
    let cancelled = false, dispatched = false
    const attempt = { runId: id, stop: async () => {
      cancelled = true
      if (dispatched) await client.command({ method: 'stop', projectId, taskId: id })
    } }
    activeRunRef.current = attempt
    setAgentState('preparing'); setAgentMessage('')
    try {
      const frozen = captureSubmittedContext(editor)
      const page = source.page
      setSubmitted(frozen)
      const entryCursor = cursorRef.current.id ?? current.project.headCommitId
      const wasPreview = entryCursor !== current.project.headCommitId
      await commitCanvasSnapshot('user')
      for (const session of unsavedSessionsRef.current.values()) await saveSession(session)
      if (cancelled) return
      let runtime = runtimeContext
      if (wasPreview) {
        const saved = workspaceRef.current!, checkpoint = checkpointAt(saved, entryCursor, runtime.sessionId)
        const previous = saved.agentSessions?.find(session => session.id === runtime.sessionId)
        const session: CreativeSession = { id: makeId('session'), label: runtime.sessionLabel + ' · branch',
          turns: checkpoint && previous ? previous.turns.slice(0, previous.turns.findIndex(turn => turn.turnId === checkpoint.turnId) + 1) : [],
          ...(checkpoint ? { forkFrom: { threadId: checkpoint.threadId, lastTurnId: checkpoint.turnId } } : {}) }
        runtime = { ...runtime, sessionId: session.id, sessionLabel: session.label }
        await persist(current => ({ ...current, agentSessions: [...(current.agentSessions ?? []), session], runtimeDefaults: runtime }))
        setRuntimeContext(runtime)
      }
      if (cancelled) return
      dispatched = true
      const state = await client.command({ method: 'start', input: {
        id, projectId, commitId: workspaceRef.current!.project.headCommitId, instruction,
        runtime, submitted: frozen, page
      } })
      applyTaskResponse(state)
      // Submission is asynchronous; retain any text typed after this request.
      if (readDraft().command === submittedCommand) command.set('')
      if (cancelled) await client.command({ method: 'stop', projectId, taskId: id })
    } catch (error) {
      setAgentMessage(error instanceof Error ? error.message : 'Unable to start the task')
      setAgentState('failed')
    } finally {
      if (activeRunRef.current === attempt) { activeRunRef.current = null; setSubmitted(null) }
      if (cancelled && !dispatched) setAgentState('stopped')
    }
  }, [codexStatus, command, readDraft, draftReady, taskReady, source.page, runtimeContext, commitCanvasSnapshot, persist, saveSession, projectId, applyTaskResponse])

  const stopAgent = useCallback(async () => {
    try {
      const hosted = hostedTaskRef.current?.id === activeRunRef.current?.runId
      await activeRunRef.current?.stop()
      if (!hosted) { setAgentState('stopped'); setAgentMessage('Stopped') }
    } catch (error) {
      setAgentState('failed')
      setAgentMessage(error instanceof Error ? error.message : 'Unable to stop the Codex turn')
    }
  }, [])

  const handleDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (historyOpenRef.current || leavingRef.current || workspaceRef.current?.project.archivedAt) { event.preventDefault(); event.stopPropagation(); return }
    const files = Array.from(event.dataTransfer.files).filter(file => file.type.startsWith('image/') || videoFile(file.name, file.type))
    if (files.length) {
      event.preventDefault(); event.stopPropagation()
      const point = { x: event.clientX, y: event.clientY }
      for (const file of files) void placeDroppedReference({ url: '', file }, point)
      return
    }
    const reference = readImageDrop(event.dataTransfer)
    if (!reference) return // Excalidraw handles native file and clipboard imports.
    event.preventDefault()
    event.stopPropagation()
    void placeDroppedReference(reference, { x: event.clientX, y: event.clientY })
  }, [placeDroppedReference])

  const updateRuntime = useCallback((field: keyof RuntimeContext, value: string) => {
    if (field !== 'sessionId' && activeRunRef.current) return
    hostedTaskRef.current = null
    const nextRuntime = {
      ...runtimeContext,
      [field]: value,
      ...(field === 'sessionId' ? { sessionLabel: workspaceRef.current?.agentSessions?.find(session => session.id === value)?.label ?? value } : {})
    }
    if (field === 'modelId') {
      const available = codexModels.find(model => model.id === value)?.supportedReasoningEfforts?.map(option => option.reasoningEffort)
      if (available?.length && !available.includes(nextRuntime.effort.toLowerCase())) nextRuntime.effort = available[0]!.charAt(0).toUpperCase() + available[0]!.slice(1)
    }
    setRuntimeContext(nextRuntime)
    if (field === 'sessionId') {
      const selected = [...taskStatesRef.current.values()].find(task => task.runtime.sessionId === value && task.active)
      hostedTaskRef.current = selected ?? null
      const stop = selected ? taskStopsRef.current.get(selected.id) : undefined
      activeRunRef.current = selected && stop ? { runId: selected.id, stop } : null
      setLiveTurn(selected?.conversation ?? null)
      setSubmitted(null)
      setContextPressure(selected?.pressure ?? null)
      setAgentState(selected ? selected.conversation.status as AgentRunState : 'idle')
      setAgentMessage(selected?.error ?? '')
      setQuestion(selected?.question ? { ...selected.question, answer: answer => {
        void taskClientRef.current?.command({ method: 'answer', projectId, taskId: selected.id, questionId: selected.question!.id, value: answer }).then(applyTaskResponse).catch(error => setAgentMessage(String(error)))
      } } : null)
    }
    const current = workspaceRef.current
    if (current) void persist(current => ({ ...current, runtimeDefaults: nextRuntime })).catch(error => setImportError(String(error)))
  }, [persist, runtimeContext, codexModels])

  const selectedCodexModel = codexModels.find((model) => model.id === runtimeContext.modelId)
  const effortOptions = selectedCodexModel?.supportedReasoningEfforts?.map((item) => item.reasoningEffort).filter(Boolean) ?? ['low', 'medium', 'high']

  const exportCurrentWorkspace = useCallback(async () => {
    await commitCanvasSnapshot('user')
    const current = workspaceRef.current
    if (!current) return
    const blob = await portableMedia({ kind: 'workspace', workspace: current })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${current.project.title.replace(/\s+/g, '-').toLowerCase() || 'galta-workspace'}.galta`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [commitCanvasSnapshot])

  const downloadArtifact = useCallback(async (uri: string, receipt?: ArtifactRead) => {
    const binding = canvasConnectionRef.current
    const picker = (window as Window & { showSaveFilePicker?: (options?: unknown) => Promise<{ createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }> }> }).showSaveFilePicker
    if (!binding) throw new Error('The canvas connection is unavailable.')
    await binding.ready
    const suggestedName = (() => {
      try { return decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1)) || 'galta-artifact' }
      catch { return 'galta-artifact' }
    })()
    const read = async (consume: (bytes: Uint8Array) => Promise<void>) => {
      let offset = 0, version: string | undefined, total = 0, mimeType = ''
      do {
        const chunk = await binding.connection.readArtifact(uri, offset, version, receipt)
        if (chunk.offset !== offset || !Number.isSafeInteger(chunk.total) || chunk.total < 0 || chunk.total > 128 * 1024 * 1024 ||
          typeof chunk.version !== 'string' || !chunk.version || version && chunk.version !== version ||
          total && chunk.total !== total || mimeType && chunk.mimeType !== mimeType ||
          typeof chunk.mimeType !== 'string' || !chunk.mimeType.includes('/') || typeof chunk.dataBase64 !== 'string' ||
          chunk.dataBase64.length > 512_000 || !Number.isSafeInteger(chunk.nextOffset) || chunk.nextOffset < offset || chunk.nextOffset > chunk.total) throw new Error('The artifact transfer was invalid.')
        const bytes = Uint8Array.from(atob(chunk.dataBase64), character => character.charCodeAt(0))
        if (chunk.total > 0 && !bytes.length || chunk.nextOffset !== offset + bytes.length || chunk.total === 0 && (offset !== 0 || chunk.nextOffset !== 0)) throw new Error('The artifact transfer was incomplete.')
        await consume(bytes)
        offset = chunk.nextOffset; version = chunk.version; total = chunk.total; mimeType = chunk.mimeType
      } while (offset < total)
      return { mimeType }
    }
    if (!picker) {
      const chunks: Uint8Array[] = []
      try {
        const { mimeType } = await read(async bytes => { chunks.push(bytes) })
        const url = URL.createObjectURL(new Blob(chunks, { type: mimeType }))
        const anchor = document.createElement('a')
        anchor.href = url; anchor.download = suggestedName; anchor.click(); URL.revokeObjectURL(url)
        return
      } catch (error) {
        setImportError(error instanceof Error ? error.message : String(error))
        throw error
      }
    }
    let handle: Awaited<ReturnType<typeof picker>>
    try { handle = await picker({ suggestedName }) }
    catch (error) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return
      throw error
    }
    type Writable = { write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }
    let writable: Writable | undefined
    try {
      const target = await handle.createWritable()
      writable = target
      await read(bytes => target.write(bytes))
      await target.close()
    } catch (error) {
      if (writable?.abort) await writable.abort().catch(() => undefined)
      setImportError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [])

  const exportMigrationBackup = async () => {
    const backup = await workspaceRepository.loadMigrationBackup(projectId)
    if (!backup) { setImportError('No migration backup is available.'); return }
    const url = URL.createObjectURL(await portableMedia({ kind: 'workspace', workspace: backup }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'galta-before-excalidraw.galta'; anchor.click(); URL.revokeObjectURL(url)
  }

  if (loadError) return <main className="galta-error"><div className="max-w-md space-y-4 p-8"><p>{loadError}</p><Button variant="secondary" onClick={async () => {
    const original = await workspaceRepository.load(projectId)
    if (!original) return
    const url = URL.createObjectURL(await portableMedia({ kind: 'workspace', workspace: original }))
    const a = document.createElement('a'); a.href = url; a.download = 'galta-original-backup.galta'; a.click(); URL.revokeObjectURL(url)
  }}>Download original workspace</Button></div></main>
  if (!workspace) return <main className="galta-loading">Opening Galta…</main>

  return (
    <TooltipProvider><main ref={shellRef} data-build={__GALTA_BUILD__.source} data-project-id={projectId} className={`galta-shell${isPreview ? ' is-history-preview' : ''}`}>
      <CollectionPanel disabled={!scene || navigation.pending || presenting} onUse={async item => {
        const failed = imports.jobs.find(job => job.error && !job.replacement && job.reference.url === item.mediaUrl)
        const result = failed ? await imports.retry(failed) : await placeDroppedReference({ url: item.mediaUrl, sourceUrl: item.sourceUrl ?? item.pageUrl })
        if (!result?.ok) throw new Error(result?.error ?? 'The canvas is unavailable.')
      }} canvasContext={
        <CanvasChromeSurface className="galta-document pointer-events-auto flex w-fit min-w-0 max-w-full items-center gap-1" role="group" aria-label="Current canvas" inert={presenting}><WorkspaceMenu title={workspace.project.title} projectId={projectId} navigation={navigation}
          hasMigrationBackup={hasMigrationBackup} onExportBackup={() => void exportMigrationBackup().catch(error => setImportError(String(error)))} />
          <HistoryBrowser workspace={workspace} currentId={historyCursor ?? workspace.project.headCommitId} title={workspace.project.title}
            disabled={!scene || hasAnyRun() || imports.isPending() || Boolean(workspace.project.archivedAt)} onOpen={openHistory}
            onClose={() => { historyOpenRef.current = false }}
            onResume={() => canvasRef.current?.querySelector<HTMLElement>('.excalidraw')?.focus({ preventScroll: true })}
            onRestore={async (id, head, camera) => { await restoreHistory(id, head, camera) }}
            onBringBack={bringBackFromHistory} onCut={cutHistory} onError={setImportError}
            onName={async (id, label) => { await persist(current => nameVersion(current, id, label)) }}
            liveView={historyLiveView} files={assets => {
              const editor = editorRef.current
              if (!editor || editor.disposed) throw new Error('The canvas has closed.')
              return editor.editorFiles(assets)
            }} />
        </CanvasChromeSurface>}
        viewControls={<>
          {scene && <CanvasViewControls scene={scene} />}
          <CanvasFocus onPending={setPresenting} projectId={projectId} onError={setImportError} onNotice={setCanvasNotice} prepare={() => sessionRef.current!.prepare()} resume={() => sessionRef.current?.resume()}
          disabled={!scene || !draftReady || !viewReady || navigation.pending || Boolean(workspace.project.archivedAt)}
          unavailable={externalAgent ? 'Available when the external agent disconnects' : imports.isPending() ? 'Available when the import finishes' : isPreview ? 'Return to the current canvas first' : undefined} capture={() => {
          const editor = editorRef.current
          if (!editor || externalWorkspace || cursorRef.current.id !== workspaceRef.current?.project.headCommitId) throw new Error('Load the newer canvas changes before switching views.')
          return { selection: editor.selectedIds, viewport: editor.captureViewport(canvasFrame(shellRef.current!)) }
          }} />
        </>}>

      <section ref={canvasRef} className="galta-canvas" inert={navigation.pending || presenting} aria-label={`Galta canvas, ${shapeCount} objects`} onDragOver={(event) => event.preventDefault()} onDropCapture={handleDrop}>
        {/* Temporary navigation blocks input without toggling Excalidraw's
            view mode, which deselects objects on both entry and exit. */}
        <ExcalidrawCanvas onMount={handleMount} readOnly={!scene || Boolean(workspace.project.archivedAt)} />
        {locator && <AgentMark locator={locator} />}
        {locator && !isPreview && <CanvasSlots locator={locator} slots={[
          ...externalSlots.map(slot => ({ ...slot, key: `external:${slot.id}` })),
          ...[...taskStates.values()].filter(task => task.active && task.projectId === projectId).flatMap(task => (task.slots ?? []).map(slot => ({ ...slot, key: `${task.id}:${slot.id}` })))
        ]} />}
        {scene && !workspace.project.archivedAt && <SelectionActions scene={scene} onEdit={editSelection} onError={setImportError} onReplace={async (file, target) => {
          const old = scene.elements.find(el => el.id === target.id)
          if (!old) throw new Error('The media to replace no longer exists.')
          await imports.start({ url: '', file }, { x: old.x + old.width / 2, y: old.y + old.height / 2 }, target)
        }} onOpenPage={openSelectedPage} />}
        {scene && <ImportFeedback scene={scene} imports={imports} />}
        {scene && <AgentInvitation scene={scene} available={!workspace.project.archivedAt && imports.jobs.length === 0 && !isPreview} started={shapeCount > 0 || imports.jobs.length > 0 || codexStatus === 'connected' || Boolean(externalAgent)} onConnect={() => setSettingsView('settings')} />}
        {shapeCount === 0 && imports.jobs.length === 0 && codexStatus === 'connected' && <p className="pointer-events-none absolute inset-0 grid place-content-center text-sm text-muted-foreground">Drag images or videos here, or ask Galta.</p>}
      </section>

      {scene && !workspace.project.archivedAt && <DrawingTools scene={scene} onImport={async files => {
        for (const file of files) {
          await placeDroppedReference({ url: '', file })
        }
      }} />}
      <SettingsCorner account={account} inert={presenting} onOpen={() => { settingsFromCorner.current = true; setSettingsView('settings') }} />
      {(!scene || workspace.project.archivedAt) && <div className="absolute inset-0 z-(--layer-conversation) grid place-content-center bg-background/80 px-8 text-center" role="status">
        <p className="text-sm text-muted-foreground">{workspace.project.archivedAt ? 'This canvas is archived. Restore it from the canvas menu.' : 'Opening canvas…'}</p>
      </div>}
      {externalWorkspace && <div className="workspace-sync-notice glass-surface" role="status">
        <span>Another Galta window has newer canvas changes.</span>
        <Button variant="secondary" size="sm" disabled={Boolean(hasAnyRun() && !hostedTaskRef.current)} onClick={() => void loadExternalWorkspace(externalWorkspace)}>Load changes</Button>
        <Button variant="ghost" size="icon" onClick={() => setExternalWorkspace(null)} aria-label="Dismiss workspace update">×</Button>
      </div>}
      {canvasNotice && <div className="canvas-notice glass-surface canvas-notice-status" role="status">{canvasNotice}</div>}
      {importError && <div className="canvas-notice glass-surface" role="alert">{importError}<Button variant="ghost" size="icon" onClick={() => setImportError(null)} aria-label="Dismiss notice">×</Button></div>}
      <SettingsDialog account={account} canvasId={canvasConnectionRef.current?.connection.id} canvasProblem={canvasLinkProblem} onCheckCanvas={() => canvasConnectionRef.current?.register()} externalConnected={Boolean(externalAgent)} view={settingsView}
        onViewChange={target => {
          setSettingsView(target)
          if (target) return
          if (settingsFromCorner.current) requestAnimationFrame(() => shellRef.current?.querySelector<HTMLElement>('.settings-corner-button')?.focus())
          else setComposerFocusRequest(value => value + 1)
          settingsFromCorner.current = false
        }}
        status={codexStatus} plan={codexPlan} error={codexError} onConnect={connectCodex} onSignIn={signInCodex} />
      <ConversationDock
        connection={codexStatus === 'connected' ? undefined : { label: codexStatus === 'connecting' ? 'Connecting…' : codexStatus === 'sign-in-required' ? 'Sign in with ChatGPT' : codexStatus === 'error' ? 'Reconnect agent' : 'Connect an agent', onSetup: () => setSettingsView(codexStatus === 'disconnected' ? 'settings' : 'chat') }}
        external={Boolean(externalAgent)}
        title={externalAgent ?? sessionLabel(workspace, runtimeContext.sessionId)}
        activity={externalAgent ? `${externalAgent} is working` : undefined}
        sessionId={runtimeContext.sessionId} focusRequest={composerFocusRequest}
        activeSessionCount={new Set([...taskStates.values()].filter(task => task.active).map(task => task.runtime.sessionId)).size}
        disabled={!scene || !draftReady || navigation.pending || presenting || Boolean(workspace.project.archivedAt)} submitReady={taskReady}
        turns={externalAgent ? [] : workspace.agentSessions?.find(session => session.id === runtimeContext.sessionId)?.turns ?? []}
        conversation={conversation} state={agentState} error={agentMessage} question={question} pressure={externalAgent ? null : contextPressure}
        task={[...taskStates.values()].find(task => task.active && task.runtime.sessionId === runtimeContext.sessionId)}
        command={command} onSubmit={runAgent} onStop={stopAgent}
        open={conversationOpen} onOpen={open => { setRuntimeMenuOpen(null); setConversationOpen(open) }} preview={isPreview}
        actions={<SessionMenu open={runtimeMenuOpen === 'Conversation'} onOpen={open => setRuntimeMenuOpen(open ? 'Conversation' : null)} runtime={runtimeContext}
          sessions={workspace.agentSessions ?? []} activeSessionIds={new Set([...taskStates.values()].filter(task => task.active).map(task => task.runtime.sessionId))} busy={!draftReady && !hasHostedTask() && agentState !== 'preparing' && agentState !== 'streaming'}
          drafts={drafts}
          currentLabel={sessionLabel(workspace, runtimeContext.sessionId)} onRename={renameConversation}
          onSelect={id => updateRuntime('sessionId', id)} onNew={() => void newSession().then(() => setRuntimeMenuOpen(null)).catch(error => setImportError(String(error)))} />}
        runtime={<RuntimeMenu open={runtimeMenuOpen === 'Model'} onOpen={openRuntimeMenu} runtime={runtimeContext}
          models={codexModels} efforts={effortOptions}
          status={codexStatus} plan={codexPlan} usage={codexUsage} error={codexError}
          refreshing={connection.status === 'connected' && connection.refreshing}
          busy={agentState === 'preparing' || agentState === 'streaming'} onChange={updateRuntime}
          onConnect={() => { setRuntimeMenuOpen(null); setSettingsView('chat') }} />}
        context={scene && <ComposerContext scene={scene} submitted={submitted} receipt={liveContext} />}
        onArtifactDownload={downloadArtifact}
        locator={locator}
      />
      </CollectionPanel>
    </main></TooltipProvider>
  )
}
