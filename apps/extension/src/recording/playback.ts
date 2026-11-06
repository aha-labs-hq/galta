import type { RecordingResult } from './CanvasRecording'

/** Chromium's recorded WebM omits duration metadata. Add it to a derived
 * playback Blob, leaving the original recording and recognition input intact. */
export async function recordingPlayback(recording: RecordingResult): Promise<Blob> {
  if (!recording.media.type.startsWith('video/webm')) return recording.media
  const { fixWebmDuration } = await import('@fix-webm-duration/fix')
  return fixWebmDuration(recording.media, recording.packet.duration * 1000, { logger: false })
}
