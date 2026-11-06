import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DraftCommand } from './conversationStore'
import type { RecordingResult } from '../recording/CanvasRecording'

export type MessageDraft = { command: string; recording?: RecordingResult }
const empty = (): MessageDraft => ({ command: '' })
type StoredDraft = { projectId: string; sessionId: string; command: string }
// Recording blobs have their own stores so typing never rewrites media. Version
// 1's retired reference-image store and advisory journal are still removed.
const RETIRED_REMOVAL_JOURNAL = 'galta-message-draft-pending:'
function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Unable to save this message draft.')) })
}

/** Drafts are not canvas history. Serialize writes so closing/reopening cannot
 * resurrect an older draft. */
class MessageDraftRepository {
  private database: Promise<IDBDatabase> | undefined
  private queue = Promise.resolve()
  private failures = new Map<string, { projectId: string; error: unknown }>()
  async flush(projectId: string) {
    await this.queue.catch(() => undefined)
    const failure = [...this.failures.values()].find(item => item.projectId === projectId)
    if (failure) throw new Error(`A message draft is still unsaved. Return to that conversation and edit it to save before leaving. ${String(failure.error)}`)
  }
  private open() {
    return this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('galta-message-drafts', 4)
      opening.onupgradeneeded = event => {
        const db = opening.result
        if (event.oldVersion < 1) db.createObjectStore('messages', { keyPath: ['projectId', 'sessionId'] }).createIndex('projectId', 'projectId')
        if (event.oldVersion < 3) db.createObjectStore('recordings', { keyPath: ['projectId', 'sessionId'] }).createIndex('projectId', 'projectId')
        if (event.oldVersion < 4) db.createObjectStore('recording-history', { keyPath: ['projectId', 'requestId'] })
        if (db.objectStoreNames.contains('references')) db.deleteObjectStore('references')
        try {
          const storage = globalThis.localStorage
          for (const key of Object.keys(storage ?? {})) if (key.startsWith(RETIRED_REMOVAL_JOURNAL)) storage.removeItem(key)
        } catch { /* The journal was advisory; IndexedDB stays authoritative. */ }
      }
      opening.onsuccess = () => { const db = opening.result; db.onversionchange = () => { db.close(); this.database = undefined }; resolve(db) }
      opening.onerror = () => { this.database = undefined; reject(opening.error) }
    })
  }
  async load(projectId: string): Promise<Record<string, MessageDraft>> {
    await this.queue.catch(() => undefined)
    const db = await this.open()
    const tx = db.transaction(['messages', 'recordings'])
    const [messages, recordings] = await Promise.all([
      request(tx.objectStore('messages').index('projectId').getAll(projectId)) as Promise<StoredDraft[]>,
      request(tx.objectStore('recordings').index('projectId').getAll(projectId)) as Promise<{ sessionId: string; recording: RecordingResult }[]>
    ])
    const result: Record<string, MessageDraft> = Object.fromEntries(messages.map(item => [item.sessionId, { command: item.command }]))
    for (const item of recordings) result[item.sessionId] = { ...(result[item.sessionId] ?? empty()), recording: item.recording }
    return result
  }
  save(projectId: string, sessionId: string, draft: MessageDraft, recordingChanged = true) {
    const next = { projectId, sessionId, command: draft.command } satisfies StoredDraft
    const key = JSON.stringify([projectId, sessionId])
    // A previous failed transaction is reported to the caller. It must not
    // poison future explicit edits, and is never retried in the background.
    this.queue = this.queue.catch(() => undefined).then(async () => {
      let tx: IDBTransaction | undefined
      let done: Promise<void> | undefined
      try {
        const db = await this.open()
        const writeRecording = recordingChanged || this.failures.has(key)
        tx = db.transaction(writeRecording ? ['messages', 'recordings'] : ['messages'], 'readwrite')
        done = completed(tx)
        tx.objectStore('messages').put(next)
        if (writeRecording) {
          if (draft.recording) tx.objectStore('recordings').put({ projectId, sessionId, recording: draft.recording })
          else tx.objectStore('recordings').delete([projectId, sessionId])
        }
        await done
        this.failures.delete(key)
      } catch (error) {
        this.failures.set(key, { projectId, error })
        // A failed request may already have aborted the transaction.
        try { tx?.abort() } catch { /* preserve the original storage failure */ }
        await done?.catch(() => undefined)
        throw error
      }
    })
    return this.queue
  }
  async retain(projectId: string, requestId: string, recording: RecordingResult) {
    if (recording.packet.projectId !== projectId) throw new Error('The recording belongs to another canvas.')
    const db = await this.open(), tx = db.transaction('recording-history', 'readwrite'), done = completed(tx)
    tx.objectStore('recording-history').add({ projectId, requestId, recording })
    await done
  }
  async recording(projectId: string, requestId: string): Promise<RecordingResult | null> {
    const db = await this.open()
    const value = await request(db.transaction('recording-history').objectStore('recording-history').get([projectId, requestId])) as { recording: RecordingResult } | undefined
    return value?.recording ?? null
  }
  /** Enrich a retained original, never recreate one deleted with its canvas.
   * A successful transcription survives a later task failure and explicit retry. */
  async transcribed(projectId: string, requestId: string, id: string, transcript: RecordingResult['packet']['transcript']) {
    const db = await this.open(), tx = db.transaction('recording-history', 'readwrite'), done = completed(tx)
    const store = tx.objectStore('recording-history')
    const value = await request(store.get([projectId, requestId])) as { projectId: string; requestId: string; recording: RecordingResult } | undefined
    if (!value || value.recording.packet.id !== id) { tx.abort(); await done.catch(() => undefined); throw new Error('The original recording is no longer available.') }
    store.put({ ...value, recording: { ...value.recording, packet: { ...value.recording.packet, transcript } } })
    await done
  }
  /** A deleted canvas takes every conversation's draft with it. */
  remove(projectId: string) {
    this.queue = this.queue.catch(() => undefined).then(async () => {
      const db = await this.open(), tx = db.transaction(['messages', 'recordings', 'recording-history'], 'readwrite'), done = completed(tx)
      tx.objectStore('messages').delete(IDBKeyRange.bound([projectId], [projectId, []]))
      tx.objectStore('recordings').delete(IDBKeyRange.bound([projectId], [projectId, []]))
      tx.objectStore('recording-history').delete(IDBKeyRange.bound([projectId], [projectId, []]))
      await done
      for (const [key, failure] of this.failures) if (failure.projectId === projectId) this.failures.delete(key)
    })
    return this.queue
  }
}
const repository = new MessageDraftRepository()
export const deleteCanvasDrafts = (projectId: string) => repository.remove(projectId)
export const retainSubmittedRecording = (projectId: string, requestId: string, recording: RecordingResult) => repository.retain(projectId, requestId, recording)
export const readSubmittedRecording = (projectId: string, requestId: string) => repository.recording(projectId, requestId)
export const saveSubmittedTranscript = (projectId: string, requestId: string, id: string, transcript: RecordingResult['packet']['transcript']) => repository.transcribed(projectId, requestId, id, transcript)

