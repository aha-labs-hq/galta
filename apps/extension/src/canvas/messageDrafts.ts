import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DraftCommand } from './conversationStore'

export type MessageDraft = { command: string }
const empty = (): MessageDraft => ({ command: '' })
type StoredDraft = { projectId: string; sessionId: string; command: string }
// Version 1 also stored retained reference images and journaled their removal
// in localStorage. Drafts are text only now; the upgrade drops both.
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
      const opening = indexedDB.open('galta-message-drafts', 2)
      opening.onupgradeneeded = event => {
        const db = opening.result
        if (event.oldVersion < 1) db.createObjectStore('messages', { keyPath: ['projectId', 'sessionId'] }).createIndex('projectId', 'projectId')
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
    const messages = await request(db.transaction('messages').objectStore('messages').index('projectId').getAll(projectId)) as StoredDraft[]
    return Object.fromEntries(messages.map(item => [item.sessionId, { command: item.command }]))
  }
  save(projectId: string, sessionId: string, draft: MessageDraft) {
    const next = { projectId, sessionId, command: draft.command } satisfies StoredDraft
    const key = JSON.stringify([projectId, sessionId])
    // A previous failed transaction is reported to the caller. It must not
    // poison future explicit edits, and is never retried in the background.
    this.queue = this.queue.catch(() => undefined).then(async () => {
      let tx: IDBTransaction | undefined
      let done: Promise<void> | undefined
      try {
        const db = await this.open()
        tx = db.transaction('messages', 'readwrite')
        done = completed(tx)
        tx.objectStore('messages').put(next)
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
  /** A deleted canvas takes every conversation's draft with it. */
  remove(projectId: string) {
    this.queue = this.queue.catch(() => undefined).then(async () => {
      const db = await this.open(), tx = db.transaction('messages', 'readwrite'), done = completed(tx)
      tx.objectStore('messages').delete(IDBKeyRange.bound([projectId], [projectId, []]))
      await done
      for (const [key, failure] of this.failures) if (failure.projectId === projectId) this.failures.delete(key)
    })
    return this.queue
  }
}
const repository = new MessageDraftRepository()
export const deleteCanvasDrafts = (projectId: string) => repository.remove(projectId)

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
  const update = useCallback((change: (draft: MessageDraft) => MessageDraft) => {
    if (!projectId || loadedProject !== projectId) return
    const previous = current.current[sessionId] ?? empty()
    const next = change(previous)
    current.current = { ...current.current, [sessionId]: next }
    // Typing belongs to the composer subscription, not the workspace render.
    notify()
    void repository.save(projectId, sessionId, next).catch(error => onError(`Your message draft was not saved. ${String(error)}`))
  }, [projectId, sessionId, loadedProject, onError])
  const read = useCallback(() => current.current[sessionId] ?? empty(), [sessionId])
  const command = useMemo<DraftCommand>(() => ({
    getSnapshot: () => read().command,
    subscribe: listener => { listeners.current.add(listener); return () => { listeners.current.delete(listener) } },
    set: value => update(draft => ({ ...draft, command: value }))
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
  return { reload, read, command, drafts: current.current, ready, copyTo, flush: () => repository.flush(projectId!) }
}
