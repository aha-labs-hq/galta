import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { CanvasScene } from '../canvas/scene'
import { CanvasRecording, type RecordingResult } from './CanvasRecording'

export type RecordingPhase = 'idle' | 'starting' | 'recording' | 'finishing' | 'sending'
type Callbacks = {
  read(): RecordingResult | undefined
  save(value: RecordingResult | null): Promise<void>
  onSend(recordingId: string): Promise<boolean>
  onError(message: string): void
}
type Operation = { recording?: CanvasRecording; abort: AbortController; callbacks: Callbacks; stopping?: boolean }

/** Capture retains an original. Submission is a separate, explicit operation.
 * Each operation owns its callbacks, so late work cannot write into another
 * conversation. Cancellation invalidates that owner before releasing resources. */
export function useRecording({ scene, surface, projectId, sessionId, ...callbacks }: Callbacks & {
  scene: CanvasScene | null; surface: RefObject<HTMLElement | null>; projectId: string; sessionId: string
}) {
  const [phase, setPhase] = useState<RecordingPhase>('idle')
  const operation = useRef<Operation | null>(null)
  const finishRef = useRef<() => void>(() => {})
  const latest = useRef(callbacks); latest.current = callbacks
  const duration = useRef(0)
  const level = useCallback(() => operation.current?.recording?.level ?? 0, [])
  const elapsed = useCallback(() => operation.current?.recording?.elapsed ?? duration.current, [])
  const cancel = useCallback(() => {
    const current = operation.current
    operation.current = null
    current?.abort.abort(); current?.recording?.cancel()
    setPhase('idle')
  }, [])
  useLayoutEffect(() => cancel, [projectId, sessionId, cancel])
  const report = (owner: Operation, error: unknown) => {
    if (operation.current === owner && !owner.abort.signal.aborted) {
      owner.callbacks.onError(error instanceof Error ? error.message : String(error))
    }
  }
  const release = (owner: Operation) => {
    if (operation.current === owner) { operation.current = null; setPhase('idle') }
  }
  const finish = async () => {
    const owner = operation.current
    if (!owner?.recording || owner.stopping) return
    owner.stopping = true
    duration.current = owner.recording.elapsed
    setPhase('finishing')
    try {
      const result = await owner.recording.stop()
      if (operation.current !== owner) return
      duration.current = result.packet.duration
      await owner.callbacks.save(result)
    } catch (error) { report(owner, error) }
    finally { release(owner) }
  }
  finishRef.current = () => { void finish() }
  const start = async () => {
    if (!scene || !surface.current || operation.current || latest.current.read()) return
    const recording = new CanvasRecording(surface.current, scene, projectId, () => finishRef.current())
    const owner: Operation = { recording, abort: new AbortController(), callbacks: latest.current }
    operation.current = owner; duration.current = 0; setPhase('starting')
    try {
      await recording.start(true)
      if (operation.current === owner) setPhase('recording')
    } catch (error) { report(owner, error); release(owner) }
  }
  const send = async () => {
    const draft = latest.current.read()
    if (!draft || operation.current) return
    const owner: Operation = { abort: new AbortController(), callbacks: latest.current }
    operation.current = owner; setPhase('sending')
    try {
      // The task owns processing after acceptance. Snapshot the request in
      // onSend now, before another keystroke can change what was submitted.
      await owner.callbacks.onSend(draft.packet.id)
    } catch (error) { report(owner, error) }
    finally { release(owner) }
  }
  const remove = async () => {
    const current = latest.current
    cancel()
    // The draft store reports persistence failures and keeps its unsaved state.
    await current.save(null).catch(() => undefined)
  }
  return { phase, elapsed, level, start, finish, cancel, send, remove,
    active: phase === 'recording', capturing: phase === 'starting' || phase === 'recording', busy: phase !== 'idle' }
}
