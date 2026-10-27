import { themeColor } from '../design/theme'
import type { HistoryStageHandle } from './HistoryStage'

/** Formats a recording can take, best first. The file's extension follows the
 * one the browser accepts. */
const FORMATS = [['video/mp4;codecs=avc1.640028', 'mp4'], ['video/mp4', 'mp4'], ['video/webm;codecs=vp9', 'webm'], ['video/webm', 'webm']] as const

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted()
  const abort = () => { clearTimeout(timer); reject(signal.reason) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
  signal.addEventListener('abort', abort, { once: true })
})

/**
 * Record a range of moments as a video of the canvas changing: what the stage
 * shows, under the camera the user chose, at an even step, with the first and
 * last moments held. Frames are composed from the stage every animation frame,
 * so its transitions are in the video too.
 */
export async function recordHistory({ stage, moments, show, step, signal }: {
  stage: () => HistoryStageHandle | null; moments: readonly string[]; show: (id: string) => void; step: number; signal: AbortSignal
}): Promise<{ blob: Blob; extension: string }> {
  const format = FORMATS.find(([type]) => MediaRecorder.isTypeSupported(type))
  if (!format) throw new Error('This browser can’t record video.')
  if (!stage()) throw new Error('Time Machine is closed.')
  show(moments[0]!)
  await pause(step, signal)
  const size = stage()?.size()
  if (!size) throw new Error('Time Machine is closed.')
  if (!size.width || !size.height) throw new Error('The stage isn’t visible.')
  // Video encoders need even dimensions.
  const canvas = document.createElement('canvas'), even = (n: number) => n - n % 2
  canvas.width = even(size.width); canvas.height = even(size.height)
  const context = canvas.getContext('2d')!, background = themeColor('background')
  let frame = 0, stream: MediaStream | undefined, recorder: MediaRecorder | undefined
  const failure = new AbortController(), recording = AbortSignal.any([signal, failure.signal])
  const paint = () => {
    try {
      context.fillStyle = background; context.fillRect(0, 0, canvas.width, canvas.height)
      stage()?.paint(context)
      frame = requestAnimationFrame(paint)
    } catch (error) { failure.abort(error) }
  }
  const chunks: Blob[] = []
  // Whatever fails, the painting, the stream and the recorder all stop.
  try {
    paint()
    stream = canvas.captureStream(30)
    recorder = new MediaRecorder(stream, { mimeType: format[0], videoBitsPerSecond: 12_000_000 })
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
    recorder.onerror = event => failure.abort((event as Event & { error?: DOMException }).error ?? new Error('Unable to record this video.'))
    const stopped = new Promise<void>(resolve => { recorder!.onstop = () => resolve() })
    recorder.start(250)
    try {
      await pause(step * 3, recording)
      for (const id of moments.slice(1)) { show(id); await pause(step, recording) }
      await pause(step * 5, recording)
    } finally { if (recorder.state !== 'inactive') recorder.stop(); await stopped }
  } finally {
    cancelAnimationFrame(frame); for (const track of stream?.getTracks() ?? []) track.stop()
    canvas.width = canvas.height = 0
  }
  return { blob: new Blob(chunks, { type: format[0].replace(/;.*/, '') }), extension: format[1] }
}
