import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { CodexMetadata, type CodexRpcClient } from '@galta/runtime'
import type { WorkspaceBundle } from '@galta/storage'
import { applyGeneratedNames } from './conversationMetadata'
import { announceCatalog } from './canvasLibrary'

type Persist = (change: (current: WorkspaceBundle) => WorkspaceBundle) => Promise<WorkspaceBundle>
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
// Only a new local intent earns another publication attempt. A receipt for an
// earlier successful step must not reset a later step's failure/retry fence.
const publicationIdentity = (workspace: WorkspaceBundle | null) => JSON.stringify([workspace?.project.title, workspace?.project.titleSource, workspace?.codexProject?.cwd, workspace?.agentSessions?.map(s => [s.id, s.threadId, s.label, s.labelSource])])
// Chromium's extension error page flattens console arguments with String().
// Keep the diagnostic complete there as well as in the developer console.
const reportFailure = (label: string, context: { projectId?: string | undefined; sessionId?: string | undefined; operation?: string | undefined }, error: unknown) => console.warn(`${label}: ${JSON.stringify({ ...context, error: message(error) })}`)

// This deadline bounds lock acquisition only. Once granted, the operation's
// own transport deadlines and connection lifetime govern its work.
const lockSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(5_000)])

/** Metadata has its own lifecycle: it never delays or fails a creative turn. */
export function useConversationMetadata(workspace: WorkspaceBundle | null, current: MutableRefObject<WorkspaceBundle | null>, persist: Persist, rpc: CodexRpcClient, connected: boolean, busy: boolean, model: string) {
  const metadata = useMemo(() => new CodexMetadata(rpc), [rpc])
  const connection = useRef(0)
  const [published, setPublished] = useState(0), [named, setNamed] = useState(0)
  const [publicationRetry, setPublicationRetry] = useState(0), [namingRetry, setNamingRetry] = useState(0), [recoveryRetry, setRecoveryRetry] = useState(0)
  const syncing = useRef(false), naming = useRef(false)
  const failedPublication = useRef(''), lastPublication = useRef('')
  // Connection-local observation only; Codex remains the archive authority.
  const archivedThreads = useRef(new Set<string>())
  const failedNaming = useRef('')
  const failedRecovery = useRef('')
  const automaticRetryKeys = useRef(new Set<string>())
  const retryTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const lifetime = useRef<AbortController | null>(null)
  const idle = useRef(false)
  idle.current = connected && !busy

  // Metadata is ancillary. Give a transient transport failure one bounded
  // background retry, then leave the creative surface alone. A later reconnect
  // produces a new retry key and gets another bounded opportunity.
  const scheduleAutomaticRetry = (key: string, run: () => Promise<boolean> | boolean) => {
    if (automaticRetryKeys.current.has(key)) return
    automaticRetryKeys.current.add(key)
    const timer = globalThis.setTimeout(() => {
      retryTimers.current.delete(timer)
      const signal = lifetime.current?.signal
      if (!signal || signal.aborted) return
      void Promise.resolve(run()).catch(error => {
        if (!signal.aborted) reportFailure('Galta metadata retry failed', { operation: key.split(':')[0], projectId: current.current?.project.id }, error)
      })
    }, 1_500)
    retryTimers.current.add(timer)
  }
  const scheduleNamingRetry = (sessionId: string) => scheduleAutomaticRetry(`naming:${sessionId}`, async () => {
    await persist(current => ({ ...current, agentSessions: (current.agentSessions ?? []).map(item => {
      if (item.id !== sessionId || item.naming !== 'failed') return item
      const { naming: _, ...rest } = item
      return rest
    }) }))
    setNamingRetry(value => value + 1)
    return true
  })
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller
    connection.current += 1
    archivedThreads.current.clear()
    automaticRetryKeys.current.clear()
    return () => {
      controller.abort(); lifetime.current = null
      for (const timer of retryTimers.current) clearTimeout(timer)
      retryTimers.current.clear()
    }
  }, [connected])
  const identity = publicationIdentity(workspace)

  useEffect(() => {
    if (!connected || busy || syncing.current || !current.current?.codexProject || current.current.project.archivedAt) return
    const epoch = connection.current, key = JSON.stringify([identity, epoch, publicationRetry])
    const w = current.current, binding = w.codexProject!
    const unpublished = !binding.id || binding.publishedTitle !== w.project.title || w.agentSessions?.some(s => s.threadId && !archivedThreads.current.has(s.threadId) && (s.publishedProjectId !== binding.id || s.publishedName !== s.label))
    if ((lastPublication.current === key && !unpublished) || failedPublication.current === key) return
    let attemptedKey = key
    let sessionId: string | undefined
    const signal = lifetime.current!.signal, projectId = current.current.project.id
    syncing.current = true
    void navigator.locks.request(`galta-metadata:${projectId}`, { signal: lockSignal(signal) }, async () => {
      // Refresh inside the cross-window lock. Acknowledgements describe the
      // exact value published, never an edit that arrived later.
      const before = await persist(w => w), binding = before.codexProject
      signal.throwIfAborted()
      if (!binding || before.project.archivedAt || !idle.current) return
      attemptedKey = JSON.stringify([publicationIdentity(before), epoch, publicationRetry])
      const remote = await metadata.project(projectId, binding.cwd, binding.id)
      signal.throwIfAborted()
      const remoteRename = binding.publishedTitle === before.project.title && remote.name !== binding.publishedTitle
      const title = remoteRename ? remote.name : before.project.title
      if (remote.name !== title || remote.roots.length !== 1 || remote.roots[0]?.path !== binding.cwd) await metadata.updateProject(remote.id, title, binding.cwd)
      signal.throwIfAborted()
      const saved = await persist(w => w.codexProject?.cwd !== binding.cwd || w.project.archivedAt
        || !remoteRename && w.codexProject.id === remote.id && w.codexProject.publishedTitle === title ? w : {
        ...w, project: remoteRename && w.project.title === before.project.title && w.project.titleSource === before.project.titleSource && w.codexProject.publishedTitle === binding.publishedTitle ? { ...w.project, title, titleSource: 'user' } : w.project,
        codexProject: { ...w.codexProject, id: remote.id, publishedTitle: title }
      })
      if (remoteRename) announceCatalog()
      attemptedKey = JSON.stringify([publicationIdentity(saved), epoch, publicationRetry])
      if (saved.agentSessions?.some(s => s.threadId && (s.publishedProjectId !== remote.id || s.publishedName !== s.label))) {
        archivedThreads.current = await metadata.archivedThreads(binding.cwd, signal)
      }
      for (const session of saved.agentSessions ?? []) {
        signal.throwIfAborted()
        if (!session.threadId || archivedThreads.current.has(session.threadId) || current.current?.project.archivedAt) continue
        sessionId = session.id
        if (session.publishedProjectId !== remote.id) {
          await metadata.assignThread(session.threadId, remote.id)
          await persist(w => ({ ...w, agentSessions: (w.agentSessions ?? []).map(s => s.id === session.id && s.threadId === session.threadId ? { ...s, publishedProjectId: remote.id } : s) }))
        }
        signal.throwIfAborted()
        if (session.publishedName !== session.label) {
          await metadata.nameThread(session.threadId, session.label)
          await persist(w => ({ ...w, agentSessions: (w.agentSessions ?? []).map(s => s.id === session.id && s.threadId === session.threadId ? { ...s, publishedName: session.label } : s) }))
        }
      }
      lastPublication.current = key
      failedPublication.current = ''
    }).catch(error => {
      if (!signal.aborted) {
        failedPublication.current = attemptedKey
        reportFailure('Galta metadata publication deferred', { projectId, sessionId }, error)
        scheduleAutomaticRetry(`sync:${identity}`, () => { setPublicationRetry(value => value + 1); return true })
      }
    }).finally(() => { syncing.current = false; if (lifetime.current && !lifetime.current.signal.aborted) setPublished(value => value + 1) })
  }, [connected, busy, identity, publicationRetry, published, metadata, persist])

  useEffect(() => rpc.subscribe(notification => {
    if (notification.method === 'thread/archived' || notification.method === 'thread/unarchived' || notification.method === 'thread/started') {
      const thread = notification.params?.thread
      const threadId = notification.params?.threadId ?? (thread && typeof thread === 'object' && 'id' in thread ? thread.id : undefined)
      if (typeof threadId !== 'string' || !current.current?.agentSessions?.some(s => s.threadId === threadId)) return
      if (notification.method === 'thread/archived') archivedThreads.current.add(threadId)
      else if (archivedThreads.current.delete(threadId)) {
        lastPublication.current = ''
        setPublished(value => value + 1)
      }
      return
    }
    if (notification.method !== 'thread/name/updated') return
    const { threadId, threadName } = notification.params ?? {}
    if (typeof threadId !== 'string' || typeof threadName !== 'string' || !threadName.trim()) return
    if (!current.current?.agentSessions?.some(s => s.threadId === threadId)) return
    void persist(w => {
      const session = w.agentSessions?.find(s => s.threadId === threadId)
      if (!session || session.publishedName !== session.label || session.label === threadName || w.project.archivedAt) return w
      return { ...w, agentSessions: w.agentSessions!.map(s => s.id === session.id ? { ...s, label: threadName, labelSource: 'user', publishedName: threadName } : s) }
    })
      .catch(error => reportFailure('Galta remote name notification could not be saved', { projectId: current.current?.project.id }, error))
  }), [rpc, persist])

  const candidates = JSON.stringify(workspace?.agentSessions?.map(s => [s.id, s.threadId, s.labelSource, s.naming, s.turns.some(t => t.status === 'completed')]))
  useEffect(() => {
    if (!connected || busy || naming.current || !current.current?.codexProject || current.current.project.archivedAt) return
    const w = current.current
    const session = w.agentSessions?.find(s => s.threadId && s.labelSource === 'request' && (!s.naming || s.naming === 'failed') && s.turns.some(t => t.status === 'completed'))
    if (!session) return
    const attemptKey = JSON.stringify([session.id, connection.current, namingRetry])
    if (failedNaming.current === attemptKey) return
    const signal = lifetime.current!.signal
    naming.current = true
    void navigator.locks.request(`galta-naming:${w.project.id}`, { signal: lockSignal(signal) }, async () => {
      let claimed = false
      await persist(w => {
        signal.throwIfAborted()
        const candidate = w.agentSessions?.find(s => s.id === session.id)
        if (!candidate || (candidate.naming && candidate.naming !== 'failed') || candidate.labelSource !== 'request' || w.project.archivedAt || !idle.current) return w
        claimed = true
        return { ...w, agentSessions: w.agentSessions!.map(s => s.id === session.id ? { ...s, naming: 'attempted' } : s) }
      })
      if (!claimed) return
      const turn = session.turns.find(t => t.status === 'completed')!
      try {
        const names = await metadata.generate({
          instruction: session.turns[0]!.instruction,
          reply: turn.items.filter(item => item.type === 'agentMessage').map(item => item.text).join('\n'),
          canvasTitle: w.project.title, nameCanvas: !w.project.titleSource && w.project.title === 'Untitled canvas',
          cwd: w.codexProject!.cwd, model
        }, signal)
        signal.throwIfAborted()
        await persist(current => applyGeneratedNames(current, session.id, session.label, w.project.title, names))
        announceCatalog()
      } catch (error) {
        if (signal.aborted) return
        failedNaming.current = attemptKey
        reportFailure('Galta automatic naming deferred', { projectId: w.project.id, sessionId: session.id }, error)
        await persist(w => ({ ...w, agentSessions: (w.agentSessions ?? []).map(s => s.id === session.id ? { ...s, naming: 'failed' } : s) }))
        scheduleNamingRetry(session.id)
      }
    }).catch(error => {
      if (!signal.aborted) {
        failedNaming.current = attemptKey
        reportFailure('Galta automatic naming deferred', { projectId: w.project.id, sessionId: session.id }, error)
        scheduleNamingRetry(session.id)
      }
    })
      .finally(() => { naming.current = false; if (lifetime.current && !lifetime.current.signal.aborted) setNamed(value => value + 1) })
  }, [connected, busy, candidates, named, namingRetry, model, metadata, persist])

  const attempted = workspace?.agentSessions?.some(s => s.naming === 'attempted')
  const projectId = workspace?.project.id
  useEffect(() => {
    if (!connected || !attempted || !projectId || naming.current) return
    const key = JSON.stringify([projectId, connection.current, recoveryRetry])
    if (failedRecovery.current === key) return
    const controller = new AbortController(), { signal } = controller
    // The lock outlives an active attempt in any window. Once it is free,
    // an unacknowledged attempt becomes eligible for the next background pass.
    void navigator.locks.request(`galta-naming:${projectId}`, { signal: lockSignal(signal) }, async () => {
      await persist(w => {
        signal.throwIfAborted()
        if (!w.agentSessions?.some(s => s.naming === 'attempted')) return w
        return { ...w, agentSessions: w.agentSessions.map(s => s.naming === 'attempted' ? { ...s, naming: 'failed' } : s) }
      })
      failedRecovery.current = ''
    }).catch(error => {
      if (signal.aborted) return
      failedRecovery.current = key
      reportFailure('Galta interrupted naming recovery deferred', { projectId }, error)
      scheduleAutomaticRetry(`recovery:${projectId}`, () => { setRecoveryRetry(value => value + 1); return true })
    })
    return () => controller.abort()
  }, [connected, attempted, projectId, recoveryRetry, named, persist])

  // There is intentionally no UI error return. Names are a projection of the
  // local workspace, so a provider hiccup must never become a user task. The
  // bounded retries above and structured console diagnostics are the recovery
  // boundary for this ancillary work.
}
