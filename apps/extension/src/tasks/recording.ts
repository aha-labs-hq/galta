import { prepareRecordingEvidence, validateRecordingEvidence } from '@galta/capture'
import { readSubmittedRecording, saveSubmittedTranscript } from '../canvas/messageDrafts'
import { renderRecordingEvidence } from '../recording/evidence'
import { transcribeRecording } from '../recording/speech'
import type { TaskSubmission } from './protocol'

/** Called only by an accepted Send. Keep audio processing and evidence rendering
 * in the task host; the view observes progress and can stop the same task. */
export async function prepareSubmittedRecording(input: TaskSubmission, signal: AbortSignal) {
  if (!input.recording) return undefined
  signal.throwIfAborted()
  const original = await readSubmittedRecording(input.projectId, input.id)
  signal.throwIfAborted()
  if (!original || original.packet.id !== input.recording.id || original.packet.projectId !== input.projectId || original.packet.duration !== input.recording.duration)
    throw new Error('The original recording is unavailable on this device.')
  let packet = original.packet
  if (packet.microphone && (packet.transcript.status !== 'available' || !packet.transcript.audio)) {
    const transcript = await transcribeRecording(packet, original.media, signal)
    signal.throwIfAborted()
    await saveSubmittedTranscript(input.projectId, input.id, packet.id, transcript)
    packet = { ...packet, transcript }
  }
  signal.throwIfAborted()
  const evidence = await prepareRecordingEvidence(packet, async (...args) => {
    signal.throwIfAborted()
    return renderRecordingEvidence(...args)
  })
  signal.throwIfAborted()
  await validateRecordingEvidence(evidence, input.projectId)
  signal.throwIfAborted()
  return evidence
}