export function useMessageDrafts(projectId: string | undefined, sessionId: string, onError: (error: string) => void) {
  const [, setRevision] = useState(0)
  const current = useRef<Record<string, MessageDraft>>({})
  const listeners = useRef(new Set<() => void>())
  const notify = () => listeners.current.forEach(listener => listener())
  const [loadedProject, setLoadedProject] = useState<string>()
  useEffect(() => {
    if (!projectId) return
    let active = true
    repository.load(projectId).then(drafts => {
      if (!active) return
      current.current = drafts; setRevision(value => value + 1); setLoadedProject(projectId); notify()
    }).catch(error => { if (active) onError(String(error)) })
    return () => { active = false }
  }, [projectId, onError])
  const ready = Boolean(projectId && loadedProject === projectId)
  const update = useCallback(async (change: (draft: MessageDraft) => MessageDraft) => {
    if (!projectId || loadedProject !== projectId) throw new Error('The message draft is still opening.')
    const previous = current.current[sessionId] ?? empty()
    const next = change(previous)
    current.current = { ...current.current, [sessionId]: next }
    if (next.recording !== previous.recording) setRevision(value => value + 1)
    // Typing belongs to the composer subscription, not the workspace render.
    notify()
    try { await repository.save(projectId, sessionId, next, next.recording !== previous.recording) }
    catch (error) { onError(`Your message draft was not saved. ${String(error)}`); throw error }
  }, [projectId, sessionId, loadedProject, onError])
  const read = useCallback(() => current.current[sessionId] ?? empty(), [sessionId])
  const command = useMemo<DraftCommand>(() => ({
    getSnapshot: () => read().command,
    subscribe: listener => { listeners.current.add(listener); return () => { listeners.current.delete(listener) } },
    set: value => { void update(draft => ({ ...draft, command: value })).catch(() => undefined) }
  }), [read, update])
  const copyTo = async (targetSessionId: string) => {
    if (!projectId || loadedProject !== projectId) throw new Error('The message draft is still opening.')
    const next = { ...(current.current[sessionId] ?? empty()) }
    await repository.save(projectId, targetSessionId, next)
    current.current = { ...current.current, [targetSessionId]: next }; setRevision(value => value + 1); notify()
  }
  const reload = async () => {
    if (!projectId) return
    const drafts = await repository.load(projectId)
    current.current = drafts; setRevision(value => value + 1); notify()
  }
  const setRecording = useCallback((recording: RecordingResult | null) => update(draft => {
    const { recording: _, ...rest } = draft
    return recording ? { ...rest, recording } : rest
  }), [update])
  const restore = useCallback((recording: RecordingResult, instruction: string) => update(draft => {
    if (draft.recording || draft.command.trim()) throw new Error('Send or clear your current draft before restoring this recording.')
    return { command: instruction, recording }
  }), [update])
  const clearSubmitted = useCallback((submitted: MessageDraft) => update(draft => {
    const next = { ...draft, command: draft.command === submitted.command ? '' : draft.command }
    if (next.recording === submitted.recording) delete next.recording
    return next
  }), [update])
  return { reload, read, command, recording: ready ? read().recording ?? null : null, setRecording, restore, clearSubmitted, drafts: current.current, ready, copyTo, flush: () => repository.flush(projectId!) }
}
